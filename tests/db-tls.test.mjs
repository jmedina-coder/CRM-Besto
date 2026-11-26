import assert from "node:assert/strict";
import test from "node:test";
import { sslOptions } from "../server/db-tls.ts";

const remote = "postgresql://postgres.ref:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres";

test("remote databases verify the server certificate by default", () => {
  assert.deepEqual(sslOptions(remote, {}), { rejectUnauthorized: true });
});

test("a URL sslmode cannot weaken certificate verification", () => {
  assert.deepEqual(sslOptions(`${remote}?sslmode=require`, {}), { rejectUnauthorized: true });
});

test("a pinned CA certificate is passed through with escaped newlines restored", () => {
  const options = sslOptions(remote, {
    DATABASE_CA_CERT: "-----BEGIN CERTIFICATE-----\\nQUJD\\n-----END CERTIFICATE-----",
  });
  assert.deepEqual(options, {
    rejectUnauthorized: true,
    ca: "-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----",
  });
});

test("local databases do not use TLS, as before", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.equal(sslOptions(`postgresql://u:p@${host}:5432/db`, {}), false);
  }
});

test("disabling verification requires an explicit opt-out", () => {
  assert.deepEqual(sslOptions(remote, { DATABASE_TLS_VERIFY: "false" }), { rejectUnauthorized: false });
  assert.deepEqual(sslOptions(remote, { DATABASE_TLS_VERIFY: "0" }), { rejectUnauthorized: true });
});
