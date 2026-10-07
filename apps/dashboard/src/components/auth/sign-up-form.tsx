"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { passwordSchema } from "@akai/contracts";
import { postJson, type BffError } from "@/lib/bff/client";
import { Alert, ErrorAlert } from "@/components/ui/alert";
import { TextField } from "@/components/ui/text-field";
import { TurnstileWidget, readTurnstileToken } from "./turnstile";

const responseSchema = z.object({ status: z.literal("accepted") });

/**
 * Registration.
 *
 * On success this renders a NEUTRAL confirmation — "if that address can be
 * registered, we've sent a link" — because the API returns the same 202 whether
 * or not the address was already taken. Rendering "account created!" for one
 * case and an error for the other would reconstruct, in the UI, the exact
 * account-existence oracle the API was designed to avoid.
 *
 * No session is created here either: the address must be verified first.
 */
export function SignUpForm() {
  const t = useTranslations("auth.signUp");
  const ta = useTranslations("auth");

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<BffError | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    // Checked client-side with the SHARED schema so the rule cannot drift from
    // the server's. This is a convenience, not a control: the API validates the
    // same schema again, because anything checked only in a browser is not
    // checked at all.
    const policy = passwordSchema.safeParse(password);
    if (!policy.success) {
      setPasswordError(t("passwordHint"));
      return;
    }
    setPasswordError(null);

    setSubmitting(true);
    setError(null);

    const result = await postJson(
      "/api/auth/register",
      {
        email,
        password,
        firstName,
        lastName,
        turnstileToken: readTurnstileToken(event.currentTarget),
        marketingConsent,
      },
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

      <div className="grid-2">
        <TextField
          id="firstName"
          name="firstName"
          label={t("firstNameLabel")}
          value={firstName}
          onChange={setFirstName}
          autoComplete="given-name"
          required
          autoFocus
          disabled={submitting}
        />
        <TextField
          id="lastName"
          name="lastName"
          label={t("lastNameLabel")}
          value={lastName}
          onChange={setLastName}
          autoComplete="family-name"
          required
          disabled={submitting}
        />
      </div>

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
        disabled={submitting}
      />

      <TextField
        id="password"
        name="password"
        type="password"
        label={ta("passwordLabel")}
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        hint={t("passwordHint")}
        required
        disabled={submitting}
        {...(passwordError === null ? {} : { error: passwordError })}
      />

      <label className="check">
        <input
          type="checkbox"
          checked={marketingConsent}
          onChange={(event) => setMarketingConsent(event.target.checked)}
          disabled={submitting}
        />
        {/* Unchecked by default and never bundled with the terms: GDPR consent
            must be a separate, affirmative act. */}
        <span>{t("marketingLabel")}</span>
      </label>

      <TurnstileWidget />

      <button className="btn btn--primary btn--block" type="submit" disabled={submitting}>
        {submitting ? t("submitting") : t("submit")}
      </button>
    </form>
  );
}
