import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiBaseUrl } from "@/lib/api/client";
import { logout } from "@/lib/api/auth";
import { csrfFailure, parseBody } from "@/lib/bff/route";
import { clearSession, getSession } from "@/lib/session/server";

/**
 * `POST /api/auth/logout`
 *
 * POST, not GET: a `<img src="/api/auth/logout">` on any page would otherwise
 * sign users out at will. Annoying rather than dangerous, but it is free to
 * prevent.
 *
 * THE COOKIE IS CLEARED UNCONDITIONALLY. If the API call fails — network
 * partition, API restart, already-revoked session — the local session is still
 * destroyed. The alternative is a user who clicked "sign out", saw an error,
 * and walked away from a machine that is still signed in. Server-side
 * revocation is the more important half, but it is also the half that can be
 * retried later; leaving a live cookie in a browser cannot be.
 */

const requestSchema = z
  .object({
    /** Revoke every session in the family, not just this device. */
    allDevices: z.boolean().default(false),
  })
  .strict();

export async function POST(request: NextRequest): Promise<NextResponse> {
  const csrf = csrfFailure(request);
  if (csrf !== null) {
    return csrf;
  }

  const body = await parseBody(request, requestSchema);
  if (!body.ok) {
    return body.response;
  }

  const session = await getSession();

  if (session !== null) {
    // Best-effort server-side revocation. The result is deliberately not
    // checked: see the note above on why local teardown proceeds regardless.
    await logout({ baseUrl: apiBaseUrl() }, session.accessToken, {
      refreshToken: session.refreshToken,
      allDevices: body.data.allDevices,
    });
  }

  await clearSession();

  return NextResponse.json({ status: "signed-out" } as const, { status: 200 });
}
