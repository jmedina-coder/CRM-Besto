import { spawn, spawnSync } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("..", import.meta.url));

function makePassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32);
  return `scrypt:${salt.toString("hex")}:${key.toString("hex")}`;
}

async function availablePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  listener.close();
  await once(listener, "close");
  return port;
}

// Starts a disposable copy of the API on a random port. The copy lives inside the
// git-ignored .data folder so node_modules resolves by normal parent lookup; a
// symlinked node_modules breaks Next.js dev on Windows.
export async function createApp(extraEnvironment = {}) {
  await mkdir(join(project, ".data"), { recursive: true });
  const directory = await mkdtemp(join(project, ".data", "harness-"));
  const passwords = {
    jhon: randomBytes(18).toString("hex"),
    pelos: randomBytes(18).toString("hex"),
    alejandra: randomBytes(18).toString("hex"),
  };
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let child;
  let log = "";

  await mkdir(join(directory, "app"));
  await Promise.all([
    cp(join(project, "package.json"), join(directory, "package.json")),
    cp(join(project, "tsconfig.json"), join(directory, "tsconfig.json")),
    cp(join(project, "next.config.ts"), join(directory, "next.config.ts")),
    cp(join(project, "app/model.ts"), join(directory, "app/model.ts")),
    cp(join(project, "app/api"), join(directory, "app/api"), { recursive: true }),
    cp(join(project, "server"), join(directory, "server"), { recursive: true }),
  ]);

  async function request(path, { method = "GET", body, cookie, headers = {} } = {}) {
    const response = await fetch(origin + path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        ...(method !== "GET" ? { Origin: origin } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      signal: AbortSignal.timeout(60_000),
    });
    return {
      status: response.status,
      data: await response.json().catch(() => null),
      setCookie: response.headers.get("set-cookie"),
      headers: response.headers,
    };
  }

  // The client address comes from X-Forwarded-For, which the app trusts only when
  // CRM_TRUST_PROXY=1 (always true for this harness).
  function login(username, password, address) {
    return request("/api/session", {
      method: "POST",
      body: { username, password },
      headers: address ? { "X-Forwarded-For": address } : {},
    });
  }

  async function start() {
    const environment = {
      ...process.env,
      CRM_DB_PATH: join(directory, "test.sqlite"),
      CRM_JHON_PASSWORD_HASH: makePassword(passwords.jhon),
      CRM_PELOS_PASSWORD_HASH: makePassword(passwords.pelos),
      CRM_ALEJANDRA_PASSWORD_HASH: makePassword(passwords.alejandra),
      CRM_SESSION_SECRET: randomBytes(32).toString("hex"),
      CRM_TRUST_PROXY: "1",
      DATABASE_URL: "",
      POSTGRES_URL: "",
      NEXT_TELEMETRY_DISABLED: "1",
      ...extraEnvironment,
    };
    delete environment.VERCEL;
    delete environment.VERCEL_ENV;
    child = spawn(process.execPath, [
      join(project, "node_modules/next/dist/bin/next"), "dev", "--webpack",
      "--hostname", "127.0.0.1", "--port", String(port),
    ], { cwd: directory, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => { log = (log + chunk).slice(-8_000); });
    }
    for (let attempts = 0; attempts < 480; attempts++) {
      if (child.exitCode !== null) break;
      try {
        if ((await request("/api/session")).status === 200) return;
      } catch {
        // Next.js compiles the route on its first request.
      }
      await delay(250);
    }
    throw new Error(`Next.js test server did not start.\n${log}`);
  }

  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32") {
      // child.kill() would leave Next.js worker processes running on Windows.
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill();
    }
    await once(child, "exit");
  }

  async function cleanup() {
    await stop();
    await rm(directory, { force: true, recursive: true, maxRetries: 10, retryDelay: 300 });
  }

  await start();
  return { origin, passwords, request, login, start, stop, cleanup };
}
