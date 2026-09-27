import { Suspense } from "react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AuthShell } from "@/components/auth/auth-shell";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.resetPassword");
  return { title: t("title") };
}

export default async function ResetPasswordPage() {
  const t = await getTranslations("auth.resetPassword");

  return (
    <AuthShell eyebrow={t("eyebrow")} title={t("title")} lede={t("lede")}>
      {/* The reset token lives in the query string; useSearchParams needs a
          suspense boundary to satisfy the static-rendering bailout. */}
      <Suspense fallback={null}>
        <ResetPasswordForm />
      </Suspense>
    </AuthShell>
  );
}
