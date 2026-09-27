import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiBaseUrl } from "@/lib/api/client";
import { verifyEmail } from "@/lib/api/auth";
import { csrfFailure, forwardApiError, parseBody } from "@/lib/bff/route";

/**
 * `POST /api/auth/verify-email`
 *
 * POST rather than a GET landing page that redeems the token directly. Mail
 * clients and security scanners PREFETCH links; a GET that consumes a
 * single-use token would be burned by the scanner before the recipient ever
 * clicked, and the user would see "this link has expired" on a link they never
 * used. The emailed link therefore opens a page, and the page posts here.
 */

const requestSchema = z.object({ token: z.string().min(1) }).strict();

export async function POST(request: NextRequest): Promise<NextResponse> {
  const csrf = csrfFailure(request);
  if (csrf !== null) {
    return csrf;
  }

  const body = await parseBody(request, requestSchema);
  if (!body.ok) {
    return body.response;
  }

  const result = await verifyEmail({ baseUrl: apiBaseUrl() }, body.data.token);
  if (!result.ok) {
    return forwardApiError(result.status, result.error);
  }

  // Note: no session refresh. `emailVerified` cached in an existing cookie goes
  // stale until the next sign-in or refresh, which is harmless — it gates a UI
  // banner, and every real decision is made by the API from the database.
  return NextResponse.json(result.data, { status: 200 });
}
