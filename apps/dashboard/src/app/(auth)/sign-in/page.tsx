import { Suspense } from "react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { AuthShell } from "@/components/auth/auth-shell";
import { SignInForm } from "@/components/auth/sign-in-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.signIn");
  return { title: t("title") };
}

export default async function SignInPage() {
  const t = await getTranslations("auth.signIn");

  return (
    <AuthShell
      eyebrow={t("eyebrow")}
      title={t("title")}
      lede={t("lede")}
      footer={
        <>
          {t("noAccount")}{" "}
          <Link className="link-accent" href="/sign-up">
            {t("createAccount")}
          </Link>
        </>
      }
    >
      {/*
        SignInForm reads `?next=` via useSearchParams, which opts the tree into
        client-side rendering. Without this boundary Next fails the build with
        "useSearchParams should be wrapped in a suspense boundary" rather than
        degrading at runtime.
      */}
      <Suspense fallback={null}>
        <SignInForm />
      </Suspense>
    </AuthShell>
  );
}
