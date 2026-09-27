import type { Logger } from "@akai/observability";
import { z } from "zod";

import type { CaptchaVerifier } from "./captcha.port";

/**
 * The real Cloudflare Turnstile adapter.
 *
 * `registerRequestSchema` and `requestPasswordResetSchema` in @akai/contracts
 * both REQUIRE a `turnstileToken`. Until this exists, `AlwaysAllowCaptchaVerifier`
 * accepted any string, so the field looked like a control in review while
 * verifying nothing. This POSTs the token to Cloudflare's siteverify endpoint
 * with the secret key and honours the verdict.
 *
 * FAILURE POLICY — an explicit verdict is always honoured; an ABSENT verdict
 * now fails CLOSED, which reverses the original default:
 *  - An explicit `{ success: false }` from Cloudflare (a forged, absent, reused
 *    or expired token) is REJECTED. This is the abuse traffic the control exists
 *    to stop, and it is the overwhelming majority of it. No option changes this.
 *  - A transport failure — timeout, non-2xx, or an unparseable body — is
 *    REJECTED too, and logged.
 *
 * WHY THE REVERSAL, since the original argument was a reasonable one. It ran:
 * captcha is abuse mitigation, not an authorisation control, so coupling a
 * customer's ability to register to Cloudflare's uptime trades a small abuse
 * window for a real outage. That argument does not survive looking at the two
 * URLs. The browser loads the widget from
 * `https://challenges.cloudflare.com/turnstile/v0/api.js`; we verify against
 * `https://challenges.cloudflare.com/turnstile/v0/siteverify`. SAME HOST. When
 * it is unreachable, a legitimate customer has no token to send — the widget
 * never rendered — so failing open admits nobody but the caller who was sending
 * an arbitrary string all along and never loaded the widget. The policy inverts
 * exactly when it is load-bearing, on the endpoints that create an account and
 * mail an address the requester chose.
 *
 * The genuine case for failing open is a ONE-SIDED outage: our egress to
 * Cloudflare broken while customers' browsers reach it fine. That is what
 * `failOpen` is for — an availability trade a call site states explicitly,
 * rather than the default every call site inherits without deciding.
 *
 * NOTE THE OTHER HALF OF THIS CONTROL, which lives in libs/config: when
 * TURNSTILE_SECRET_KEY is unset, neither this class nor its policy is reached at
 * all — the module factories bind `AlwaysAllowCaptchaVerifier` instead. The
 * schema's RESEND_API_KEY-keyed rule is what makes that state unreachable on a
 * deployment that can actually send mail.
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Cloudflare is normally sub-second; cap the wait so a hung request cannot pin a handler. */
const DEFAULT_TIMEOUT_MS = 4_000;

/** Only `success` is load-bearing; the rest of the payload is stripped. */
const siteverifyResponseSchema = z.object({ success: z.boolean() });

export interface TurnstileOptions {
  readonly secretKey: string;
  readonly timeoutMs?: number;
  /**
   * Whether an UNREACHABLE Cloudflare admits the request. Defaults to `false`.
   *
   * Never affects an explicit `{ success: false }`, which is always a rejection.
   * Set it only for a call site that would rather accept abuse than be
   * unavailable, and only knowing that during a Cloudflare-side outage the
   * customers it keeps serving cannot obtain a token anyway.
   */
  readonly failOpen?: boolean;
}

export class TurnstileCaptchaVerifier implements CaptchaVerifier {
  constructor(
    private readonly options: TurnstileOptions,
    private readonly logger: Logger,
  ) {}

  async verify(token: string, remoteIp: string | null): Promise<boolean> {
    // An empty token never round-trips: Cloudflare would reject it anyway, and
    // skipping the call keeps a trivial bot from spending our siteverify budget.
    if (token.trim() === "") {
      return false;
    }

    const form = new URLSearchParams({
      secret: this.options.secretKey,
      response: token,
    });
    if (remoteIp !== null) {
      form.set("remoteip", remoteIp);
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    try {
      const response = await fetch(SITEVERIFY_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
        signal: controller.signal,
      });

      if (!response.ok) {
        return this.unreachable("non-2xx response", { status: response.status });
      }

      const body: unknown = await response.json();
      const parsed = siteverifyResponseSchema.safeParse(body);
      if (!parsed.success) {
        return this.unreachable("unexpected response shape", {});
      }

      return parsed.data.success;
    } catch (cause) {
      return this.unreachable("request failed", {
        err: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * No verdict was obtained. Log it loudly and apply the configured policy.
   *
   * ONE PLACE, so the three ways of not getting an answer cannot drift apart —
   * the previous shape repeated `return true` at each of them, which is how a
   * policy change silently misses one. The log line names the verdict actually
   * applied, because "Turnstile unreachable" alone leaves an operator unable to
   * tell whether registrations are being dropped or waved through.
   */
  private unreachable(reason: string, detail: Record<string, unknown>): boolean {
    const failOpen = this.options.failOpen ?? false;
    this.logger.warn(
      { ...detail, reason, failOpen },
      failOpen
        ? "Turnstile siteverify gave no verdict; failing OPEN — the request is admitted unverified"
        : "Turnstile siteverify gave no verdict; failing CLOSED — the request is rejected",
    );
    return failOpen;
  }
}
