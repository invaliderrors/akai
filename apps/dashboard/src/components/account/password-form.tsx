"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";

import { Field } from "@/components/ui/field";
import { GroupedList } from "@/components/ui/grouped-list";
import { Notice } from "@/components/ui/notice";
import type { ApiError, ApiResult } from "@/lib/api/errors";
import type { ChangePasswordRequest } from "@/lib/account";

import { FormActions, SubmitButton } from "./form-field";

/** The platform password floor, from the contract's `passwordSchema`. */
const MIN_PASSWORD_LENGTH = 12;

/**
 * The group's id, and therefore the stem of every id it hangs off itself:
 * `${GROUP_ID}-title`, `-hint`, `-error`. Named once because the rows point
 * their `aria-describedby` at messages inside that error node.
 */
const GROUP_ID = "password-change";

/**
 * Password change, as one inset group of three rows.
 *
 * THE CURRENT PASSWORD IS REQUIRED even though the user already holds a valid
 * session. That is deliberate: a session can be borrowed (an unlocked laptop, a
 * stolen cookie), and without re-authentication the change-password form is a
 * one-click account takeover that also locks out the real owner. Requiring the
 * old password means an attacker needs the secret they were trying to replace.
 *
 * A successful change signs out every OTHER device (the API revokes all refresh
 * families but keeps this session), which is the behaviour a user changing a
 * password after a scare actually wants. The confirmation says so explicitly,
 * because a silent mass sign-out looks like a bug.
 *
 * VALIDATION IS REPORTED IN THE SECTION FOOTER, NOT PER ROW. The form validates
 * on SUBMIT and can fail all three fields at once; three assertive regions
 * arriving together are not three times as useful, and inside a grouped card
 * there is nowhere to put a message under a row without breaking the rhythm of
 * the rules. So the group's single `role="alert"` announces the whole summary
 * once — and each failing control still points `aria-describedby` at ITS OWN
 * line inside that summary, so a screen-reader user landing on the current
 * password field hears only what is wrong with the current password field.
 */

export interface PasswordFormProps {
  readonly onSubmit: (
    input: ChangePasswordRequest,
  ) => Promise<ApiResult<undefined>>;
}

const EMPTY_FORM = {
  currentPassword: "",
  newPassword: "",
  confirmPassword: "",
} as const;

/** The three fields, in the order they are read and reported. */
type PasswordField = keyof typeof EMPTY_FORM;

const FIELD_ORDER: readonly PasswordField[] = [
  "currentPassword",
  "newPassword",
  "confirmPassword",
];

/** See `profile-form.tsx` — the row IS the control, so the input carries no box. */
const ROW_INPUT =
  "w-full min-w-0 rounded-[var(--r-check)] border-0 bg-transparent p-0 text-[var(--font-body)] text-[var(--label)] placeholder:text-[var(--label-tertiary)] focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--focus-ring)] disabled:text-[var(--label-tertiary)]";

interface PasswordRowProps {
  /** Already translated. */
  readonly label: string;
  readonly name: PasswordField;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
  readonly autoComplete: "current-password" | "new-password";
  /** Drives `aria-invalid` and points the control at its line in the footer. */
  readonly invalid: boolean;
}

/**
 * One password row.
 *
 * `Field layout="row"` owns the label/control pairing and the `htmlFor`/`id`
 * wiring; the `<li>` and its trailing separator are what `GroupedList` expects
 * around a row — the rule is the LAST child so the list's "hide the final one"
 * selector still finds it.
 */
function PasswordRow({
  label,
  name,
  value,
  onChange,
  disabled,
  autoComplete,
  invalid,
}: PasswordRowProps) {
  return (
    <li>
      <Field
        label={label}
        layout="row"
        required
        disabled={disabled}
        className="px-[var(--cell-px)]"
      >
        {(control) => (
          <input
            {...control}
            name={name}
            type="password"
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
            }}
            required
            disabled={disabled}
            autoComplete={autoComplete}
            className={ROW_INPUT}
            // Present or absent, never "false": `aria-invalid="false"` claims a
            // field nobody has filled in yet is valid.
            {...(invalid
              ? {
                  "aria-invalid": true as const,
                  "aria-describedby": `${GROUP_ID}-error-${name}`,
                }
              : {})}
          />
        )}
      </Field>
      <div aria-hidden="true" className="ml-[var(--cell-px)] h-px bg-[var(--separator)]" />
    </li>
  );
}

