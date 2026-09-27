"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import type { Customer } from "@akai/contracts";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { GroupedList, ValueRow } from "@/components/ui/grouped-list";
import { Notice } from "@/components/ui/notice";
import { StatusBadge } from "@/components/ui/status-badge";
import { TurnstileWidget, readTurnstileToken } from "@/components/auth/turnstile";
import { postJson } from "@/lib/bff/client";
import type { ApiError, ApiResult } from "@/lib/api/errors";
import type { UpdateProfileRequest } from "@/lib/account";

import { FormActions, SubmitButton, indexFieldErrors } from "./form-field";

/**
 * Profile editing, as one inset grouped card.
 *
 * THE EMAIL ADDRESS IS DISPLAYED BUT NOT EDITABLE. Changing an email is an
 * identity operation — it must re-verify the new address and invalidate the old
 * one, or an attacker with a borrowed session silently takes ownership of the
 * account. The API's update schema omits the field for the same reason. It is
 * shown as a value row rather than hidden, because the address the customer
 * came here to CHECK is the one thing this screen must not withhold; the
 * footnote says how to change it.
 *
 * THERE IS NO LANGUAGE ROW, and its absence is a decision. The account menu in
 * the shell is the single language affordance in the product; a second switcher
 * that has to stay in step with it is a defect generator, and the plan records
 * the drawn row as dropped. `preferredLocale` is therefore not sent either —
 * the update schema is `.partial()`, and echoing back a value this form no
 * longer owns would silently revert a change made in the menu a moment ago.
 *
 * NEITHER IS THERE A MARKETING-CONSENT SWITCH. The artboard draws one and the
 * copy for it is authored, but `customerSchema` — what `GET /me` returns — has
 * no consent field at all (`marketingConsentAt` exists only on the ADMIN view),
 * and `updateProfileSchema` is `.strict()` over exactly four keys. A switch
 * that commits immediately to an endpoint which would reject the key is worse
 * than no switch: it throws away the customer's decision and tells them it was
 * saved. It lands with the API change, not before it.
 */

/** Same neutral 202 the sibling auth forms parse. */
const acknowledgedSchema = z.object({ status: z.literal("accepted") });

/**
 * Borderless: the ROW is the control here, and the card's own hairline is the
 * only edge in the group. A bordered box inside a grouped row draws a second
 * frame inside the first, which is what the whole inset idiom exists to avoid.
 */
const ROW_INPUT =
  "w-full min-w-0 rounded-[var(--r-check)] border-0 bg-transparent p-0 text-[var(--font-body)] text-[var(--label)] placeholder:text-[var(--label-tertiary)] focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--focus-ring)] disabled:text-[var(--label-tertiary)]";

interface TextRowProps {
  /** Already translated. */
  readonly label: string;
  readonly name: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
  readonly type?: "text" | "tel";
  readonly autoComplete?: string;
  readonly required?: boolean;
  readonly maxLength?: number;
  readonly hint?: string | undefined;
  /**
   * `| undefined` rather than `?:` — every call site passes an index read off
   * the indexed field errors, which is `string | undefined` under
   * `noUncheckedIndexedAccess` and which `exactOptionalPropertyTypes` would
   * reject against an optional prop.
   */
  readonly error?: string | undefined;
}

/**
 * One editable row of the grouped card.
 *
 * `Field layout="row"` owns the label/control pairing, the 44pt row and the
 * `htmlFor`/`id` wiring; the `<li>` and its separator are what `GroupedList`
 * expects around a row, and the separator is the LAST child so the list's
 * "hide the final rule" selector still finds it.
 *
 * THE ERROR IS NOT PASSED TO `Field`, deliberately. `Field` gives its error
 * `role="alert"`, which is right for a control validated on blur. This form
 * validates on SUBMIT and reports every failing field at once, and five
 * simultaneous assertive announcements are not five times as useful. The wiring
 * a screen-reader user actually needs is here and unchanged: `aria-invalid` on
 * the control and `aria-describedby` naming the message, so the error is read
 * when focus arrives on the field it belongs to.
 */
