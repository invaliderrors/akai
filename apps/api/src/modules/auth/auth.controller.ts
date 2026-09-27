import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Customer, Session } from "@akai/contracts";
import { Public } from "../../common/decorators/public.decorator";
import { AuthService, serialiseTokens } from "./auth.service";
import { AUTH_RATE_LIMITS } from "./auth.policy";
import type { RequestContext } from "./auth.types";
import { RateLimit } from "./guards/rate-limit.guard";
import { extractClientIp } from "./guards/rate-limit.guard";
import { Roles } from "./guards/roles.guard";
import { CurrentUser, type Principal } from "./security/principal";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { CAPTCHA_VERIFIER, type CaptchaVerifier } from "./ports/captcha.port";
import {
  changePasswordSchema,
  confirmPasswordResetSchema,
  confirmTotpSchema,
  disableTotpSchema,
  loginBodySchema,
  logoutBodySchema,
  refreshBodySchema,
  registerRequestSchema,
  requestLoginCodeSchema,
  requestPasswordResetSchema,
  resendVerificationSchema,
  verifyEmailSchema,
  verifyLoginCodeSchema,
  type Acknowledgement,
  type AuthTokens,
  type ConfirmTotpBody,
  type DisableTotpBody,
  type LoginBody,
  type LoginResult,
  type LogoutBody,
  type RefreshBody,
  type RequestLoginCodeBody,
  type ResendVerificationBody,
  type VerifyLoginCodeBody,
} from "./dto/auth.dto";
import type { z } from "zod";

type RegisterBody = z.infer<typeof registerRequestSchema>;
type PasswordResetRequestBody = z.infer<typeof requestPasswordResetSchema>;
type PasswordResetConfirmBody = z.infer<typeof confirmPasswordResetSchema>;
type ChangePasswordBody = z.infer<typeof changePasswordSchema>;
type VerifyEmailBody = z.infer<typeof verifyEmailSchema>;

/**
 * The auth HTTP surface.
 *
 * Routes carrying `@Public()` are reachable without a session; everything else
 * is rejected by the global JwtAuthGuard before it reaches a handler. That
 * default is why the unauthenticated routes are the ones that need a marker —
 * the risky mistake (forgetting to protect something) is not expressible.
 *
 * Note what is NOT here: no cookie is ever set. Spec §8 puts session-cookie
 * management in the dashboard's BFF route handlers, which hold the token pair
 * server-side. This API speaks bearer tokens to that BFF and nothing else, so
 * there is exactly one place in the platform that knows how a browser session
 * is represented.
 */