export function PasswordForm({ onSubmit }: PasswordFormProps) {
  const t = useTranslations("account.security");
  const tErrors = useTranslations("errors");

  const [form, setForm] = useState<Record<PasswordField, string>>({ ...EMPTY_FORM });
  const [isSaving, setIsSaving] = useState(false);
  const [succeeded, setSucceeded] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<
    Readonly<Partial<Record<PasswordField, string>>>
  >({});

  const update = (key: PasswordField, value: string): void => {
    setForm((current) => ({ ...current, [key]: value }));
    setSucceeded(false);
  };

  function validate(): Readonly<Partial<Record<PasswordField, string>>> {
    const errors: Partial<Record<PasswordField, string>> = {};

    if (form.currentPassword === "") {
      errors.currentPassword = t("requiredCurrent");
    }
    if (form.newPassword.length < MIN_PASSWORD_LENGTH) {
      errors.newPassword = t("tooShort");
    }
    // Checked even when the new password is too short: telling the user about
    // both problems at once beats making them submit twice to find the second.
    if (form.confirmPassword !== form.newPassword) {
      errors.confirmPassword = t("mismatch");
    }

    return errors;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const validationErrors = validate();
    setFieldErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    setIsSaving(true);
    setError(null);
    setSucceeded(false);

    const result = await onSubmit({
      currentPassword: form.currentPassword,
      newPassword: form.newPassword,
    });

    if (result.ok) {
      setSucceeded(true);
      // Clear the fields on success. Leaving a plaintext password sitting in a
      // form control is an unnecessary window for anyone who walks past next.
      setForm({ ...EMPTY_FORM });
    } else if (result.error.code === "UNAUTHENTICATED" || result.status === 403) {
      // A rejected CURRENT password comes back as an auth failure. Surfacing it
      // on the field is far clearer than a banner saying the session expired —
      // which would be actively misleading, since it has not.
      setFieldErrors({ currentPassword: t("wrongPassword") });
    } else {
      setError(result.error);
    }

    setIsSaving(false);
  }

  // Rebuilt in field order on every render so the summary reads down the card
  // in the same sequence as the rows it is about.
  const problems = FIELD_ORDER.flatMap((field) => {
    const message = fieldErrors[field];
    return message === undefined ? [] : [{ field, message }];
  });

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="grid gap-5">
      {succeeded ? (
        // `role="status"` comes from the success tone: a confirmation is polite
        // information, and an assertive region would interrupt a screen-reader
        // user mid-sentence to deliver good news.
        <Notice tone="success" placement="inline">
          {t("success")}
        </Notice>
      ) : null}

      {error === null ? null : (
        // Resolved from the CLOSED error code; `error.message` is never read,
        // because it is the API's English written for a log. `t.has` then
        // `generic` is the fallback `ui/alert.tsx` and `ui/states.tsx` use, so a
        // code added to the contract ahead of the catalogues degrades to a
        // sentence rather than rendering a key path at a customer. The
        // session-expired case cannot arrive here: a 401 is claimed above by
        // the current-password field.
        <Notice tone="danger" placement="inline" requestId={error.requestId}>
          {tErrors.has(error.code) ? tErrors(error.code) : tErrors("generic")}
        </Notice>
      )}

      <GroupedList
        id={GROUP_ID}
        label={t("passwordTitle")}
        hint={t("passwordHint")}
        {...(problems.length === 0
          ? {}
          : {
              error: (
                <>
                  {problems.map((problem) => (
                    // Each message owns an id so its OWN field can name it;
                    // pointing all three at the whole summary would read every
                    // problem out on arrival at any one of them.
                    <span
                      key={problem.field}
                      id={`${GROUP_ID}-error-${problem.field}`}
                      className="block"
                    >
                      {problem.message}
                    </span>
                  ))}
                </>
              ),
            })}
      >
        <PasswordRow
          label={t("currentPassword")}
          name="currentPassword"
          value={form.currentPassword}
          onChange={(value) => {
            update("currentPassword", value);
          }}
          disabled={isSaving}
          autoComplete="current-password"
          invalid={fieldErrors.currentPassword !== undefined}
        />
        <PasswordRow
          label={t("newPassword")}
          name="newPassword"
          value={form.newPassword}
          onChange={(value) => {
            update("newPassword", value);
          }}
          disabled={isSaving}
          autoComplete="new-password"
          invalid={fieldErrors.newPassword !== undefined}
        />
        <PasswordRow
          label={t("confirmPassword")}
          name="confirmPassword"
          value={form.confirmPassword}
          onChange={(value) => {
            update("confirmPassword", value);
          }}
          disabled={isSaving}
          autoComplete="new-password"
          invalid={fieldErrors.confirmPassword !== undefined}
        />
      </GroupedList>

      {/* Trailing edge, as drawn — see the note in `profile-form.tsx`. */}
      <div className="flex justify-end">
        <FormActions>
          <SubmitButton
            label={t("submit")}
            pendingLabel={t("submitting")}
            isPending={isSaving}
          />
        </FormActions>
      </div>
    </form>
  );
}
