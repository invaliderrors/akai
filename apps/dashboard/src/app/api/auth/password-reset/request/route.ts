import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { emailSchema } from "@akai/contracts";
import { apiBaseUrl } from "@/lib/api/client";
import { requestPasswordReset } from "@/lib/api/auth";
import { csrfFailure, forwardApiError, parseBody } from "@/lib/bff/route";

/**
 * `POST /api/auth/password-reset/request`
 *
 * Always 202 with the neutral acknowledgement. The UI must render one identical
 * message for every outcome — "if an account exists, we sent a link" — because
 * a "no such account" branch here is a free list of which addresses are
 * registered.
 */

const requestSchema = z
  .object({
    email: emailSchema,
    turnstileToken: z.string().min(1),
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

  const result = await requestPasswordReset({ baseUrl: apiBaseUrl() }, body.data);
  if (!result.ok) {
    return forwardApiError(result.status, result.error);
  }

  return NextResponse.json(result.data, { status: 202 });
}