@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(CAPTCHA_VERIFIER) private readonly captcha: CaptchaVerifier,
  ) {}

  // -------------------------------------------------------------------------
  // Registration and verification
  // -------------------------------------------------------------------------

  @Public()
  @RateLimit({ name: "register", ...AUTH_RATE_LIMITS.register })
  @Post("register")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Register a customer",
    description:
      "Always returns the same acknowledgement, whether or not the address was already taken. This is deliberate: a distinguishable response would make the endpoint an account-existence oracle.",
  })
  async register(
    @Body(new ZodValidationPipe(registerRequestSchema)) body: RegisterBody,
    @Req() request: unknown,
  ): Promise<Acknowledgement> {
    await this.assertHuman(body.turnstileToken, request);

    return this.auth.register({
      email: body.email,
      password: body.password,
      firstName: body.firstName,
      lastName: body.lastName,
      preferredLocale: body.preferredLocale,
      marketingConsent: body.marketingConsent,
    });
  }

  @Public()
  @RateLimit({ name: "verifyEmail", ...AUTH_RATE_LIMITS.verifyEmail })
  @Post("verify-email")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Redeem an email-verification token" })
  async verifyEmail(
    @Body(new ZodValidationPipe(verifyEmailSchema)) body: VerifyEmailBody,
  ): Promise<Acknowledgement> {
    return this.auth.verifyEmail(body.token);
  }

  @Public()
  @RateLimit({ name: "resendVerification", ...AUTH_RATE_LIMITS.resendVerification })
  @Post("resend-verification")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: "Re-send the verification email (neutral response)" })
  async resendVerification(
    @Body(new ZodValidationPipe(resendVerificationSchema)) body: ResendVerificationBody,
    @Req() request: unknown,
  ): Promise<Acknowledgement> {
    await this.assertHuman(body.turnstileToken, request);
    return this.auth.resendVerification(body.email);
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  @Public()
  @RateLimit({ name: "login", ...AUTH_RATE_LIMITS.login })
  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Authenticate",
    description:
      "Returns either a token pair or `requiresTwoFactor: true`. The token pair is for the dashboard BFF to hold server-side; it must never be forwarded to a browser.",
  })
  async login(
    @Body(new ZodValidationPipe(loginBodySchema)) body: LoginBody,
    @Req() request: unknown,
  ): Promise<LoginResult> {
    return this.auth.login(body, requestContext(request));
  }

  /**
   * EMAILED SIGN-IN CODES — two legs, both public.
   *
   * Note the absence of `@RateLimit`: that decorator feeds `AuthRateLimitGuard`,
   * which keys on the socket address, and every customer reaches this API
   * through the Next BFF — so it would put the whole user base in one bucket and
   * turn a spent budget into a platform-wide sign-in outage. Both routes are
   * throttled per ADDRESS inside `AuthService` instead
   * (`AUTH_RATE_LIMITS.loginCodeRequest` / `.loginCodeVerify`), which is the only
   * key here that cannot lock everyone out at once. See auth.policy.ts.
   */
  @Public()
  @Post("login-code/request")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Mail a one-time sign-in code (neutral response)",
    description:
      "Returns the same acknowledgement whether or not the address has an account, and spends comparable work either way. A distinguishable response — or a distinguishable latency — would make this an account-existence oracle.",
  })
  async requestLoginCode(
    @Body(new ZodValidationPipe(requestLoginCodeSchema)) body: RequestLoginCodeBody,
    @Req() request: unknown,
  ): Promise<Acknowledgement> {
    await this.assertHuman(body.turnstileToken, request);
    return this.auth.issueEmailOtp(body.email);
  }

  @Public()
  @Post("login-code/verify")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Redeem a one-time sign-in code",
    description:
      "Returns the SAME shape as POST /auth/login — either a token pair for the BFF to hold server-side, or `requiresTwoFactor: true` when the account has TOTP enrolled, in which case the client re-posts `loginCode` together with `totpCode`. An ADMIN that has never enrolled a second factor is refused outright.",
  })
  async verifyLoginCode(
    @Body(new ZodValidationPipe(verifyLoginCodeSchema)) body: VerifyLoginCodeBody,
    @Req() request: unknown,
  ): Promise<LoginResult> {
    return this.auth.consumeEmailOtp(body, requestContext(request));
  }

  @Public()
  @RateLimit({ name: "refresh", ...AUTH_RATE_LIMITS.refresh })
  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Rotate a refresh token",
    description:
      "Public because the access token is, by definition, expired at this point. The refresh token itself is the credential. Presenting a previously-used token revokes the entire family.",
  })
  async refresh(
    @Body(new ZodValidationPipe(refreshBodySchema)) body: RefreshBody,
    @Req() request: unknown,
  ): Promise<{ tokens: AuthTokens }> {
    const pair = await this.auth.refresh(body.refreshToken, requestContext(request));
    return { tokens: serialiseTokens(pair) };
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Revoke the current session, or every session" })
  async logout(
    @CurrentUser() user: Principal,
    @Body(new ZodValidationPipe(logoutBodySchema)) body: LogoutBody,
  ): Promise<Acknowledgement> {
    return this.auth.logout(toAuthenticatedUser(user), body);
  }

  @Get("me")
  @ApiOperation({ summary: "The signed-in customer" })
  async me(@CurrentUser() user: Principal): Promise<Customer> {
    return this.auth.currentCustomer(toAuthenticatedUser(user));
  }

  @Get("sessions")
  @ApiOperation({ summary: "List this customer's active sessions" })
  async sessions(@CurrentUser() user: Principal): Promise<Session[]> {
    const records = await this.auth.listSessions(toAuthenticatedUser(user));
    return records.map((record) => ({
      id: record.id,
      createdAt: record.createdAt.toISOString(),
      lastSeenAt: record.lastSeenAt.toISOString(),
      expiresAt: record.expiresAt.toISOString(),
      ipAddress: record.ipAddress,
      userAgent: record.userAgent,
      isCurrent: record.id === user.sessionId,
    }));
  }

  @Delete("sessions/:id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Revoke one of this customer's sessions" })
  async revokeSession(
    @CurrentUser() user: Principal,
    @Param("id", new ParseUUIDPipe()) sessionId: string,
  ): Promise<Acknowledgement> {
    return this.auth.revokeSession(toAuthenticatedUser(user), sessionId);
  }

  // -------------------------------------------------------------------------
  // Passwords
  // -------------------------------------------------------------------------

  @Public()
  @RateLimit({ name: "passwordResetRequest", ...AUTH_RATE_LIMITS.passwordResetRequest })
  @Post("password-reset/request")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: "Request a reset link (neutral response)" })
  async requestPasswordReset(
    @Body(new ZodValidationPipe(requestPasswordResetSchema)) body: PasswordResetRequestBody,
    @Req() request: unknown,
  ): Promise<Acknowledgement> {
    await this.assertHuman(body.turnstileToken, request);
    return this.auth.requestPasswordReset(body.email);
  }

  @Public()
  @RateLimit({ name: "passwordResetConfirm", ...AUTH_RATE_LIMITS.passwordResetConfirm })
  @Post("password-reset/confirm")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Redeem a reset token and set a new password" })
  async confirmPasswordReset(
    @Body(new ZodValidationPipe(confirmPasswordResetSchema)) body: PasswordResetConfirmBody,
  ): Promise<Acknowledgement> {
    return this.auth.confirmPasswordReset({ token: body.token, password: body.password });
  }

  @Post("password/change")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Change password (signs out every other device)" })
  async changePassword(
    @CurrentUser() user: Principal,
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordBody,
  ): Promise<Acknowledgement> {
    return this.auth.changePassword(toAuthenticatedUser(user), {
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
    });
  }

  // -------------------------------------------------------------------------
  // Two-factor
  // -------------------------------------------------------------------------

  @Post("2fa/enrol")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Begin TOTP enrolment",
    description: "Returns a secret and QR URI. Nothing is stored until confirmed.",
  })
  async beginTotpEnrolment(
    @CurrentUser() user: Principal,
  ): Promise<{ secret: string; keyUri: string }> {
    return this.auth.beginTotpEnrolment(toAuthenticatedUser(user));
  }

  @RateLimit({ name: "totp", ...AUTH_RATE_LIMITS.totp })
  @Post("2fa/confirm")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Confirm TOTP enrolment",
    description: "Returns the recovery codes. They are shown exactly once.",
  })
  async confirmTotpEnrolment(
    @CurrentUser() user: Principal,
    @Body(new ZodValidationPipe(confirmTotpSchema)) body: ConfirmTotpBody,
  ): Promise<{ recoveryCodes: string[] }> {
    return this.auth.confirmTotpEnrolment(toAuthenticatedUser(user), body);
  }

  @Post("2fa/disable")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Disable TOTP (re-authenticates with the password)" })
  async disableTotp(
    @CurrentUser() user: Principal,
    @Body(new ZodValidationPipe(disableTotpSchema)) body: DisableTotpBody,
  ): Promise<Acknowledgement> {
    return this.auth.disableTotp(toAuthenticatedUser(user), body);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Bot check for the three endpoints that either create an account or send
   * mail. Silently passing when unconfigured is the documented default of
   * AlwaysAllowCaptchaVerifier; see that file for why it fails open.
   */
  private async assertHuman(token: string, request: unknown): Promise<void> {
    const human = await this.captcha.verify(token, extractClientIp(request));
    if (!human) {
      // The neutral acknowledgement path is deliberately NOT used here: a
      // failed captcha is a transport-level rejection that reveals nothing
      // about whether any account exists.
      throw new BadRequestException("Bot verification failed");
    }
  }
}