function TextRow({
  label,
  name,
  value,
  onChange,
  disabled,
  type = "text",
  autoComplete,
  required = false,
  maxLength,
  hint,
  error,
}: TextRowProps) {
  return (
    <li>
      <Field
        label={label}
        layout="row"
        required={required}
        disabled={disabled}
        className="px-[var(--cell-px)]"
        {...(hint === undefined ? {} : { hint })}
      >
        {(control) => {
          // The id is `Field`'s, generated inside it, so the error id can only
          // be derived in here rather than alongside the call.
          const errorId = `${control.id}-error`;

          // Error first, then hint: the message explaining a rejection is what
          // the user needs before the advice that would have avoided it. Both
          // are named — dropping the hint id the moment a field goes invalid
          // would silently retire the guidance that fixes it.
          const describedBy = [
            error === undefined ? null : errorId,
            control["aria-describedby"] ?? null,
          ]
            .filter((part): part is string => part !== null)
            .join(" ");

          return (
            <>
              <input
                {...control}
                name={name}
                type={type}
                value={value}
                onChange={(event) => {
                  onChange(event.target.value);
                }}
                required={required}
                disabled={disabled}
                className={ROW_INPUT}
                // Present or absent, never "false": `aria-invalid="false"`
                // claims a field nobody has filled in yet is valid.
                {...(error === undefined ? {} : { "aria-invalid": true as const })}
                {...(describedBy === "" ? {} : { "aria-describedby": describedBy })}
                {...(autoComplete === undefined ? {} : { autoComplete })}
                {...(maxLength === undefined ? {} : { maxLength })}
              />
              {error === undefined ? null : (
                <p
                  id={errorId}
                  className="col-start-2 m-0 text-[13px] leading-[1.35] font-medium text-[var(--danger-text)]"
                >
                  {error}
                </p>
              )}
            </>
          );
        }}
      </Field>
      <div aria-hidden="true" className="ml-[var(--cell-px)] h-px bg-[var(--separator)]" />
    </li>
  );
}

export interface ProfileFormProps {
  readonly customer: Customer;
  readonly onSave: (input: UpdateProfileRequest) => Promise<ApiResult<Customer>>;
}

interface ProfileFormState {
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string;
}

function initialState(customer: Customer): ProfileFormState {
  return {
    firstName: customer.firstName ?? "",
    lastName: customer.lastName ?? "",
    phone: customer.phone ?? "",
  };
}

/** Idle, in flight, delivered, or refused — the resend affordance has four faces. */
type ResendState = "idle" | "sending" | "sent" | "failed";

