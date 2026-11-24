import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { neon } from "@neondatabase/serverless";
import type { Lead, SalesUserId } from "../app/model";

type Store = {
  list(assignee: SalesUserId | null): Promise<Lead[]>;
  get(id: string, assignee: SalesUserId | null): Promise<Lead | undefined>;
  insert(lead: Lead): Promise<boolean>;
  update(lead: Lead, revision: number, assignee: SalesUserId | null): Promise<boolean>;
  remove(id: string, assignee: SalesUserId | null): Promise<boolean>;
  reserveLoginAttempt(bucket: string, now: number, expires: number, limit: number): Promise<boolean>;
  resetLoginAttempts(bucket: string): Promise<void>;
};

async function neonStore(url: string): Promise<Store> {
  const sql = neon(url);
  await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(4297307215)`,
    sql`
      CREATE TABLE IF NOT EXISTS besto_leads (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        assignee TEXT NOT NULL,
        payload JSONB NOT NULL,
        updated_at TEXT NOT NULL
      )
    `,
    sql`
      CREATE TABLE IF NOT EXISTS besto_login_attempts (
        bucket TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL,
        expires_at BIGINT NOT NULL
      )
    `,
  ]);

  return {
    async list(assignee) {
      const rows = await sql`
        SELECT payload FROM besto_leads
        WHERE (${assignee}::text IS NULL OR assignee = ${assignee})
        ORDER BY updated_at DESC, id DESC
      `;
      return rows.map((row) => row.payload as Lead);
    },
    async get(id, assignee) {
      const [row] = await sql`
        SELECT payload FROM besto_leads
        WHERE id = ${id} AND (${assignee}::text IS NULL OR assignee = ${assignee})
      `;
      return row?.payload as Lead | undefined;
    },
    async insert(lead) {
      const rows = await sql`
        INSERT INTO besto_leads (id, revision, assignee, payload, updated_at)
        VALUES (${lead.id}, ${lead.revision}, ${lead.assignee}, ${JSON.stringify(lead)}::jsonb, ${lead.updatedAt})
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `;
      return rows.length === 1;
    },
    async update(lead, revision, assignee) {
      const rows = await sql`
        UPDATE besto_leads
        SET revision = ${lead.revision}, assignee = ${lead.assignee},
            payload = ${JSON.stringify(lead)}::jsonb, updated_at = ${lead.updatedAt}
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
  `);
  const list = db.prepare(`
    SELECT payload FROM besto_leads WHERE (? IS NULL OR assignee = ?)
    ORDER BY updated_at DESC, id DESC
  `);
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

  return {
    async list(assignee) {
      return list.all(assignee, assignee).map((row) => JSON.parse(row.payload as string) as Lead);
    },
    async get(id, assignee) {
      const row = get.get(id, assignee, assignee);
      return row ? (JSON.parse(row.payload as string) as Lead) : undefined;
    },
    async insert(lead) {
      return insert.run(lead.id, lead.revision, lead.assignee, JSON.stringify(lead), lead.updatedAt).changes === 1;
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
  };
}

let storePromise: Promise<Store> | undefined;

async function connect() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (url) return neonStore(url);
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
