// Pure helpers (no imports) so they can be unit-tested without Next.js.

export type SslOptions = false | { rejectUnauthorized: boolean; ca?: string };

export function isLocalHost(url: string) {
  const { hostname } = new URL(url);
  // URL keeps the brackets around IPv6 literals ("[::1]").
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

// Remote Postgres connections must verify the server certificate: "require" in
// postgres.js encrypts the link but accepts any certificate, so anyone on the network
// path could impersonate the database. This option object also wins over any
// ?sslmode= value in the connection string.
//
//   DATABASE_CA_CERT    PEM of the CA that signed the server certificate (use "\n" for
//                       line breaks). Needed when the provider's CA is not publicly trusted.
//   DATABASE_TLS_VERIFY set to "false" ONLY as a temporary, explicit opt-out.
export function sslOptions(url: string, env: Record<string, string | undefined>): SslOptions {
  if (isLocalHost(url)) return false;
  if (env.DATABASE_TLS_VERIFY === "false") return { rejectUnauthorized: false };
  const ca = env.DATABASE_CA_CERT?.replace(/\\n/g, "\n").trim();
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}
