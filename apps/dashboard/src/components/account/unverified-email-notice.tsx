"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";

import { TurnstileWidget, readTurnstileToken } from "@/components/auth/turnstile";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { postJson, type BffError } from "@/lib/bff/client";

/**
 * "Your email is not verified" — and the one control that fixes it.
 *
 * WHAT THIS REPLACES, AND WHY THE CONTROL IS THE POINT. The overview used to
 * paint a bespoke amber block — `border-amber-200 bg-amber-50 text-amber-900`,
 * a fourth notice style in an app that already had three — telling the customer
 * their address was unverified and offering them nothing to do about it. The
 * mail they were waiting on was exactly the mail that was not arriving. A
 * warning with no remedy is the defect; the palette escape was only the part
 * that showed.
 *
 * WHY THIS FILE IS A CLIENT COMPONENT AND `account-overview.tsx` IS NOT. The
 * resend is a POST with three visible outcomes, so it needs state and a submit
 * handler. Keeping the boundary here — rather than on the whole screen — leaves
 * the order rows, the badges and the money server-rendered.
 *
 * ONE NOTICE, THREE STATES, NEVER A STACK OF THEM. The tone carries the
 * outcome and `Notice` owns the live-region split that goes with it: `warning`
 * and `success` announce politely, `danger` interrupts. Rendering the outcome
 * as a SECOND notice under the first would nest one live region inside another
 * and announce the same sentence twice.
 */

/** Same neutral 202 acknowledgement the register and password-reset forms parse. */
const responseSchema = z.object({ status: z.literal("accepted") });

type ResendState =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly kind: "sent" }
  | { readonly kind: "failed"; readonly error: BffError };

export interface UnverifiedEmailNoticeProps {
  /** The address the verification link is sent to. Shown, so a typo is visible. */
  readonly email: string;
}

export function UnverifiedEmailNotice({ email }: UnverifiedEmailNoticeProps) {
  const t = useTranslations("account.overview");
  const tErrors = useTranslations("errors");

  const [state, setState] = useState<ResendState>({ kind: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    // Read the token BEFORE the await: `currentTarget` is nulled once React
    // recycles the synthetic event, so reading it afterwards yields nothing.
    const turnstileToken = readTurnstileToken(event.currentTarget);
    setState({ kind: "sending" });

    const result = await postJson(
      "/api/auth/resend-verification",
      { email, turnstileToken },
      responseSchema,
    );

    setState(result.ok ? { kind: "sent" } : { kind: "failed", error: result.error });
  }

  if (state.kind === "sent") {
    // No resend control here on purpose: the link is in flight and a second
    // press would only invalidate the first one they are about to click.
    return <Notice tone="success">{t("verificationSent")}</Notice>;
  }

  const resend = (
    // A real <form>, not a bare button: `/api/auth/resend-verification`
    // requires a non-empty `turnstileToken`, and `readTurnstileToken` picks the
    // widget's hidden input out of the SURROUNDING form — the same arrangement
    // register and password-reset use. `inline` keeps it inside the sentence.
    <form onSubmit={handleSubmit} className="inline">
      <TurnstileWidget />
      <Button
        type="submit"
        variant="plain"
        // 44pt: this is the customer area, and the control sits in a sentence
        // on a phone. `plain` has no fill, so the height reads as padding
        // around blue text rather than as a box in the middle of a paragraph.
        size="mobile"
        pending={state.kind === "sending"}
        pendingLabel={t("resendingVerification")}
      >
        {t("resendVerification")}
      </Button>
    </form>
  );

  if (state.kind === "failed") {
    return (
      <Notice
        tone="danger"
        title={t("verificationFailed")}
        // The BODY is the CODE looked up in the catalogue, never
        // `error.message` — that string is English written for a log. `t.has`
        // rather than a hand-written map because the `errors` namespace is
        // already total over `ErrorCode`, and RATE_LIMITED is a real outcome
        // here: "wait a moment" is far more actionable than "try again".
        requestId={state.error.requestId}
        action={resend}
      >
        {tErrors.has(state.error.code) ? tErrors(state.error.code) : tErrors("generic")}
      </Notice>
    );
  }

  return (
    <Notice
      tone="warning"
      // The caution symbol carrying the SUBJECT of the caution, as drawn.
      icon="mail-warning"
      title={t("emailUnverified")}
      action={resend}
    >
      {t("emailUnverifiedBody", { email })}
    </Notice>
  );
}
