import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import type { BffError } from "@/lib/bff/client";

import { Notice, type NoticeTone } from "./notice";

/**
 * The auth screens' banner — now a COMPATIBILITY ADAPTER over `ui/notice.tsx`.
 *
 * WHY THIS FILE STILL EXISTS. All five callers are auth screens that the
 * redesign deliberately does not touch, and auth is the surface where a
 * mistake locks people out rather than merely looking wrong. So the API stays
 * byte-for-byte — `Alert({ tone, children, requestId? })` and
 * `ErrorAlert({ error })` — and the body becomes one `Notice`. Zero auth files
 * change and there is one inline-feedback component in the dashboard.
 *
 * THE TONE NAMES ARE NOT THE KIT'S, AND THAT IS THE POINT. `error | ok | info`
 * is what the auth screens spell; `danger | success | progress` is what the kit
 * paints. Mapping them here rather than renaming five call sites is the whole
 * job of an adapter.
 *
 * `info` MAPS TO `progress`, NOT TO A FOURTH GREY TONE. Its only caller is
 * `verify-email-panel`, and its only content is "estamos verificando tu
 * correo…" while a request is in flight — which is exactly what `progress`
 * draws, spinner and all. A static blue bar under a spinner-shaped sentence
 * was the old approximation, not the intent.
 *
 * NO `"use client"`. There is no state and no browser API here, and `Notice`
 * makes the same call for the same reason. Every caller is a client component
 * already, so this module joins their graph when they import it.
 */

export type AlertTone = "error" | "ok" | "info";

/**
 * Total over the legacy union, so a sixth auth tone would be a compile error
 * here rather than an unstyled bar on the sign-in screen.
 */
const TONE: Readonly<Record<AlertTone, NoticeTone>> = {
  error: "danger",
  ok: "success",
  info: "progress",
};

export interface AlertProps {
  readonly tone: AlertTone;
  readonly children: ReactNode;
  /** Quotable support reference. Rendered small, below the message. */
  readonly requestId?: string;
}

/**
 * `role="alert"` on failures only — carried by `Notice`, which owns the split.
 *
 * An assertive live region interrupts a screen reader immediately. That is
 * right for "your password was rejected" and wrong for a confirmation the user
 * will reach by reading on — over-using it trains people to ignore it. The
 * mapping above is what keeps that promise: `error` is the only tone that
 * lands on a `danger` notice, and `danger` is the only notice that interrupts.
 */
export function Alert({ tone, children, requestId }: AlertProps) {
  return (
    <Notice
      tone={TONE[tone]}
      // `.alert` carried `margin-bottom: 18px`, and the auth screens stack a
      // banner straight onto a form with no spacing container of their own.
      // The kit's Notice owns no outer margin, so the adapter supplies the one
      // the five out-of-scope screens were drawn with.
      className="mb-[18px]"
      {...(requestId === undefined ? {} : { requestId })}
    >
      {children}
    </Notice>
  );
}

export interface ErrorAlertProps {
  readonly error: BffError;
}

/**
 * Turns a BFF failure into a translated, user-facing alert.
 *
 * The message comes from the CATALOGUE keyed by the machine-readable `code`,
 * not from `error.message`. The API's message is English, written for an
 * operator, and may name internal concepts; a Spanish-default storefront cannot
 * surface it. `VALIDATION_FAILED` is the exception — its field errors are
 * rendered by the individual inputs, so the banner stays generic.
 *
 * `BffError`, not `ApiError`: this is the error the BFF route handlers return,
 * and it is a different type in a different module from the account area's.
 */
export function ErrorAlert({ error }: ErrorAlertProps) {
  const t = useTranslations("errors");
  const message = t.has(error.code) ? t(error.code) : t("generic");

  return (
    <Alert tone="error" requestId={error.requestId}>
      {message}
    </Alert>
  );
}
