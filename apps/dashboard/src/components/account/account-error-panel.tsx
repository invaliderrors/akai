import { useTranslations } from "next-intl";

import { PageTemplate } from "@/components/shell/page-template";
import { buttonClassName } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { ErrorState } from "@/components/ui/states";
import { Link } from "@/i18n/navigation";
import type { ApiError } from "@/lib/api/errors";

/**
 * A page-level failure, with the page's own heading kept above it.
 *
 * KEEPING THE HEADING IS THE WHOLE POINT. Replacing the view with a bare red
 * box loses the customer's sense of where they are; "Pedidos — no hemos podido
 * cargar esta información" is a far better failure than an unlabelled error.
 * So this brings its own `PageTemplate`, and the seven pages that render it do
 * NOT wrap it — exactly one template renders whichever branch a page takes,
 * which is the same arrangement `AccountOverview` documents on the success
 * side.
 *
 * NO `"use client"` ANY MORE. The old rationale — "server components cannot use
 * `useTranslations`" — was simply wrong: `next-intl` ships a `react-server`
 * condition, so the hook resolves to the RSC implementation here and to the
 * context hook when a test pulls this module into a client bundle. Nothing on
 * this screen holds state; the one piece that does (the request-id copy button
 * inside `ErrorState`) carries its own boundary.
 *
 * `width="reading"`, hardcoded rather than taken as a prop, even though the
 * orders page is a table screen: what failed to load is not on the page any
 * more, and a 30ch sentence centred in a 1240px measure is a sentence adrift.
 */

export interface AccountErrorPanelProps {
  /** The page's own title, already translated. Becomes the `<h1>`. */
  readonly title: string;
  /**
   * Always a well-formed `ApiError` — the shared client synthesises one even
   * for failures that never reached the API (DNS, TLS, a proxy's HTML 502), so
   * this never has to ask "is this an envelope or a network error?".
   */
  readonly error: ApiError;
}

export function AccountErrorPanel({ title, error }: AccountErrorPanelProps) {
  const t = useTranslations("account.common");

  return (
    <PageTemplate width="reading" title={title}>
      {error.code === "UNAUTHENTICATED" ? (
        /*
         * The session died with the page open, and this branch exists because
         * `ErrorState` structurally cannot say so. It resolves its cause
         * sentence from the `errors` namespace keyed by the code, and
         * `errors.UNAUTHENTICATED` is the SIGN-IN phrasing — "Correo o
         * contraseña incorrectos." Under "Tu sesión ha caducado" that sends a
         * customer off to reset a password that is perfectly good. `Notice` is
         * the kit's carrier for a title and a body the caller supplies, its
         * `danger` tone is the same `role="alert"`, and it is the shape
         * `profile-form` already uses for this exact code.
         */
        <Notice
          tone="danger"
          title={t("sessionExpiredTitle")}
          // Empty for failures that never reached the API; `Notice` drops the
          // reference line rather than printing "Referencia:" with nothing
          // after it, which only invites a support call that starts blank.
          requestId={error.requestId}
          action={
            <Link
              href="/sign-in"
              // `plain` has no fill and `mobile` is the 44pt customer control,
              // so the way out reads as blue text inside the sentence rather
              // than as a box dropped into the middle of a paragraph — the
              // same treatment the resend control gets.
              className={buttonClassName({ variant: "plain", size: "mobile" })}
            >
              {t("signIn")}
            </Link>
          }
        >
          {t("sessionExpiredBody")}
        </Notice>
      ) : (
        <ErrorState
          title={t("errorTitle")}
          // The CODE, never `error.message`: that string is English written for
          // a log, and `ErrorState` looks the cause up from the closed enum.
          code={error.code}
          requestId={error.requestId === "" ? null : error.requestId}
        />
      )}
    </PageTemplate>
  );
}
