"use client";

import { useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { passwordSchema } from "@akai/contracts";
import { Link } from "@/i18n/navigation";
import { postJson, type BffError } from "@/lib/bff/client";
import { Alert, ErrorAlert } from "@/components/ui/alert";
import { TextField } from "@/components/ui/text-field";

const responseSchema = z.object({ status: z.literal("accepted") });

/**
 * Redeems a reset token and sets a new password.
 *
 * The token comes from the emailed link's query string. It is read on the
 * CLIENT and posted in a body rather than being redeemed by the page's server
 * render, for two reasons: a server-side redemption on GET would be consumed by
 * any mail scanner that prefetches the link, and a token in a URL that a server
 * component renders can end up in access logs and `Referer` headers.
 */
export function ResetPasswordForm() {
  const t = useTranslations("auth.resetPassword");
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<BffError | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (token === null || token === "") {
      return;
    }

    if (!passwordSchema.safeParse(password).success) {
      setFieldError(t("tooShort"));
      return;
    }
    if (password !== confirmation) {
      setFieldError(t("mismatch"));
      return;
    }
    setFieldError(null);

    setSubmitting(true);
    setError(null);

    const result = await postJson(
      "/api/auth/password-reset/confirm",
      { token, password },
      responseSchema,
    );

    setSubmitting(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    setDone(true);
  }

  // A link with no token cannot be recovered from by filling in the form, so
  // the form is not offered at all — showing it would let someone type a new
  // password twice before being told it was pointless.
  if (token === null || token === "") {
    return (
      <>
        <Alert tone="error">{t("missingToken")}</Alert>
        <Link className="btn btn--ghost btn--block" href="/forgot-password">
          {t("goToSignIn")}
        </Link>
      </>
    );
  }

  if (done) {
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
    <form onSubmit={handleSubmit} noValidate>
      {error === null ? null : <ErrorAlert error={error} />}

      <TextField
        id="password"
        name="password"
        type="password"
        label={t("newPasswordLabel")}
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        required
        autoFocus
        disabled={submitting}
      />
      <TextField
        id="confirmation"
        name="confirmation"
        type="password"
        label={t("confirmPasswordLabel")}
        value={confirmation}
        onChange={setConfirmation}
        autoComplete="new-password"
        required
        disabled={submitting}
        {...(fieldError === null ? {} : { error: fieldError })}
      />

      <button className="btn btn--primary btn--block" type="submit" disabled={submitting}>
        {submitting ? t("submitting") : t("submit")}
      </button>
    </form>
  );
}
