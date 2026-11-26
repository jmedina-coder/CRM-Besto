import type { NextRequest } from "next/server";
import { SALES_USERS } from "../../../../app/model";
import { handle, readBytes, reply, RequestError, verifyOrigin } from "../../../../server/http";
import { importContacts } from "../../../../server/lead-import";
import { requireSession } from "../../../../server/session";

export const runtime = "nodejs";
export const maxDuration = 60;

export function POST(request: NextRequest) {
  return handle(async () => {
    verifyOrigin(request);
    const actor = await requireSession(request);
    if (actor.role !== "manager") throw new RequestError(403, "Solo el encargado de ventas puede importar contactos.");
    const query = request.nextUrl.searchParams;
    const format = query.get("format");
    if (format !== "xlsx" && format !== "csv") throw new RequestError(415, "Selecciona un archivo .xlsx o .csv.");
    const assignee = SALES_USERS.find(({ id }) => id === (query.get("assignee") ?? actor.id));
    if (!assignee) throw new RequestError(400, "Elige un responsable válido.");

    const bytes = await readBytes(request, 4 * 1024 * 1024);
    const confirm = query.get("confirm") === "1";
    return reply(await importContacts(bytes, format, actor, assignee.id, confirm), confirm ? 201 : 200);
  });
}
