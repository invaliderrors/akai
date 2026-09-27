import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { emailSchema } from "@akai/contracts";
import { apiBaseUrl } from "@/lib/api/client";
import { resendVerification } from "@/lib/api/auth";
import { csrfFailure, forwardApiError, parseBody } from "@/lib/bff/route";

/** `POST /api/auth/resend-verification` — neutral 202, same as register. */

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

  const result = await resendVerification({ baseUrl: apiBaseUrl() }, body.data);
  if (!result.ok) {
    return forwardApiError(result.status, result.error);
  }

  return NextResponse.json(result.data, { status: 202 });
}
