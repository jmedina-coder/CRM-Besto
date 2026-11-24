import type { NextRequest } from "next/server";
import { handle, idempotencyKey, readBody, reply, verifyOrigin } from "../../../server/http";
import { createLead, listLeads } from "../../../server/leads";
import { requireSession } from "../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return handle(async () => {
    const user = requireSession(request);
    return reply({ leads: await listLeads(user) });
  });
}

export function POST(request: NextRequest) {
  return handle(async () => {
    verifyOrigin(request);
    const user = requireSession(request);
    const lead = await createLead(await readBody(request), user, idempotencyKey(request));
    return reply({ lead }, 201);
  });
}
