import type { NextRequest } from "next/server";
import { handle, readBody, reply, verifyOrigin } from "../../../server/http";
import { authenticate, currentUser, endSession, startSession } from "../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return handle(() => {
    const user = currentUser(request);
    return reply({ user, authenticated: Boolean(user) });
  });
}

export function POST(request: NextRequest) {
  return handle(async () => {
    verifyOrigin(request);
    const { username, password } = await readBody(request);
    const user = await authenticate(username, password);
    const response = reply({ user, authenticated: true });
    startSession(request, response, user);
    return response;
  });
}

export function DELETE(request: NextRequest) {
  return handle(() => {
    verifyOrigin(request);
    const response = reply({ user: null, authenticated: false });
    endSession(request, response);
    return response;
  });
}
