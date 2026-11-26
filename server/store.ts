import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import postgres from "postgres";
import type { Lead, SalesUserId } from "../app/model";
import { sslOptions } from "./db-tls";

export type StoredLead = Lead & { creationFingerprint?: string };

type Store = {
  list(assignee: SalesUserId | null): Promise<StoredLead[]>;
  listPage(assignee: SalesUserId | null, after: string, limit: number): Promise<StoredLead[]>;
  get(id: string, assignee: SalesUserId | null): Promise<StoredLead | undefined>;
  insert(lead: StoredLead): Promise<boolean>;
  insertMany(leads: StoredLead[]): Promise<number>;
  update(lead: StoredLead, revision: number, assignee: SalesUserId | null): Promise<boolean>;
  remove(id: string, assignee: SalesUserId | null): Promise<boolean>;
  reserveLoginAttempt(bucket: string, now: number, expires: number, limit: number): Promise<boolean>;
  resetLoginAttempts(bucket: string): Promise<void>;
  // Server-side sessions: a signed cookie alone is not enough, its nonce must be stored.
  // Session expiry is in epoch seconds; login attempts use epoch milliseconds.
  createSession(nonce: string, userId: SalesUserId, expiresAt: number): Promise<void>;
  hasSession(nonce: string, userId: SalesUserId, nowSeconds: number): Promise<boolean>;
  deleteSession(nonce: string): Promise<void>;
  purgeExpired(nowMilliseconds: number): Promise<void>;
};