/**
 * The principal carries everything the service needs EXCEPT email and verified
 * status, which the service re-reads from the database anyway. Reconstructing
 * the internal shape here keeps `Principal` (the wire contract other modules
 * consume) minimal.
 */
function toAuthenticatedUser(principal: Principal): {
  customerId: string;
  sessionId: string;
  role: Principal["role"];
  email: string;
  emailVerified: boolean;
  twoFactorAssertedAt: Date | null;
} {
  return {
    customerId: principal.customerId,
    sessionId: principal.sessionId,
    role: principal.role,
    // Not carried on the principal. Every service method that needs the real
    // value re-reads the customer row, so a placeholder here is never consulted
    // for a security decision.
    email: "",
    emailVerified: false,
    twoFactorAssertedAt:
      principal.twoFactorAssertedAt === null
        ? null
        : new Date(principal.twoFactorAssertedAt),
  };
}

function requestContext(request: unknown): RequestContext {
  return {
    ipAddress: extractClientIp(request),
    userAgent: extractUserAgent(request),
  };
}

function extractUserAgent(request: unknown): string | null {
  if (typeof request !== "object" || request === null || !("headers" in request)) {
    return null;
  }
  const { headers } = request;
  if (typeof headers !== "object" || headers === null || !("user-agent" in headers)) {
    return null;
  }
  const agent = headers["user-agent"];
  // Truncated to the column width. An over-long header must not turn a login
  // into a database error.
  return typeof agent === "string" ? agent.slice(0, 512) : null;
}

export { Roles };
