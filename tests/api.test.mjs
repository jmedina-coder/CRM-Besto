import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
  const port = listener.address().port;
  listener.close();
  await once(listener, "close");
  return port;
}

test("roles, contact history, and login limits persist across sessions and process restarts", {
  timeout: 90_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "besto-crm-test-"));
  const jhonPassword = randomBytes(18).toString("hex");
  const pelosPassword = randomBytes(18).toString("hex");
  const secret = randomBytes(32).toString("hex");
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let child;
  let log = "";

  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await once(child, "exit");
  }

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
    });
    return {
      status: response.status,
      data: await response.json(),
      setCookie: response.headers.get("set-cookie"),
    };
  }

  function login(username, password) {
    return request("/api/session", { method: "POST", body: { username, password } });
  }

  async function start() {
    const environment = {
      ...process.env,
      CRM_DB_PATH: join(directory, "test.sqlite"),
      CRM_JHON_PASSWORD_HASH: makePassword(jhonPassword),
      CRM_PELOS_PASSWORD_HASH: makePassword(pelosPassword),
      CRM_SESSION_SECRET: secret,
      DATABASE_URL: "",
      POSTGRES_URL: "",
      NEXT_TELEMETRY_DISABLED: "1",
    };
    delete environment.VERCEL;
    delete environment.VERCEL_ENV;
    child = spawn(process.execPath, [
      join(directory, "node_modules/next/dist/bin/next"), "dev", "--webpack",
      "--hostname", "127.0.0.1", "--port", String(port),
    ], { cwd: directory, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => { log = (log + chunk).slice(-8_000); });
    }

    for (let attempts = 0; attempts < 120; attempts++) {
      if (child.exitCode !== null) break;
      try {
        const result = await request("/api/session");
        if (result.status === 200) return;
      } catch {
        // Next.js compiles the route on its first request.
      }
      await delay(250);
    }
    assert.fail(`Next.js test server did not start.\n${log}`);
  }

  try {
    await mkdir(join(directory, "app"));
    await Promise.all([
      cp(join(project, "package.json"), join(directory, "package.json")),
      cp(join(project, "tsconfig.json"), join(directory, "tsconfig.json")),
      cp(join(project, "app/model.ts"), join(directory, "app/model.ts")),
      cp(join(project, "app/api"), join(directory, "app/api"), { recursive: true }),
      cp(join(project, "server"), join(directory, "server"), { recursive: true }),
      symlink(join(project, "node_modules"), join(directory, "node_modules"), "dir"),
    ]);
    await start();
    assert.equal((await request("/api/leads")).status, 401);
    assert.equal((await request("/api/session", {
      method: "POST",
      body: { username: "jhon", password: jhonPassword },
      headers: { Origin: "https://external.example" },
    })).status, 403);

    const managerLogin = await login("jhon", jhonPassword);
    const sellerLogin = await login("pelos", pelosPassword);
    assert.equal(managerLogin.data.user.role, "manager");
    assert.equal(sellerLogin.data.user.role, "seller");
    assert.match(managerLogin.setCookie, /HttpOnly/i);
    assert.match(managerLogin.setCookie, /SameSite=strict/i);
    const manager = managerLogin.setCookie.split(";")[0];
    const seller = sellerLogin.setCookie.split(";")[0];
    assert.equal((await request("/api/session", { cookie: seller })).data.user.id, "pelos");
    assert.equal((await request("/api/session", {
      cookie: seller.replace("pelos.", "jhon."),
    })).data.user, null);

    assert.equal((await request("/api/leads", {
      method: "POST", cookie: seller, body: { name: "Asignación prohibida", assignee: "jhon" },
    })).status, 403);
    const managerLead = (await request("/api/leads", {
      method: "POST", cookie: manager, body: { name: "Contacto Jhon" },
    })).data.lead;
    const draft = {
      name: "Contacto de prueba",
      company: "Negocio de prueba",
      stage: "scheduled",
      tags: ["Demo", "demo", "Visita"],
      nextFollowUp: "2026-11-26T10:00:00-05:00",
      nextAction: "Hacer demo",
    };
    const key = randomUUID();
    const create = await request("/api/leads", {
      method: "POST", cookie: seller, body: draft, headers: { "Idempotency-Key": key },
    });
    assert.equal(create.status, 201);
    const { lead } = create.data;
    assert.equal(lead.assignee, "pelos");
    assert.equal(lead.activities[0].author, "pelos");
    assert.equal(lead.nextFollowUp, "2026-11-26T15:00:00.000Z");
    assert.deepEqual(lead.tags, ["Demo", "Visita"]);
    assert.equal((await request("/api/leads", {
      method: "POST", cookie: seller, body: draft, headers: { "Idempotency-Key": key },
    })).data.lead.id, lead.id);
    assert.deepEqual((await request("/api/leads", { cookie: seller })).data.leads.map((entry) => entry.id), [lead.id]);
    assert.equal((await request("/api/leads", { cookie: manager })).data.leads.length, 2);
    assert.equal((await request(`/api/leads/${managerLead.id}`, { cookie: seller })).status, 404);
    assert.equal((await request(`/api/leads/${managerLead.id}`, { method: "DELETE", cookie: seller })).status, 404);

    const leadUrl = `/api/leads/${lead.id}`;
    const messages = await Promise.all(["Primer mensaje", "Segundo mensaje"].map((body) => request(
      `${leadUrl}/activities`, {
        method: "POST", cookie: seller, body: { kind: "whatsapp", direction: "sent", body },
      },
    )));
    assert.deepEqual(messages.map((response) => response.status), [201, 201]);
    assert.equal((await request(leadUrl, {
      method: "PATCH", cookie: manager, body: { revision: lead.revision, stage: "won" },
    })).status, 409);
    const current = (await request(leadUrl, { cookie: manager })).data.lead;
    assert.equal(current.activities.filter((entry) => entry.kind === "whatsapp").length, 2);
    const won = (await request(leadUrl, {
      method: "PATCH",
      cookie: manager,
      body: { revision: current.revision, stage: "won", amount: 450_000, assignee: "jhon" },
    })).data.lead;
    assert.equal(won.stage, "won");
    assert.ok(won.wonAt);
    assert.equal(won.activities[0].author, "jhon");
    assert.equal(won.activities[0].kind, "stage");
    assert.equal((await request(leadUrl, {
      method: "PATCH", cookie: seller, body: { stage: "new" },
    })).status, 404);
    assert.equal((await request("/api/leads", { cookie: seller })).data.leads.length, 0);
    assert.match((await request("/api/session", {
      method: "DELETE", cookie: seller,
    })).setCookie, /Max-Age=0/i);

    for (let attempt = 0; attempt < 8; attempt++) {
      assert.equal((await login("pelos", "incorrecto")).status, 401);
    }
    await stop();
    await start();
    assert.equal((await login("pelos", pelosPassword)).status, 429);
    const newManager = (await login("jhon", jhonPassword)).setCookie.split(";")[0];
    assert.deepEqual((await request(leadUrl, { cookie: newManager })).data.lead, won);
  } finally {
    await stop();
    await rm(directory, { force: true, recursive: true });
  }
});
