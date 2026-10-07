import { Suspense } from "react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AuthShell } from "@/components/auth/auth-shell";
import { VerifyEmailPanel } from "@/components/auth/verify-email-panel";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.verifyEmail");
  return { title: t("title") };
}

/**
 * Reachable signed in OR signed out (see `PUBLIC_PREFIXES` in route-policy):
 * the link is clicked from a mail client that may already hold a session, and
 * bouncing that user away would leave the address permanently unverified.
 */
export default async function VerifyEmailPage() {
  const t = await getTranslations("auth.verifyEmail");

  return (
    <AuthShell eyebrow={t("eyebrow")} title={t("title")}>
      <Suspense fallback={null}>
        <VerifyEmailPanel />
      </Suspense>
    </AuthShell>
  );
}