export function ProfileForm({ customer, onSave }: ProfileFormProps) {
  const t = useTranslations("account.profile");
  const tCommon = useTranslations("account.common");
  const tErrors = useTranslations("errors");

  const [form, setForm] = useState<ProfileFormState>(() => initialState(customer));
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [localErrors, setLocalErrors] = useState<Readonly<Record<string, string>>>({});
  const [resend, setResend] = useState<ResendState>("idle");

  // The Turnstile widget injects its hidden response input into the SURROUNDING
  // form, so the resend handler needs the form element to read the token back
  // out. A ref rather than `event.currentTarget`, because resending is a button
  // press and not a submit.
  const formRef = useRef<HTMLFormElement>(null);

  const isVerified = customer.emailVerifiedAt !== null;

  const update = <K extends keyof ProfileFormState>(
    key: K,
    value: ProfileFormState[K],
  ): void => {
    setForm((current) => ({ ...current, [key]: value }));
    // Any edit clears the previous outcome. Leaving "Saved." on screen while
    // the user types new values tells them their in-progress edits are stored.
    setSaved(false);
  };

  function validate(): Readonly<Record<string, string>> {
    const errors: Record<string, string> = {};
    if (form.firstName.trim() === "") {
      errors.firstName = t("requiredFirstName");
    }
    if (form.lastName.trim() === "") {
      errors.lastName = t("requiredLastName");
    }
    return errors;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const validationErrors = validate();
    setLocalErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    setIsSaving(true);
    setError(null);
    setSaved(false);

    const result = await onSave({
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      // An empty phone field means "no phone", which the contract spells as
      // null. Sending "" would store an empty string that then renders as a
      // blank line on every future invoice.
      phone: form.phone.trim() === "" ? null : form.phone.trim(),
    });

    if (result.ok) {
      setSaved(true);
      // Re-seeded from the SERVER's customer, not from the local draft: if the
      // API normalised a phone number, the field must show what was stored.
      setForm(initialState(result.data));
    } else {
      setError(result.error);
      setLocalErrors(indexFieldErrors(result.error.fields));
    }

    setIsSaving(false);
  }

  async function handleResend(): Promise<void> {
    const element = formRef.current;
    if (element === null) {
      return;
    }

    setResend("sending");

    // Straight to the BFF route rather than through a server action: the
    // endpoint is bot-protected and rate-limited per IP, and it answers with a
    // neutral 202 whether or not the address exists.
    const result = await postJson(
      "/api/auth/resend-verification",
      { email: customer.email, turnstileToken: readTurnstileToken(element) },
      acknowledgedSchema,
    );

    setResend(result.ok ? "sent" : "failed");
  }

  /**
   * The banner's sentence, resolved from the CLOSED error code.
   *
   * `error.message` is never read: it is the API's English, written for a log.
   * `t.has` then `generic` is the fallback `ui/alert.tsx` and `ui/states.tsx`
   * already use — a code added to the contract before the catalogues catch up
   * must degrade to a sentence rather than render a key path at a customer.
   *
   * UNAUTHENTICATED is special-cased because the shared copy for it is the
   * SIGN-IN phrasing ("wrong email or password"), which is actively misleading
   * for a session that expired while a form was open.
   */
  function bannerCause(failure: ApiError): string {
    if (failure.code === "UNAUTHENTICATED") {
      return tCommon("sessionExpiredBody");
    }
    return tErrors.has(failure.code) ? tErrors(failure.code) : tErrors("generic");
  }

  function bannerTitle(failure: ApiError): { readonly title?: string } {
    return failure.code === "UNAUTHENTICATED"
      ? { title: tCommon("sessionExpiredTitle") }
      : {};
  }

  /**
   * The standing footnote under the card, which also carries the resend
   * affordance — as drawn, and because a customer told their address is
   * unverified with no way to fix it is the whole defect.
   */
  const footnote: ReactNode = (
    <>
      {t("emailHint")}
      {isVerified ? null : (
        <>
          {" "}
          {resend === "sent" ? (
            // `role="status"`: a confirmation is polite information, and an
            // assertive region would interrupt a screen-reader user mid-sentence
            // to deliver good news.
            <span role="status">{t("verificationSent")}</span>
          ) : (
            <>
              {/*
                `compact` inside a 13px footnote: this is a link in a sentence,
                and a 44pt control dropped into one reads as a second paragraph.
                The row it belongs to is the touch target on this screen.
              */}
              <Button
                variant="plain"
                size="compact"
                onClick={() => {
                  void handleResend();
                }}
                pending={resend === "sending"}
                pendingLabel={t("resendingVerification")}
              >
                {t("resendVerification")}
              </Button>
              {resend === "failed" ? (
                <span role="alert" className="text-[var(--danger-text)]">
                  {t("verificationFailed")}
                </span>
              ) : null}
            </>
          )}
        </>
      )}
    </>
  );

  return (
    <form
      ref={formRef}
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      className="grid gap-5"
    >
      {saved ? (
        <Notice tone="success" placement="inline">
          {t("saved")}
        </Notice>
      ) : null}

      {/* Field-level problems are rendered inline on the offending input; the
          banner carries everything else (conflict, rate limit, server error). */}
      {error === null || error.code === "VALIDATION_FAILED" ? null : (
        <Notice
          tone="danger"
          placement="inline"
          requestId={error.requestId}
          {...bannerTitle(error)}
        >
          {bannerCause(error)}
        </Notice>
      )}

      <GroupedList id="profile-details" label={t("sectionDetails")} hint={footnote}>
        <TextRow
          label={t("firstName")}
          name="firstName"
          value={form.firstName}
          onChange={(value) => {
            update("firstName", value);
          }}
          autoComplete="given-name"
          required
          disabled={isSaving}
          maxLength={80}
          error={localErrors.firstName}
        />
        <TextRow
          label={t("lastName")}
          name="lastName"
          value={form.lastName}
          onChange={(value) => {
            update("lastName", value);
          }}
          autoComplete="family-name"
          required
          disabled={isSaving}
          maxLength={80}
          error={localErrors.lastName}
        />
        <TextRow
          label={t("phone")}
          name="phone"
          type="tel"
          value={form.phone}
          onChange={(value) => {
            update("phone", value);
          }}
          autoComplete="tel"
          disabled={isSaving}
          maxLength={32}
          hint={t("phoneHint")}
          error={localErrors.phone}
        />
        <ValueRow
          label={t("email")}
          value={
            <>
              <span className="min-w-0 break-all">{customer.email}</span>
              {isVerified ? null : (
                <StatusBadge domain="emailVerification" value="unverified" />
              )}
            </>
          }
        />
      </GroupedList>

      {/* Rendered only where it is needed, and invisible until Cloudflare
          decides otherwise. Inside the form on purpose — `readTurnstileToken`
          finds the injected response input through `form.elements`. */}
      {isVerified ? null : <TurnstileWidget />}

      {/* The drawn save sits at the trailing edge of the measure. `FormActions`
          is kept rather than replaced by a bare flex row so this form's action
          rail stays the same component the other four account forms use. */}
      <div className="flex justify-end">
        <FormActions>
          <SubmitButton
            label={t("save")}
            pendingLabel={tCommon("saving")}
            isPending={isSaving}
          />
        </FormActions>
      </div>
    </form>
  );
}
