"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { z } from "zod";
import Link from "next/link";
import { postJson } from "@/lib/bff/client";
import { Alert } from "@/components/ui/alert";

const responseSchema = z.object({ status: z.literal("accepted") });

type State = "verifying" | "verified" | "failed" | "missing-token";

/**
 * Redeems an email-verification token.
 *
 * The emailed link is a GET to this page; the page then POSTs the token. That
 * indirection is deliberate — mail clients and corporate link scanners prefetch
 * URLs, and a GET that consumed the single-use token would be spent before the
 * recipient ever clicked, presenting them with "this link has expired" on a
 * link they never opened.
 */
export function VerifyEmailPanel() {
  const t = useTranslations("auth.verifyEmail");
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [state, setState] = useState<State>(token === null ? "missing-token" : "verifying");

  /**
   * React 18+ mounts effects twice in development StrictMode. Without this
   * guard the token would be redeemed twice, the second attempt would correctly
   * fail as already-used, and the UI would show an error for a verification
   * that in fact succeeded — a bug that only ever reproduces in development.
   */
  const attempted = useRef(false);

  useEffect(() => {
    if (token === null || token === "" || attempted.current) {
      return;
    }
    attempted.current = true;

    let cancelled = false;

    void postJson("/api/auth/verify-email", { token }, responseSchema).then((result) => {
      if (!cancelled) {
        setState(result.ok ? "verified" : "failed");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state === "missing-token") {
    return <Alert tone="error">{t("missingToken")}</Alert>;
  }

  if (state === "verifying") {
    return (
      <Alert tone="info">
        <span aria-live="polite">{t("verifying")}</span>
      </Alert>
    );
  }

  if (state === "verified") {
    return (
      <>
        <Alert tone="ok">
          <strong style={{ display: "block", marginBottom: 4 }}>{t("successTitle")}</strong>
          {t("successBody")}
        </Alert>
        <Link className="btn btn--primary btn--block" href="/sign-in">
          {t("goToSignIn")}
        </Link>
      </>
    );
  }

  return (
    <>
      <Alert tone="error">
        <strong style={{ display: "block", marginBottom: 4 }}>{t("failureTitle")}</strong>
        {t("failureBody")}
      </Alert>
      <Link className="btn btn--ghost btn--block" href="/sign-in">
        {t("goToSignIn")}
      </Link>
    </>
  );
}
