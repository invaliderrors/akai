import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { emailSchema, localeSchema, passwordSchema } from "@akai/contracts";
import { apiBaseUrl } from "@/lib/api/client";
import { register } from "@/lib/api/auth";
import { csrfFailure, forwardApiError, parseBody } from "@/lib/bff/route";

/**
 * `POST /api/auth/register`
 *
 * A pass-through, and deliberately nothing more. No session is created: the
 * account must be email-verified first, and auto-signing-in an unverified
 * address would let anyone hold a session on a mailbox they do not control.
 *
 * The API answers 202 with the same neutral acknowledgement whether or not the
 * address was already taken, so this handler has nothing to branch on — which
 * is exactly the property that keeps it from becoming an enumeration oracle.
 */

const requestSchema = z
  .object({
    email: emailSchema,
    // The shared policy schema, so the client-side hint, this boundary and the
    // API cannot disagree about what a valid password is.
    password: passwordSchema,
    firstName: z.string().min(1).max(80),
    lastName: z.string().min(1).max(80),
    preferredLocale: localeSchema.default("es"),
    turnstileToken: z.string().min(1),
    marketingConsent: z.boolean().default(false),
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

  const result = await register({ baseUrl: apiBaseUrl() }, body.data);
  if (!result.ok) {
    return forwardApiError(result.status, result.error);
  }

  return NextResponse.json(result.data, { status: 202 });
}
