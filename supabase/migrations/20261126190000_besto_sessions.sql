-- Server-side sessions and throttle-table indexes. Keep in sync with postgresStore()
-- in server/store.ts, which applies the same idempotent statements on first connection.

CREATE TABLE IF NOT EXISTS public.besto_sessions (
  nonce TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS besto_login_attempts_expiry ON public.besto_login_attempts (expires_at);
CREATE INDEX IF NOT EXISTS besto_sessions_expiry ON public.besto_sessions (expires_at);

-- Same model as the other tables: the server connects as the owner, and RLS without
-- policies keeps the table closed to the public Data API.
ALTER TABLE public.besto_sessions ENABLE ROW LEVEL SECURITY;
