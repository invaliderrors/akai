"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { postJson, type BffError } from "@/lib/bff/client";
import { Alert, ErrorAlert } from "@/components/ui/alert";
import { TextField } from "@/components/ui/text-field";
import { TurnstileWidget, readTurnstileToken } from "./turnstile";

const responseSchema = z.object({ status: z.literal("accepted") });

/**
 * Password-reset request.
 *
 * The success state is NEUTRAL and unconditional: "if an account exists for
 * that address, we sent a link". Never "we sent an email to you" — that
 * confirms the address is registered, and this endpoint is unauthenticated, so
 * anyone could walk a list through it.
 */
export function ForgotPasswordForm() {
  const t = useTranslations("auth.forgotPassword");
  const ta = useTranslations("auth");

  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<BffError | null>(null);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const result = await postJson(
      "/api/auth/password-reset/request",
      { email, turnstileToken: readTurnstileToken(event.currentTarget) },
      responseSchema,
    );

    setSubmitting(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    setSubmitted(true);
  }

  if (submitted) {
    return (
      <Alert tone="ok">
        <strong style={{ display: "block", marginBottom: 4 }}>{t("successTitle")}</strong>
        {t("successBody")}
      </Alert>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      {error === null ? null : <ErrorAlert error={error} />}

      <TextField
        id="email"
        name="email"
        type="email"
        label={ta("emailLabel")}
        value={email}
        onChange={setEmail}
        autoComplete="email"
        inputMode="email"
        required
        autoFocus
        disabled={submitting}
      />

      <TurnstileWidget />

      <button className="btn btn--primary btn--block" type="submit" disabled={submitting}>
        {submitting ? t("submitting") : t("submit")}
      </button>
    </form>
  );
}
