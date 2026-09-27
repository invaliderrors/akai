import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { passwordSchema } from "@akai/contracts";
import { apiBaseUrl } from "@/lib/api/client";
import { confirmPasswordReset } from "@/lib/api/auth";
import { csrfFailure, forwardApiError, parseBody } from "@/lib/bff/route";
import { clearSession } from "@/lib/session/server";

/**
 * `POST /api/auth/password-reset/confirm`
 *
 * A successful reset revokes every refresh family server-side (spec §8), so any
 * session cookie held by THIS browser is now backed by a dead token pair. It is
 * cleared here rather than left to expire: otherwise the user appears signed in,
 * every API call 401s, and the app looks broken at precisely the moment they
 * were recovering from a suspected compromise.
 *
 * No session is created either. Requiring a fresh sign-in with the new password
 * confirms they can actually use what they just set.
 */

const requestSchema = z
  .object({
    token: z.string().min(1),
    password: passwordSchema,
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

  const result = await confirmPasswordReset({ baseUrl: apiBaseUrl() }, body.data);
  if (!result.ok) {
    return forwardApiError(result.status, result.error);
  }

  await clearSession();

  return NextResponse.json(result.data, { status: 200 });
}
