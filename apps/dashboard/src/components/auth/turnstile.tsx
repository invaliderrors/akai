"use client";

import {
  TurnstileWidget as SharedTurnstileWidget,
  UNCONFIGURED_TURNSTILE_TOKEN,
  readTurnstileToken as readSharedTurnstileToken,
} from "@akai/ui";
import { publicEnv } from "@/lib/env";

/**
 * The dashboard's binding of the shared Turnstile widget (`@akai/ui`) for the
 * endpoints that create an account or send mail (register, resend-verification,
 * password-reset request).
 *
 * The widget renders EXPLICITLY (see `libs/ui/src/turnstile/turnstile-widget.tsx`).
 * This module used implicit rendering via `.cf-turnstile`, which api.js scans for
 * once, on first load — so a form reached by a client-side navigation (sign-in →
 * forgot-password) never got a widget.
 *
 * BEHAVIOUR WHEN UNCONFIGURED. `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is optional
 * outside production, so this renders nothing when it is absent and
 * `readTurnstileToken` returns a placeholder. The API's schema requires a
 * non-empty `turnstileToken`, and its verifier fails OPEN when no secret is set,
 * so a local dev environment works with no Cloudflare account.
 */

export { UNCONFIGURED_TURNSTILE_TOKEN };

export function TurnstileWidget() {
  return (
    <SharedTurnstileWidget
      siteKey={publicEnv.turnstileSiteKey}
      appearance="interaction-only"
      style={{ marginBottom: 16 }}
    />
  );
}

/**
 * Extracts the widget's token from a submitted form.
 *
 * Unlike the storefront, the dashboard still sends the placeholder when the
 * widget is configured but has not solved: the API then rejects it with a clear
 * "bot verification failed". The consumers here type the token as a plain
 * `string`, and changing that is a separate decision from the rendering fix.
 */
export function readTurnstileToken(form: HTMLFormElement): string {
  return (
    readSharedTurnstileToken(form, publicEnv.turnstileSiteKey) ?? UNCONFIGURED_TURNSTILE_TOKEN
  );
}
