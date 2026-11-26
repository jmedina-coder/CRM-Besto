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
  const alejandraPassword = randomBytes(18).toString("hex");
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
      CRM_ALEJANDRA_PASSWORD_HASH: makePassword(alejandraPassword),
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
    assert.equal((await login("alejandra", pelosPassword)).status, 401);
    const alejandraLogin = await login(" Alejandra ", alejandraPassword);
    assert.equal(managerLogin.data.user.role, "manager");
    assert.equal(sellerLogin.data.user.role, "seller");
    assert.equal(alejandraLogin.status, 200);
    assert.deepEqual(alejandraLogin.data.user, { id: "alejandra", name: "Alejandra", role: "seller" });
    assert.match(managerLogin.setCookie, /HttpOnly/i);
    assert.match(managerLogin.setCookie, /SameSite=strict/i);
    const manager = managerLogin.setCookie.split(";")[0];
    const seller = sellerLogin.setCookie.split(";")[0];
    const alejandra = alejandraLogin.setCookie.split(";")[0];
    assert.equal((await request("/api/session", { cookie: seller })).data.user.id, "pelos");
    assert.equal((await request("/api/session", { cookie: alejandra })).data.user.id, "alejandra");
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
    assert.equal(Object.hasOwn(lead, "creationFingerprint"), false);
    assert.equal((await request("/api/leads", {
      method: "POST", cookie: seller, body: draft, headers: { "Idempotency-Key": key },
    })).data.lead.id, lead.id);
    assert.equal((await request("/api/leads", {
      method: "POST", cookie: seller, body: { ...draft, company: "Otro negocio" },
      headers: { "Idempotency-Key": key },
    })).status, 409);
    assert.equal((await request("/api/leads", {
      method: "POST", cookie: manager, body: { ...draft, assignee: "pelos" },
      headers: { "Idempotency-Key": key },
    })).status, 409);
    for (const invalidLead of [
      { name: "Contacto\u0000inválido" },
      { name: "Contacto\ud800inválido" },
      { name: "Contacto de prueba", nextFollowUp: "2026-11-26T24:00:00Z" },
    ]) {
      assert.equal((await request("/api/leads", {
        method: "POST", cookie: seller, body: invalidLead,
      })).status, 400);
    }
    const alejandraCreate = await request("/api/leads", {
      method: "POST", cookie: alejandra, body: { name: "Contacto Alejandra" },
    });
    assert.equal(alejandraCreate.status, 201);
    const alejandraLead = alejandraCreate.data.lead;
    const alejandraLeadUrl = `/api/leads/${alejandraLead.id}`;
    assert.equal(alejandraLead.assignee, "alejandra");
    assert.equal(alejandraLead.activities[0].author, "alejandra");

    assert.deepEqual((await request("/api/leads", { cookie: seller })).data.leads.map((entry) => entry.id), [lead.id]);
    assert.deepEqual((await request("/api/leads", { cookie: alejandra })).data.leads.map((entry) => entry.id), [alejandraLead.id]);
    assert.equal((await request("/api/leads", { cookie: manager })).data.leads.length, 3);
    assert.equal((await request(alejandraLeadUrl, { cookie: seller })).status, 404);
    assert.equal((await request(`/api/leads/${managerLead.id}`, { cookie: seller })).status, 404);
    assert.equal((await request(`/api/leads/${managerLead.id}`, { method: "DELETE", cookie: seller })).status, 404);

    const leadUrl = `/api/leads/${lead.id}`;
    assert.equal((await request(leadUrl, { cookie: alejandra })).status, 404);
    assert.equal((await request(`${leadUrl}/activities`, {
      method: "POST", cookie: alejandra, body: { kind: "note", body: "Contacto fuera de su cartera" },
    })).status, 404);
    assert.equal((await request(alejandraLeadUrl, {
      method: "PATCH", cookie: alejandra, body: { revision: alejandraLead.revision, assignee: "pelos" },
    })).status, 403);

    const managerLeadUrl = `/api/leads/${managerLead.id}`;
    const reassignment = await request(managerLeadUrl, {
      method: "PATCH", cookie: manager, body: { revision: managerLead.revision, assignee: "alejandra" },
    });
    assert.equal(reassignment.status, 200);
    assert.equal(reassignment.data.lead.assignee, "alejandra");
    assert.equal(reassignment.data.lead.activities[0].kind, "updated");
    assert.equal(reassignment.data.lead.activities[0].author, "jhon");
    assert.match(reassignment.data.lead.activities[0].body, /Jhon → Alejandra/);
    const note = await request(`${managerLeadUrl}/activities`, {
      method: "POST", cookie: alejandra, body: { kind: "note", body: "Contacto en seguimiento" },
    });
    assert.equal(note.status, 201);
    assert.equal(note.data.lead.activities[0].author, "alejandra");

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

    const activityKey = randomUUID();
    const activity = { kind: "note", body: "Enviar propuesta", revision: current.revision };
    const saveActivity = (body) => request(`${leadUrl}/activities`, {
      method: "POST", cookie: seller, body, headers: { "Idempotency-Key": activityKey },
    });
    const activityResults = await Promise.all([saveActivity(activity), saveActivity(activity)]);
    assert.deepEqual(activityResults.map((response) => response.status), [201, 201]);
    const withActivity = activityResults[0].data.lead;
    assert.deepEqual(activityResults[1].data.lead, withActivity);
    assert.equal(withActivity.activities.filter((entry) => entry.id === activityKey).length, 1);
    assert.equal(withActivity.revision, current.revision + 1);
    assert.equal((await saveActivity({ ...activity, body: "Otra nota" })).status, 409);

    const edit = await request(leadUrl, {
      method: "PATCH", cookie: seller,
      body: { revision: withActivity.revision, nextAction: "Enviar cotización actualizada" },
    });
    assert.equal(edit.status, 200);
    assert.equal(edit.data.lead.activities[0].kind, "updated");
    assert.equal(edit.data.lead.activities[0].author, "pelos");
    assert.equal(edit.data.lead.activities[0].body, "Campos editados: Próxima acción.");
    const replay = await request("/api/leads", {
      method: "POST", cookie: seller, body: draft, headers: { "Idempotency-Key": key },
    });
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.data.lead, edit.data.lead);

    const won = (await request(leadUrl, {
      method: "PATCH",
      cookie: manager,
      body: { revision: edit.data.lead.revision, stage: "won", amount: 450_000, assignee: "jhon" },
    })).data.lead;
    assert.equal(won.stage, "won");
    assert.ok(won.wonAt);
    assert.equal(won.activities[0].author, "jhon");
    assert.equal(won.activities[0].kind, "stage");
    assert.match(won.activities[1].body, /Pelos → Jhon.*Valor comercial/);
    assert.equal((await request(leadUrl, {
      method: "PATCH", cookie: seller, body: { stage: "new" },
    })).status, 404);
    assert.equal((await request("/api/leads", { cookie: seller })).data.leads.length, 0);
    assert.match((await request("/api/session", {
      method: "DELETE", cookie: seller,
    })).setCookie, /Max-Age=0/i);

    const importPath = "/api/leads/import?format=csv&assignee=alejandra";
    const importRows = [
      "Código;Nombre de la persona;Teléfono;Correo;Nombre del establecimiento;Actividad;Responsable",
      '0001;;3000000010;correo-incompleto;"Negocio; Colombia";Servicios;Pelos',
      ...Array.from({ length: 504 }, (_, index) => `ABC-${index};Contacto ${index};;;;Prueba;`),
    ].join("\n");
    async function upload(cookie, confirm = false, body = importRows) {
      const response = await fetch(origin + importPath + (confirm ? "&confirm=1" : ""), {
        method: "POST", headers: { Origin: origin, Cookie: cookie }, body,
      });
      return { status: response.status, data: await response.json() };
    }
    assert.equal((await upload(seller)).status, 403);
    const preview = await upload(manager);
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.data.assigned, { jhon: 0, pelos: 1, alejandra: 504 });
    assert.equal(preview.data.rows, 505);
    assert.equal(preview.data.namesCompleted, 1);
    assert.equal(preview.data.unverifiedEmails, 1);
    assert.equal((await request("/api/leads?after=", { cookie: seller })).data.leads.length, 0);
    assert.equal((await upload(manager, true, importRows + "\n0002;Sin usuario;;;;;Desconocido")).status, 400);
    assert.equal((await request("/api/leads?after=", { cookie: seller })).data.leads.length, 0);

    const imported = await upload(manager, true);
    assert.equal(imported.status, 201);
    assert.equal(imported.data.created, 505);
    assert.equal((await upload(manager, true)).data.skipped, 505);
    const sellerPage = await request("/api/leads?after=", { cookie: seller });
    assert.equal(sellerPage.data.nextCursor, null);
    assert.equal(sellerPage.data.leads.length, 1);
    const importedLead = sellerPage.data.leads[0];
    assert.equal(importedLead.name, "Negocio; Colombia");
    assert.equal(importedLead.email, "");
    assert.equal(importedLead.imported.code, "0001");
    assert.equal(importedLead.imported.unverifiedEmail, "correo-incompleto");
    assert.equal(importedLead.activities[0].author, "jhon");
    const firstPage = await request("/api/leads?after=", { cookie: alejandra });
    assert.equal(firstPage.data.leads.length, 500);
    assert.ok(firstPage.data.nextCursor);
    const secondPage = await request(`/api/leads?after=${firstPage.data.nextCursor}`, { cookie: alejandra });
    assert.equal(secondPage.data.leads.length, 6);
    assert.equal(secondPage.data.nextCursor, null);
    assert.equal(new Set([...firstPage.data.leads, ...secondPage.data.leads].map(({ id }) => id)).size, 506);

    for (let attempt = 0; attempt < 8; attempt++) {
      assert.equal((await login("pelos", "incorrecto")).status, 401);
    }
    await stop();
    await start();
    assert.equal((await login("pelos", pelosPassword)).status, 429);
    assert.equal((await login("alejandra", alejandraPassword)).status, 200);
    const newManager = (await login("jhon", jhonPassword)).setCookie.split(";")[0];
    assert.deepEqual((await request(leadUrl, { cookie: newManager })).data.lead, won);
  } finally {
    await stop();
    await rm(directory, { force: true, recursive: true });
  }
});
