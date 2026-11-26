import type { NextRequest } from "next/server";
import { handle, idempotencyKey, leadId, readBody, reply, verifyOrigin } from "../../../../../server/http";
import { addActivity } from "../../../../../server/leads";
import { requireSession } from "../../../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    verifyOrigin(request);
    const user = await requireSession(request);
    const id = await leadId(context);
    const lead = await addActivity(id, await readBody(request), user, idempotencyKey(request));
    return reply({ lead }, 201);
  });
}
