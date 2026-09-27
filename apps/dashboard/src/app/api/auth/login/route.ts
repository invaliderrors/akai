import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { emailSchema, type Customer } from "@akai/contracts";
import { apiBaseUrl } from "@/lib/api/client";
import { login } from "@/lib/api/auth";
import { csrfFailure, forwardApiError, parseBody } from "@/lib/bff/route";
import { writeSession } from "@/lib/session/server";

/**
 * `POST /api/auth/login` — the browser-facing half of the sign-in flow.
 *
 * THE ONE RULE FOR THIS FILE: the token pair the API returns must not appear in
 * the response body. It goes into the sealed cookie and nowhere else. A token
 * in this JSON is a token in the browser's memory, then in a client-side error
 * report, then in an XSS payload.
 */

const requestSchema = z
  .object({
    email: emailSchema,
    // Deliberately NOT `passwordSchema`. The minimum-length policy applies when
    // CHOOSING a password; enforcing it at sign-in would reject a legacy
    // password and, worse, tell an attacker that a short guess was not merely
    // wrong but structurally impossible.
    password: z.string().min(1),
    totpCode: z.string().length(6).optional(),
    recoveryCode: z.string().min(1).max(64).optional(),
  })
  .strict();

/** No tokens. Mirrors `loginResponseSchema` in @akai/contracts. */
type LoginResponseBody =
  | { readonly requiresTwoFactor: true }
  | { readonly requiresTwoFactor: false; readonly customer: Customer };

export async function POST(request: NextRequest): Promise<NextResponse> {
  const csrf = csrfFailure(request);
  if (csrf !== null) {
    return csrf;
  }

  const body = await parseBody(request, requestSchema);
  if (!body.ok) {
    return body.response;
  }

  const result = await login({ baseUrl: apiBaseUrl() }, body.data);
  if (!result.ok) {
    // Forwarded verbatim — including the API's deliberately identical message
    // for "no such account" and "wrong password". Distinguishing them here
    // would rebuild the account-existence oracle the API avoids.
    return forwardApiError(result.status, result.error);
  }

  if (result.data.requiresTwoFactor) {
    // No session is created and no cookie is set on this leg: credentials alone
    // are not authentication when a second factor is enrolled.
    return NextResponse.json<LoginResponseBody>({ requiresTwoFactor: true }, { status: 200 });
  }

  const { customer, tokens } = result.data;

  await writeSession({
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    refreshToken: tokens.refreshToken,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    sessionId: tokens.sessionId,
    customerId: customer.id,
    email: customer.email,
    firstName: customer.firstName,
    role: customer.role,
    emailVerified: customer.emailVerifiedAt !== null,
    twoFactorEnabled: customer.twoFactorEnabled,
  });

  return NextResponse.json<LoginResponseBody>(
    { requiresTwoFactor: false, customer },
    { status: 200 },
  );
}
