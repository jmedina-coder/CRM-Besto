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
const attemptLimit = 8;

function getUser(username: string | undefined) {
  return SALES_USERS.find((user) => user.id === username);
}

function passwordHash(userId: SalesUserId) {
  const encoded = userId === "jhon" ? process.env.CRM_JHON_PASSWORD_HASH : process.env.CRM_PELOS_PASSWORD_HASH;
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

export function currentUser(request: NextRequest) {
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
  return timingSafeEqual(expected, Buffer.from(signature, "hex")) ? user : null;
}

export function requireSession(request: NextRequest) {
  const user = currentUser(request);
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

export async function authenticate(username: unknown, password: unknown): Promise<CrmUser> {
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
  const bucket = user?.id ?? "unknown";
  const now = Date.now();
  const store = await getStore();
  if (!(await store.reserveLoginAttempt(bucket, now, now + attemptWindow, attemptLimit))) {
    throw new RequestError(429, "Demasiados intentos. Espera hasta 15 minutos y vuelve a intentar.");
  }

  const { salt, key } = user ? passwordHash(user.id) : {
    salt: Buffer.alloc(16),
    key: Buffer.alloc(32),
  };
  const provided = (await derive(password, salt, 32)) as Buffer;
  const valid = timingSafeEqual(provided, key);
  if (!user || !valid) throw new RequestError(401, "El usuario o la contraseña son incorrectos.");

  await store.resetLoginAttempts(bucket);
  return user;
}

export function startSession(request: NextRequest, response: NextResponse, user: CrmUser) {
  const expires = Math.floor(Date.now() / 1_000) + sessionLifetime;
  const payload = `${user.id}.${expires}.${randomBytes(16).toString("hex")}`;
  const signature = createHmac("sha256", signingKey(user.id)).update(payload).digest("hex");
  response.cookies.set(cookieName, `${payload}.${signature}`, cookieOptions(request, sessionLifetime));
}

export function endSession(request: NextRequest, response: NextResponse) {
  response.cookies.set(cookieName, "", cookieOptions(request, 0));
}
