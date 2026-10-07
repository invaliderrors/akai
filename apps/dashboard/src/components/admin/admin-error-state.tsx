import { authFailureReasonSchema } from "@akai/contracts";
import { useTranslations } from "next-intl";

import { buttonClassName } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { ErrorState, type StateDensity } from "@/components/ui/states";
import Link from "next/link";
import { AdminApiError } from "@/lib/admin/http";

/**
 * The failure state for an admin page load.
 *
 * IT EXISTS BECAUSE `FORBIDDEN` IS THREE DIFFERENT SITUATIONS. Admin routes
 * require a second factor proved within the last 15 minutes, so a working
 * session goes stale while the operator is simply reading a page. Before this,
 * every admin page caught the failure and rendered `cause.message` — the API's
 * own English ("Two-factor authentication required"), with no way to act on it.
 * Two rules were broken at once: a server-authored message reached an operator,
 * and the one error the API explicitly designed to be ACTIONABLE was shown as a
 * dead end.
 *
 * The distinction cannot come from the code — all three are `FORBIDDEN`. It
 * comes from the envelope's `reason`, parsed against a closed enum so an
 * unrecognised value degrades to the generic failure rather than throwing.
 *
 * WHAT THE REDESIGN CHANGED, and what it deliberately did not:
 *
 * - The two hand-rolled amber `<div>`s are now `ui/notice`, and the generic
 *   branch is `ui/states`' `ErrorState` — the same two components the customer
 *   half of the product fails with. There is no admin-only error paint left.
 * - The interrupts are `danger`, NOT the amber they were drawn as. `Notice`
 *   binds `role="alert"` to `danger` and to nothing else (see its `TONE` table,
 *   pinned in `notice.test.tsx`), and assertive announcement is the property
 *   that matters here: this panel appears INSTEAD of the page the operator
 *   asked for. `account-error-panel.tsx` answered the identical question — a
 *   dead session with a sign-in link — the same way and for the same reason, so
 *   the two halves of the product now fail alike.
 * - The enrolment branch no longer LINKS to /security. That page holds a
 *   password form and a read-only "two-step: on/off" row; it cannot enrol an
 *   authenticator, and it says so in its own header comment. A button to a
 *   screen that cannot do the thing is worse than the sentence that names it.
 * - `cause.message` is still never rendered, on any branch. `ErrorState`'s
 *   `audience="admin"` exists to carry an upstream string, and this component
 *   deliberately supplies none: the only string in hand is the API's own log
 *   line, which is precisely the leak this file was written to stop. The
 *   reader's sentence comes from the `errors` namespace keyed by the closed
 *   `ErrorCode` instead — which is also why the plain-permission branch reads
 *   "you do not have permission" rather than a generic shrug.
 */

export interface AdminErrorStateProps {
  /** Whatever the page caught. Deliberately `unknown`: it is external data. */
  readonly cause: unknown;
  /** What failed, in the page's own words, e.g. "Products could not be loaded". */
  readonly title: string;
  /**
   * `page` by default, because this stands in for the whole view: the table,
   * its filters and its column headings are all gone. A page that keeps its
   * headings above the failure passes `"table"` for the quieter size.
   */
  readonly density?: StateDensity;
}

export function AdminErrorState({ cause, title, density = "page" }: AdminErrorStateProps) {
  const t = useTranslations("admin.common");

  const reason =
    cause instanceof AdminApiError ? authFailureReasonSchema.safeParse(cause.reason) : null;
  const requestId = cause instanceof AdminApiError ? cause.requestId : null;

  if (reason !== null && reason.success && reason.data === "TWO_FACTOR_REQUIRED") {
    return (
      <Notice
        tone="danger"
        title={t("twoFactorTitle")}
        action={
          <Link
            href="/sign-in"
            // `plain` and 28pt: the way back reads as blue text inside the
            // sentence, at the admin surface's own control height. A filled
            // button on its own row — what this used to be — reads as a second
            // decision beside a message that only offers one.
            className={buttonClassName({ variant: "plain", size: "compact" })}
          >
            {t("twoFactorAction")}
          </Link>
        }
        {...(requestId === null || requestId === "" ? {} : { requestId })}
      >
        {t("twoFactorBody")}
      </Notice>
    );
  }

  if (reason !== null && reason.success && reason.data === "TWO_FACTOR_ENROLMENT_REQUIRED") {
    return (
      // NO action. An account with no second factor cannot fix itself from any
      // screen this application ships, and "sign in again" would loop it — the
      // same dead end the plain-permission branch below is careful about.
      <Notice
        tone="danger"
        title={t("enrolmentTitle")}
        {...(requestId === null || requestId === "" ? {} : { requestId })}
      >
        {t("enrolmentBody")}
      </Notice>
    );
  }

  // Everything else, including a genuine permission failure, which is a dead end
  // by design: offering "sign in again" there would loop the operator forever.
  return (
    <ErrorState
      title={title}
      // `UNPARSEABLE_RESPONSE` is this client's own sentinel for a body that did
      // not match the error envelope, not a platform `ErrorCode`, so it has no
      // catalogue leaf. Folding it into `INTERNAL_ERROR` is honest — the server
      // sent something we could not read — and narrows the union without a cast.
      code={
        cause instanceof AdminApiError && cause.code !== "UNPARSEABLE_RESPONSE"
          ? cause.code
          : "INTERNAL_ERROR"
      }
      requestId={requestId === "" ? null : requestId}
      // Declares who is reading, and is the branch that MAY carry the upstream
      // string. `detail` is withheld on purpose — see the header note.
      audience="admin"
      density={density}
    />
  );
}
