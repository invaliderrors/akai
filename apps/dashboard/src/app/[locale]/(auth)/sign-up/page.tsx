import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { SignUpForm } from "@/components/auth/sign-up-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.signUp");
  return { title: t("title") };
}

export default async function SignUpPage() {
  const t = await getTranslations("auth.signUp");

  return (
    <AuthShell
      eyebrow={t("eyebrow")}
      title={t("title")}
      lede={t("lede")}
      footer={
        <>
          {t("haveAccount")}{" "}
          <Link className="link-accent" href="/sign-in">
            {t("signInLink")}
          </Link>
        </>
      }
    >
      <SignUpForm />
    </AuthShell>
  );
}