async function postgresStore(url: string): Promise<Store> {
  const ssl = sslOptions(url, process.env);
  if (ssl && !ssl.rejectUnauthorized) {
    console.warn("DATABASE_TLS_VERIFY=false: the database certificate is NOT being verified.");
  }
  // Supabase's transaction pooler (port 6543) does not support prepared statements.
  const sql = postgres(url, {
    prepare: false,
    max: 5,
    idle_timeout: 20,
    ssl,
    onnotice: () => {},
  });
  // Pass objects, not JSON strings: the driver serializes jsonb parameters itself,
  // so a pre-stringified value would be stored as a JSON string scalar.
  const json = (value: unknown) => sql.json(value as postgres.JSONValue);
  // Keep in sync with supabase/migrations. RLS without policies blocks the public
  // Data API (anon/authenticated keys); the server connects as the table owner.
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(4297307215)`;
    await tx`
      CREATE TABLE IF NOT EXISTS besto_leads (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        assignee TEXT NOT NULL,
        payload JSONB NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
    await tx`
      CREATE TABLE IF NOT EXISTS besto_login_attempts (
        bucket TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL,
        expires_at BIGINT NOT NULL
      )
    `;
    await tx`
      CREATE TABLE IF NOT EXISTS besto_sessions (
        nonce TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at BIGINT NOT NULL
      )
    `;
    await tx`CREATE INDEX IF NOT EXISTS besto_leads_assignee_id ON besto_leads (assignee, id)`;
    await tx`CREATE INDEX IF NOT EXISTS besto_login_attempts_expiry ON besto_login_attempts (expires_at)`;
    await tx`CREATE INDEX IF NOT EXISTS besto_sessions_expiry ON besto_sessions (expires_at)`;
    await tx`ALTER TABLE besto_leads ENABLE ROW LEVEL SECURITY`;
    await tx`ALTER TABLE besto_login_attempts ENABLE ROW LEVEL SECURITY`;
    await tx`ALTER TABLE besto_sessions ENABLE ROW LEVEL SECURITY`;
  });

  return {
    async list(assignee) {
      const rows = await sql`
        SELECT payload FROM besto_leads
        WHERE (${assignee}::text IS NULL OR assignee = ${assignee})
        ORDER BY updated_at DESC, id DESC
      `;
      return rows.map((row) => row.payload as StoredLead);
    },
    async listPage(assignee, after, limit) {
      const rows = assignee ? await sql`
        SELECT payload FROM besto_leads
        WHERE assignee = ${assignee} AND id > ${after}
        ORDER BY id LIMIT ${limit}
      ` : await sql`
        SELECT payload FROM besto_leads WHERE id > ${after} ORDER BY id LIMIT ${limit}
      `;
      return rows.map((row) => row.payload as StoredLead);
    },
    async get(id, assignee) {
      const [row] = await sql`
        SELECT payload FROM besto_leads
        WHERE id = ${id} AND (${assignee}::text IS NULL OR assignee = ${assignee})
      `;
      return row?.payload as StoredLead | undefined;
    },
    async insert(lead) {
      const rows = await sql`
        INSERT INTO besto_leads (id, revision, assignee, payload, updated_at)
        VALUES (${lead.id}, ${lead.revision}, ${lead.assignee}, ${json(lead)}, ${lead.updatedAt})
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `;
      return rows.length === 1;
    },
    async insertMany(leads) {
      let count = 0;
      const batchSize = 500;
      for (let start = 0; start < leads.length; start += batchSize) {
        const batch = leads.slice(start, start + batchSize).map((lead) => ({
          id: lead.id, revision: lead.revision, assignee: lead.assignee, payload: lead, updated_at: lead.updatedAt,
        }));
        const [row] = await sql`
          WITH inserted AS (
            INSERT INTO besto_leads (id, revision, assignee, payload, updated_at)
            SELECT id, revision, assignee, payload, updated_at
            FROM jsonb_to_recordset(${json(batch)})
              AS records(id TEXT, revision INTEGER, assignee TEXT, payload JSONB, updated_at TEXT)
            ON CONFLICT (id) DO NOTHING
            RETURNING id
          )
          SELECT count(*) AS count FROM inserted
        `;
        count += Number(row.count);
      }
      return count;
    },
    async update(lead, revision, assignee) {
      const rows = await sql`
        UPDATE besto_leads
        SET revision = ${lead.revision}, assignee = ${lead.assignee},
            payload = ${json(lead)}, updated_at = ${lead.updatedAt}
        WHERE id = ${lead.id} AND revision = ${revision}
          AND (${assignee}::text IS NULL OR assignee = ${assignee})
        RETURNING id
      `;
      return rows.length === 1;
    },
    async remove(id, assignee) {
      const rows = await sql`
        DELETE FROM besto_leads
        WHERE id = ${id} AND (${assignee}::text IS NULL OR assignee = ${assignee})
        RETURNING id
      `;
      return rows.length === 1;
    },
    async reserveLoginAttempt(bucket, now, expires, limit) {
      const rows = await sql`
        INSERT INTO besto_login_attempts (bucket, attempts, expires_at)
        VALUES (${bucket}, 1, ${expires})
        ON CONFLICT (bucket) DO UPDATE SET
          attempts = CASE WHEN besto_login_attempts.expires_at <= ${now} THEN 1
                    ELSE besto_login_attempts.attempts + 1 END,
          expires_at = CASE WHEN besto_login_attempts.expires_at <= ${now} THEN excluded.expires_at
                      ELSE besto_login_attempts.expires_at END
        WHERE besto_login_attempts.expires_at <= ${now} OR besto_login_attempts.attempts < ${limit}
        RETURNING bucket
      `;
      return rows.length === 1;
    },
    async resetLoginAttempts(bucket) {
      await sql`DELETE FROM besto_login_attempts WHERE bucket = ${bucket}`;
    },
    async createSession(nonce, userId, expiresAt) {
      await sql`INSERT INTO besto_sessions (nonce, user_id, expires_at) VALUES (${nonce}, ${userId}, ${expiresAt})`;
    },
    async hasSession(nonce, userId, nowSeconds) {
      const rows = await sql`
        SELECT 1 FROM besto_sessions
        WHERE nonce = ${nonce} AND user_id = ${userId} AND expires_at > ${nowSeconds}
      `;
      return rows.length === 1;
    },
    async deleteSession(nonce) {
      await sql`DELETE FROM besto_sessions WHERE nonce = ${nonce}`;
    },
    async purgeExpired(nowMilliseconds) {
      await sql`DELETE FROM besto_sessions WHERE expires_at <= ${Math.floor(nowMilliseconds / 1_000)}`;
      await sql`DELETE FROM besto_login_attempts WHERE expires_at <= ${nowMilliseconds}`;
    },
  };
}

