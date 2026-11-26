import type { NextRequest } from "next/server";
import { handle, leadId, readBody, reply, verifyOrigin } from "../../../../server/http";
import { deleteLead, getLead, updateLead } from "../../../../server/leads";
import { requireSession } from "../../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export function GET(request: NextRequest, context: Context) {
  return handle(async () => {
    const user = await requireSession(request);
    return reply({ lead: await getLead(await leadId(context), user) });
  });
}

export function PATCH(request: NextRequest, context: Context) {
  return handle(async () => {
    verifyOrigin(request);
    const user = await requireSession(request);
    const id = await leadId(context);
    return reply({ lead: await updateLead(id, await readBody(request), user) });
  });
}

export function DELETE(request: NextRequest, context: Context) {
  return handle(async () => {
    verifyOrigin(request);
    const user = await requireSession(request);
    await deleteLead(await leadId(context), user);
    return reply({ deleted: true });
  });
}
