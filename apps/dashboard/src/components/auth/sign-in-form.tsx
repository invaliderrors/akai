"use client";

import { useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { customerSchema } from "@akai/contracts";
import { Link, useRouter } from "@/i18n/navigation";
import { postJson } from "@/lib/bff/client";
import type { BffError } from "@/lib/bff/client";
import { routing } from "@/i18n/routing";
import { sanitiseNextPath } from "@/lib/auth/route-policy";
import { ErrorAlert } from "@/components/ui/alert";
import { TextField } from "@/components/ui/text-field";

/**
 * Sign-in, including the second factor.
 *
 * Two legs in ONE component rather than two routes. The password must be
 * re-sent with the TOTP code (the API's login endpoint is stateless between
 * legs, which is what avoids a half-authenticated server-side state to expire,
 * leak or confuse), so it has to stay in memory. Navigating to a second page
 * would mean either passing the password through a URL or building exactly this
 * state machine anyway, one component further away from the form that owns it.
 */

/** The BFF's response — no tokens, by construction. */
const responseSchema = z.union([
  z.object({ requiresTwoFactor: z.literal(true) }),
  z.object({ requiresTwoFactor: z.literal(false), customer: customerSchema }),
]);

type Stage = "credentials" | "two-factor";

export function SignInForm() {
  const t = useTranslations("auth.signIn");
  const ta = useTranslations("auth");
  const router = useRouter();
  const searchParams = useSearchParams();

  const [stage, setStage] = useState<Stage>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<BffError | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const result = await postJson(
      "/api/auth/login",
      {
        email,
        password,
        // Only ever ONE second-factor field, and only on the second leg. The
        // API's schema is .strict(), so sending an empty string for the unused
        // one is a 400 rather than a harmless no-op.
        ...(stage === "two-factor" && !useRecovery && totpCode !== ""
          ? { totpCode }
          : {}),
        ...(stage === "two-factor" && useRecovery && recoveryCode !== ""
          ? { recoveryCode }
          : {}),
      },
      responseSchema,
    );

    if (!result.ok) {
      setError(result.error);
      setSubmitting(false);
      return;
    }

    if (result.data.requiresTwoFactor) {
      setStage("two-factor");
      setSubmitting(false);
      return;
    }

    // The session cookie is already set by the BFF response. `refresh()` makes
    // the server components re-render with it — without that, the shell would
    // paint from the cached anonymous RSC payload and look signed out.
    const destination = sanitiseNextPath(searchParams.get("next"), routing.locales);
    router.replace(destination);
    router.refresh();
    // `submitting` is deliberately left true: the navigation is in flight and
    // re-enabling the button would invite a second login that orphans the
    // session just created.
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      {error === null ? null : <ErrorAlert error={error} />}

      {stage === "credentials" ? (
        <>
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
          <TextField
            id="password"
            name="password"
            type="password"
            label={ta("passwordLabel")}
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            required
            disabled={submitting}
          />
          <p style={{ margin: "-4px 0 18px", fontSize: 14 }}>
            <Link className="link-accent" href="/forgot-password">
              {t("forgot")}
            </Link>
          </p>
        </>
      ) : (
        <>
          <h2 style={{ fontSize: 18, marginBottom: 6 }}>{t("twoFactorTitle")}</h2>
          <p className="lede" style={{ marginBottom: 18, fontSize: 14.5 }}>
            {t("twoFactorLede")}
          </p>

          {useRecovery ? (
            <TextField
              id="recoveryCode"
              name="recoveryCode"
              label={t("recoveryLabel")}
              value={recoveryCode}
              onChange={setRecoveryCode}
              autoComplete="one-time-code"
              required
              autoFocus
              disabled={submitting}
            />
          ) : (
            <TextField
              id="totpCode"
              name="totpCode"
              label={t("totpLabel")}
              value={totpCode}
              onChange={(next) => setTotpCode(next.replace(/\D/g, "").slice(0, 6))}
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={6}
              inputClassName="input--code"
              required
              autoFocus
              disabled={submitting}
            />
          )}

          <p style={{ margin: "-4px 0 18px", fontSize: 14 }}>
            <button
              type="button"
              className="link-accent"
              style={{ background: "none", border: "none", padding: 0 }}
              onClick={() => {
                setUseRecovery((previous) => !previous);
                setError(null);
              }}
            >
              {useRecovery ? t("useAuthenticator") : t("useRecovery")}
            </button>
          </p>
        </>
      )}

      <button className="btn btn--primary btn--block" type="submit" disabled={submitting}>
        {submitting ? t("submitting") : t("submit")}
      </button>
    </form>
  );
}