function localStore(): Store {
  const path = resolve(/* turbopackIgnore: true */ process.env.CRM_DB_PATH || ".data/crm.sqlite");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS besto_leads (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      assignee TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS besto_login_attempts (
      bucket TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS besto_sessions (
      nonce TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS besto_leads_assignee_id ON besto_leads (assignee, id);
    CREATE INDEX IF NOT EXISTS besto_login_attempts_expiry ON besto_login_attempts (expires_at);
    CREATE INDEX IF NOT EXISTS besto_sessions_expiry ON besto_sessions (expires_at);
  `);
  const list = db.prepare(`
    SELECT payload FROM besto_leads WHERE (? IS NULL OR assignee = ?)
    ORDER BY updated_at DESC, id DESC
  `);
  const listPage = db.prepare("SELECT payload FROM besto_leads WHERE id > ? ORDER BY id LIMIT ?");
  const listAssigneePage = db.prepare("SELECT payload FROM besto_leads WHERE assignee = ? AND id > ? ORDER BY id LIMIT ?");
  const get = db.prepare("SELECT payload FROM besto_leads WHERE id = ? AND (? IS NULL OR assignee = ?)");
  const insert = db.prepare(`
    INSERT INTO besto_leads (id, revision, assignee, payload, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING
  `);
  const update = db.prepare(`
    UPDATE besto_leads SET revision = ?, assignee = ?, payload = ?, updated_at = ?
    WHERE id = ? AND revision = ? AND (? IS NULL OR assignee = ?)
  `);
  const remove = db.prepare("DELETE FROM besto_leads WHERE id = ? AND (? IS NULL OR assignee = ?)");
  const reserveLoginAttempt = db.prepare(`
    INSERT INTO besto_login_attempts (bucket, attempts, expires_at)
    VALUES (?, 1, ?)
    ON CONFLICT (bucket) DO UPDATE SET
      attempts = CASE WHEN besto_login_attempts.expires_at <= ? THEN 1
                ELSE besto_login_attempts.attempts + 1 END,
      expires_at = CASE WHEN besto_login_attempts.expires_at <= ? THEN excluded.expires_at
                  ELSE besto_login_attempts.expires_at END
    WHERE besto_login_attempts.expires_at <= ? OR besto_login_attempts.attempts < ?
  `);
  const resetLoginAttempts = db.prepare("DELETE FROM besto_login_attempts WHERE bucket = ?");
  const createSession = db.prepare("INSERT INTO besto_sessions (nonce, user_id, expires_at) VALUES (?, ?, ?)");
  const hasSession = db.prepare("SELECT 1 AS found FROM besto_sessions WHERE nonce = ? AND user_id = ? AND expires_at > ?");
  const deleteSession = db.prepare("DELETE FROM besto_sessions WHERE nonce = ?");
  const purgeSessions = db.prepare("DELETE FROM besto_sessions WHERE expires_at <= ?");
  const purgeAttempts = db.prepare("DELETE FROM besto_login_attempts WHERE expires_at <= ?");
  function insertLead(lead: StoredLead) {
    return insert.run(lead.id, lead.revision, lead.assignee, JSON.stringify(lead), lead.updatedAt).changes === 1;
  }

  return {
    async list(assignee) {
      return list.all(assignee, assignee).map((row) => JSON.parse(row.payload as string) as StoredLead);
    },
    async listPage(assignee, after, limit) {
      const rows = assignee ? listAssigneePage.all(assignee, after, limit) : listPage.all(after, limit);
      return rows.map((row) => JSON.parse(row.payload as string) as StoredLead);
    },
    async get(id, assignee) {
      const row = get.get(id, assignee, assignee);
      return row ? (JSON.parse(row.payload as string) as StoredLead) : undefined;
    },
    async insert(lead) {
      return insertLead(lead);
    },
    async insertMany(leads) {
      db.exec("BEGIN IMMEDIATE");
      try {
        let count = 0;
        for (const lead of leads) if (insertLead(lead)) count++;
        db.exec("COMMIT");
        return count;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async update(lead, revision, assignee) {
      return update.run(
        lead.revision, lead.assignee, JSON.stringify(lead), lead.updatedAt, lead.id, revision, assignee, assignee,
      ).changes === 1;
    },
    async remove(id, assignee) {
      return remove.run(id, assignee, assignee).changes === 1;
    },
    async reserveLoginAttempt(bucket, now, expires, limit) {
      return reserveLoginAttempt.run(bucket, expires, now, now, now, limit).changes === 1;
    },
    async resetLoginAttempts(bucket) {
      resetLoginAttempts.run(bucket);
    },
    async createSession(nonce, userId, expiresAt) {
      createSession.run(nonce, userId, expiresAt);
    },
    async hasSession(nonce, userId, nowSeconds) {
      return hasSession.get(nonce, userId, nowSeconds) !== undefined;
    },
    async deleteSession(nonce) {
      deleteSession.run(nonce);
    },
    async purgeExpired(nowMilliseconds) {
      purgeSessions.run(Math.floor(nowMilliseconds / 1_000));
      purgeAttempts.run(nowMilliseconds);
    },
  };
}

let storePromise: Promise<Store> | undefined;

async function connect() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (url) return postgresStore(url);
  if (process.env.VERCEL || process.env.VERCEL_ENV) {
    throw new Error("DATABASE_URL is required on Vercel.");
  }
  return localStore();
}

export function getStore() {
  if (!storePromise) {
    storePromise = connect().catch((error) => {
      storePromise = undefined;
      throw error;
    });
  }
  return storePromise;
}
