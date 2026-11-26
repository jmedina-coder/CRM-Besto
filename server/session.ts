import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextRequest, NextResponse } from "next/server";
import { SALES_USERS, type CrmUser, type SalesUserId } from "../app/model";
import { RequestError } from "./http";
import { getStore } from "./store";

const derive = promisify(scrypt);
const cookieName = "besto_crm";
const sessionLifetime = 60 * 60 * 24 * 7;
const attemptWindow = 15 * 60_000;
// Failed-login limits. The per-account limit is scoped to the client address so a
// stranger cannot lock the real user out; the per-address limit stops one address
// from guessing across accounts.
const attemptLimit = 8;
const addressLimit = 20;
const passwordVariables: Record<SalesUserId, string> = {
  jhon: "CRM_JHON_PASSWORD_HASH",
  pelos: "CRM_PELOS_PASSWORD_HASH",
  alejandra: "CRM_ALEJANDRA_PASSWORD_HASH",
};

function getUser(username: string | undefined) {
  return SALES_USERS.find((user) => user.id === username);
}

function passwordHash(userId: SalesUserId) {
  const encoded = process.env[passwordVariables[userId]];
  const match = /^scrypt:([a-f0-9]{32}):([a-f0-9]{64})$/i.exec(encoded ?? "");
  if (!match) throw new RequestError(503, "El acceso al CRM aún no está configurado.");
  return { salt: Buffer.from(match[1], "hex"), key: Buffer.from(match[2], "hex") };
}

function signingKey(userId: SalesUserId) {
  const secret = process.env.CRM_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new RequestError(503, "El acceso al CRM aún no está configurado.");
  }

  const { salt, key } = passwordHash(userId);
  return createHmac("sha256", secret).update(userId).update(salt).update(key).digest();
}

// Client address used to scope login throttling. X-Forwarded-For is attacker-controlled
// unless a trusted proxy sets it, so it is only read on Vercel (which overwrites it) or
// when CRM_TRUST_PROXY=1 is set for a proxy that appends the real address. The last entry
// is the one that proxy added. Without a trusted proxy every client shares "local".
export function clientAddress(request: NextRequest) {
  if (!process.env.VERCEL && process.env.CRM_TRUST_PROXY !== "1") return "local";
  const forwarded = request.headers.get("x-forwarded-for")?.split(",").map((part) => part.trim()).filter(Boolean).at(-1);
  return forwarded && /^[0-9a-f:.]{3,45}$/i.test(forwarded) ? forwarded.toLowerCase() : "unknown";
}

// Verifies the cookie's shape, expiry and signature. It does not check the server-side
// session record; use currentUser() for that.
function readToken(request: NextRequest) {
  const token = request.cookies.get(cookieName)?.value;
  if (!token) return null;

  const [id, expiry, nonce, signature, ...extra] = token.split(".");
  const user = getUser(id);
  const now = Math.floor(Date.now() / 1_000);
  const expires = Number(expiry);
  if (
    !user ||
    extra.length > 0 ||
    !Number.isSafeInteger(expires) ||
    expires <= now ||
    expires > now + sessionLifetime ||
    !/^[a-f0-9]{32}$/.test(nonce) ||
    !/^[a-f0-9]{64}$/.test(signature)
  ) {
    return null;
  }

  const expected = createHmac("sha256", signingKey(user.id)).update(`${id}.${expiry}.${nonce}`).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex")) ? { user, nonce } : null;
}

export async function currentUser(request: NextRequest) {
  const token = readToken(request);
  if (!token) return null;
  // A valid signature is not enough: logging out (or expiry cleanup) removes the record.
  const store = await getStore();
  return (await store.hasSession(token.nonce, token.user.id, Math.floor(Date.now() / 1_000))) ? token.user : null;
}

export async function requireSession(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) throw new RequestError(401, "Inicia sesión para continuar.");
  return user;
}

function cookieOptions(request: NextRequest, maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: Boolean(process.env.VERCEL) || request.nextUrl.protocol === "https:",
    path: "/",
    maxAge,
  };
}

export async function authenticate(username: unknown, password: unknown, address = "local"): Promise<CrmUser> {
  if (
    typeof username !== "string" ||
    typeof password !== "string" ||
    !username.trim() ||
    !password ||
    username.length > 80 ||
    password.length > 256
  ) {
    throw new RequestError(400, "Escribe tu usuario y contraseña.");
  }

  const user = getUser(username.trim().toLowerCase());
  const accountBucket = `user:${user?.id ?? "unknown"}:${address}`;
  const now = Date.now();
  const expires = now + attemptWindow;
  const store = await getStore();
  // Requests without a known address share one bucket, so a per-address cap there would
  // let anyone lock everybody out; only the per-account limit applies in that case.
  const addressKnown = address !== "local" && address !== "unknown";
  const allowed = (!addressKnown || await store.reserveLoginAttempt(`ip:${address}`, now, expires, addressLimit)) &&
    await store.reserveLoginAttempt(accountBucket, now, expires, attemptLimit);
  if (!allowed) {
    throw new RequestError(429, "Demasiados intentos. Espera hasta 15 minutos y vuelve a intentar.");
  }

  const { salt, key } = user ? passwordHash(user.id) : {
    salt: Buffer.alloc(16),
    key: Buffer.alloc(32),
  };
  const provided = (await derive(password, salt, 32)) as Buffer;
  const valid = timingSafeEqual(provided, key);
  if (!user || !valid) throw new RequestError(401, "El usuario o la contraseña son incorrectos.");

  await store.resetLoginAttempts(accountBucket);
  // Best-effort cleanup of expired sessions and throttle rows so they cannot pile up.
  if (Math.random() < 0.05) await store.purgeExpired(now).catch(() => {});
  return user;
}

export async function startSession(request: NextRequest, response: NextResponse, user: CrmUser) {
  const expires = Math.floor(Date.now() / 1_000) + sessionLifetime;
  const nonce = randomBytes(16).toString("hex");
  const payload = `${user.id}.${expires}.${nonce}`;
  const signature = createHmac("sha256", signingKey(user.id)).update(payload).digest("hex");
  await (await getStore()).createSession(nonce, user.id, expires);
  response.cookies.set(cookieName, `${payload}.${signature}`, cookieOptions(request, sessionLifetime));
}

export async function endSession(request: NextRequest, response: NextResponse) {
  // A misconfigured server cannot have issued valid sessions, so logging out still works.
  const token = (() => { try { return readToken(request); } catch { return null; } })();
  if (token) await (await getStore()).deleteSession(token.nonce);
  response.cookies.set(cookieName, "", cookieOptions(request, 0));
}
