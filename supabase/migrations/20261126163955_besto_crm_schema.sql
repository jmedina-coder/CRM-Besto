-- BESTO CRM schema. Keep in sync with postgresStore() in server/store.ts,
-- which applies the same idempotent statements on first connection.

CREATE TABLE IF NOT EXISTS public.besto_leads (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  assignee TEXT NOT NULL,
  payload JSONB NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.besto_login_attempts (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS besto_leads_assignee_id ON public.besto_leads (assignee, id);

-- The CRM enforces permissions on the server and connects as the table owner,
-- which bypasses RLS. Enabling RLS with no policies keeps both tables closed to
-- the public Data API, so the publishable key cannot read or write CRM data.
ALTER TABLE public.besto_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.besto_login_attempts ENABLE ROW LEVEL SECURITY;
