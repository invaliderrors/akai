import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";

/**
 * The two-column frame shared by every auth screen.
 *
 * A server component: it renders no state and reads translations on the server,
 * so none of this markup or copy costs the client a byte. The forms it wraps
 * are the only client components on these pages.
 *
 * The dark brand panel is decorative and hidden below 900px (see globals.css) —
 * on a phone the form is the entire reason for the visit and must be the first
 * thing on screen.
 */

export interface AuthShellProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly lede?: string;
  readonly children: ReactNode;
  /** Secondary links — "create an account", "back to sign in". */
  readonly footer?: ReactNode;
}

export async function AuthShell({ eyebrow, title, lede, children, footer }: AuthShellProps) {
  const t = await getTranslations("auth");
  const tc = await getTranslations("common");

  return (
    <div className="auth">
      <aside className="auth__brand" aria-hidden="true">
        <div className="auth__brand-inner">
          <div className="auth__brand-mark">{tc("brand")}</div>
          <p className="auth__brand-line">{t("brandTagline")}</p>
        </div>
        <div className="auth__brand-foot">ISO 9001 · HPLC ≥ 99% · EU</div>
      </aside>

      <main className="auth__panel">
        <div className="auth__card">
          <header className="auth__head">
            <span className="eyebrow">{eyebrow}</span>
            <h1>{title}</h1>
            {lede === undefined ? null : <p className="lede">{lede}</p>}
          </header>

          {children}

          {footer === undefined ? null : <div className="auth__foot">{footer}</div>}
        </div>
      </main>
    </div>
  );
}
