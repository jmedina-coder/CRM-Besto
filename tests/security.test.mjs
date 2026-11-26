import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApp } from "./harness.mjs";

let app;
const cookieOf = (response) => response.setCookie.split(";")[0];

before(async () => {
  app = await createApp();
}, { timeout: 180_000 });

after(async () => {
  await app?.cleanup();
}, { timeout: 60_000 });

test("login lockout is scoped to the client address, not to the account", { timeout: 120_000 }, async () => {
  const attacker = "203.0.113.9";
  const colleague = "198.51.100.7";
  for (let attempt = 0; attempt < 8; attempt++) {
    assert.equal((await app.login("jhon", "incorrecto", attacker)).status, 401);
  }
  assert.equal((await app.login("jhon", "incorrecto", attacker)).status, 429);
  // A stranger failing 8 times must not lock the real manager out from another address.
  assert.equal((await app.login("jhon", app.passwords.jhon, colleague)).status, 200);
});

test("one address cannot guess across accounts without being capped", { timeout: 120_000 }, async () => {
  const address = "203.0.113.50";
  for (const username of ["jhon", "pelos", "alejandra"]) {
    for (let attempt = 0; attempt < 6; attempt++) {
      assert.equal((await app.login(username, "incorrecto", address)).status, 401);
    }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await app.login("jhon", "incorrecto", address)).status, 401);
  }
  // 20 attempts used: even an untouched account is now refused for this address.
  assert.equal((await app.login("alejandra", app.passwords.alejandra, address)).status, 429);
  assert.equal((await app.login("alejandra", app.passwords.alejandra, "192.0.2.77")).status, 200);
});

test("logout revokes the session on the server", { timeout: 120_000 }, async () => {
  const cookie = cookieOf(await app.login("pelos", app.passwords.pelos, "192.0.2.10"));
  assert.equal((await app.request("/api/session", { cookie })).data.user.id, "pelos");
  assert.equal((await app.request("/api/leads", { cookie })).status, 200);

  const logout = await app.request("/api/session", { method: "DELETE", cookie });
  assert.equal(logout.status, 200);
  assert.match(logout.setCookie, /Max-Age=0/i);

  // The old cookie value must be dead even though its signature and expiry are valid.
  assert.equal((await app.request("/api/session", { cookie })).data.user, null);
  assert.equal((await app.request("/api/leads", { cookie })).status, 401);
});

test("responses carry CSP, HSTS and isolation headers without losing the existing ones", { timeout: 120_000 }, async () => {
  const { headers } = await app.request("/api/session");
  const csp = headers.get("content-security-policy") ?? "";
  for (const directive of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"]) {
    assert.ok(csp.includes(directive), `CSP is missing ${directive}: ${csp}`);
  }
  assert.match(headers.get("strict-transport-security") ?? "", /max-age=\d{8,}/);
  assert.equal(headers.get("cross-origin-opener-policy"), "same-origin");
  // Behavior that must stay the same.
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("referrer-policy"), "no-referrer");
  assert.equal(headers.get("x-powered-by"), null);
});

test("only the sales manager can delete contacts", { timeout: 120_000 }, async () => {
  const seller = cookieOf(await app.login("alejandra", app.passwords.alejandra, "192.0.2.21"));
  const manager = cookieOf(await app.login("jhon", app.passwords.jhon, "192.0.2.22"));
  const created = await app.request("/api/leads", { method: "POST", cookie: seller, body: { name: "Contacto temporal" } });
  assert.equal(created.status, 201);
  const url = `/api/leads/${created.data.lead.id}`;

  const refused = await app.request(url, { method: "DELETE", cookie: seller });
  assert.equal(refused.status, 403);
  assert.equal((await app.request(url, { cookie: seller })).status, 200);

  const deleted = await app.request(url, { method: "DELETE", cookie: manager });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.data, { deleted: true });
  assert.equal((await app.request(url, { cookie: manager })).status, 404);
  // Unknown contacts keep answering 404, as before.
  assert.equal((await app.request(url, { method: "DELETE", cookie: manager })).status, 404);
});
