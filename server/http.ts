import { NextRequest, NextResponse } from "next/server";

const maxPayloadBytes = 32 * 1024;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function reply(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function handle(action: () => Promise<NextResponse> | NextResponse) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof RequestError) {
      return reply({ error: error.message }, error.status);
    }

    // Log the name and code only; messages can carry hostnames or query data.
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    console.error("Error interno del CRM", error instanceof Error ? error.name : "Error", code ?? "");
    return reply({ error: "No se pudo completar la operación. Intenta de nuevo." }, 503);
  }
}

export function verifyOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  const requestUrl = new URL(request.url);
  const host = request.headers.get("host") ?? requestUrl.host;
  const protocol = process.env.VERCEL ? "https:" : requestUrl.protocol;

  if (origin !== `${protocol}//${host}` || (fetchSite && fetchSite !== "same-origin")) {
    throw new RequestError(403, "La solicitud debe venir desde BESTO CRM.");
  }
}

export async function readBody(request: NextRequest): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json" || !request.body) {
    throw new RequestError(415, "Envía la solicitud en JSON.");
  }

  const bytes = await readBytes(request, maxPayloadBytes);
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new RequestError(400, "La solicitud debe contener un objeto JSON.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, "La solicitud contiene JSON inválido.");
  }
}

export async function readBytes(request: NextRequest, limit: number): Promise<Buffer> {
  if (!request.body) throw new RequestError(400, "La solicitud está vacía.");
  if (Number(request.headers.get("content-length")) > limit) {
    throw new RequestError(413, "La solicitud es demasiado grande.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => {});
        throw new RequestError(413, "La solicitud es demasiado grande.");
      }
      chunks.push(value);
    }

    return Buffer.concat(chunks, length);
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, "No se pudo leer la solicitud completa.");
  } finally {
    reader.releaseLock();
  }
}

export function leadCursor(value: string) {
  if (value && !uuid.test(value)) throw new RequestError(400, "La página de contactos no es válida.");
  return value.toLowerCase();
}

export function idempotencyKey(request: NextRequest) {
  const key = request.headers.get("idempotency-key");
  if (key && !uuid.test(key)) {
    throw new RequestError(400, "La clave de idempotencia debe ser un UUID.");
  }
  return key?.toLowerCase();
}

export async function leadId(context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!uuid.test(id)) throw new RequestError(404, "El contacto no está disponible.");
  return id.toLowerCase();
}
