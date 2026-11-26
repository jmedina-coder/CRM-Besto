import type { NextRequest } from "next/server";
import { handle, readBody, reply, verifyOrigin } from "../../../server/http";
import { authenticate, clientAddress, currentUser, endSession, startSession } from "../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return handle(async () => {
    const user = await currentUser(request);
    return reply({ user, authenticated: Boolean(user) });
  });
}

export function POST(request: NextRequest) {
  return handle(async () => {
    verifyOrigin(request);
    const { username, password } = await readBody(request);
    const user = await authenticate(username, password, clientAddress(request));
    const response = reply({ user, authenticated: true });
    await startSession(request, response, user);
    return response;
  });
}

export function DELETE(request: NextRequest) {
  return handle(async () => {
    verifyOrigin(request);
    const response = reply({ user: null, authenticated: false });
    await endSession(request, response);
    return response;
  });
}
