/**
 * Bot protection, behind a port.
 *
 * `registerRequestSchema` and `requestPasswordResetSchema` in @akai/contracts
 * both REQUIRE a `turnstileToken`, so something has to check it — a required
 * field that is never verified is worse than no field, because it looks like a
 * control in review.
 *
 * The real Cloudflare adapter (a POST to siteverify with TURNSTILE_SECRET_KEY)
 * is a followUp: it belongs with the other outbound HTTP adapters and needs a
 * timeout/failure policy decided alongside them.
 */
export interface CaptchaVerifier {
  verify(token: string, remoteIp: string | null): Promise<boolean>;
}

export const CAPTCHA_VERIFIER = Symbol("CAPTCHA_VERIFIER");

/**
 * Default binding for environments with no TURNSTILE_SECRET_KEY configured
 * (local dev, tests, CI).
 *
 * Fails OPEN, and that is a deliberate, bounded choice rather than an
 * oversight: captcha is an abuse-mitigation layer, not an authorisation
 * control, and the endpoints it guards are independently protected by rate
 * limiting and account lockout. Failing closed instead would make every
 * developer machine unable to register a user.
 *
 * The guard against this shipping to production silently is in libs/config —
 * add TURNSTILE_SECRET_KEY to the production cross-field checks when the real
 * adapter lands (followUps).
 */
export class AlwaysAllowCaptchaVerifier implements CaptchaVerifier {
  verify(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
