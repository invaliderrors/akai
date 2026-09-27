"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { Address } from "@akai/contracts";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClassName } from "@/components/ui/button";
import { ConfirmAlert } from "@/components/ui/confirm";
import { ContentRow, GroupedList } from "@/components/ui/grouped-list";
import { Icon } from "@/components/ui/icon";
import { Notice } from "@/components/ui/notice";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import type { ApiError, ApiResult } from "@/lib/api/errors";
import type { CreateAddressRequest, UpdateAddressRequest } from "@/lib/account";
import { AddressForm } from "./address-form";

/**
 * The address book: list, create, edit, delete.
 *
 * State lives here rather than in the page so the whole interaction — including
 * the delete confirmation — is exercisable in a component test without a router
 * or a live API. The page's only job is to supply the initial list and wire the
 * three callbacks to the typed account API.
 */

// ---------------------------------------------------------------------------
// The create sheet, shared with the page header
// ---------------------------------------------------------------------------

interface AddressSheetValue {
  readonly creating: boolean;
  readonly openCreate: () => void;
  readonly closeCreate: () => void;
}

const AddressSheetContext = createContext<AddressSheetValue | null>(null);

function useAddressSheet(): AddressSheetValue {
  const value = useContext(AddressSheetContext);
  if (value === null) {
    throw new Error("Address book components must render inside <AddressBookProvider>.");
  }
  return value;
}

/**
 * ONE boolean, lifted so the header and the list can both see it.
 *
 * The drawn screen puts "Añadir dirección" in the PAGE HEADER, which
 * `PageTemplate` renders as a sibling of the content — so the button and the
 * sheet it opens cannot be parent and child. The alternatives were worse: the
 * whole page becoming one client island (losing the server-rendered header), or
 * the create sheet living in the header and refetching the list through the
 * router on success, which would make "the address I just added" arrive a
 * network round-trip after the confirmation that it had.
 *
 * Deliberately only the CREATE sheet. Edit and delete are opened from a row, so
 * their state belongs to the list and hoisting it here would put three
 * unrelated dialogs in one context for no reason.
 */
export function AddressBookProvider({ children }: { readonly children: ReactNode }) {
  const [creating, setCreating] = useState(false);

  const value = useMemo<AddressSheetValue>(
    () => ({
      creating,
      openCreate: () => {
        setCreating(true);
      },
      closeCreate: () => {
        setCreating(false);
      },
    }),
    [creating],
  );

  return (
    <AddressSheetContext.Provider value={value}>{children}</AddressSheetContext.Provider>
  );
}

/** The header's prominent action. Drawn as `+ Añadir dirección`. */
export function AddAddressButton() {
  const t = useTranslations("account.addresses");
  const { openCreate } = useAddressSheet();

  return (
    <Button variant="prominent" size="comfortable" icon="plus" onClick={openCreate}>
      {t("add")}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// AddressBook
// ---------------------------------------------------------------------------

export interface AddressBookProps {
  readonly addresses: readonly Address[];
  readonly onCreate: (input: CreateAddressRequest) => Promise<ApiResult<Address>>;
  readonly onUpdate: (
    addressId: string,
    input: UpdateAddressRequest,
  ) => Promise<ApiResult<Address>>;
  readonly onDelete: (addressId: string) => Promise<ApiResult<undefined>>;
}

/** A saved confirmation, and the sibling change it may have caused. */
interface SavedNotice {
  readonly message: string;
  /** The demotion sentence, or null when nothing else moved. */
  readonly detail: string | null;
}

/**
 * How the customer refers to this address elsewhere — the row's own first line
 * plus the town, which is the pair that tells two flats on the same street
 * apart. Used to name the delete confirmation and the undo toast.
 */
function addressLabel(address: Address): string {
  return `${address.line1}, ${address.city}`;
}

/**
 * The row's second line. `line1` is deliberately absent: it is the row TITLE,
 * and repeating it immediately underneath is the kind of duplication that makes
 * a dense list unreadable.
 */
function addressDetail(address: Address): string {
  return [
    `${address.firstName} ${address.lastName}`,
    address.company,
    address.line2,
    `${address.postalCode} ${address.city}`,
    address.region,
    address.countryCode,
    address.phone,
  ]
    .filter((part): part is string => part !== null && part.trim() !== "")
    .join(" · ");
}

/** Everything the API needs to put a deleted address back. */
function toCreateRequest(address: Address): CreateAddressRequest {
  return {
    type: address.type,
    firstName: address.firstName,
    lastName: address.lastName,
    company: address.company,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    region: address.region,
    postalCode: address.postalCode,
    countryCode: address.countryCode,
    phone: address.phone,
    isDefault: address.isDefault,
  };
}

export function AddressBook({
  addresses: initialAddresses,
  onCreate,
  onUpdate,
  onDelete,
}: AddressBookProps) {
  const t = useTranslations("account.addresses");
  const tCommon = useTranslations("account.common");
  const tUi = useTranslations("ui");
  const toast = useToast();
  const { creating, closeCreate } = useAddressSheet();

  const [addresses, setAddresses] = useState<readonly Address[]>(initialAddresses);
  const [editing, setEditing] = useState<Address | null>(null);
  const [deleting, setDeleting] = useState<Address | null>(null);
  const [notice, setNotice] = useState<SavedNotice | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  /**
   * Setting an address as default DEMOTES whichever one held the flag before,
   * and that sibling change is invisible in the single-address response. Rather
   * than guess, the list is patched locally and the flag is cleared on the
   * others — the same rule the API applies, and only WITHIN A TYPE: a customer
   * may hold one default shipping address and one default billing address at
   * the same time, so a new default billing address must not demote the
   * shipping one.
   */
  function applyDefaultRule(next: readonly Address[], saved: Address): Address[] {
    return next.map((address) =>
      saved.isDefault && address.id !== saved.id && address.type === saved.type
        ? { ...address, isDefault: false }
        : address,
    );
  }

  function confirmSaved(saved: Address): void {
    setNotice({
      message: t("saved"),
      detail: saved.isDefault ? t("defaultChanged", { line1: saved.line1 }) : null,
    });
    setError(null);
  }

  async function handleCreate(input: CreateAddressRequest): Promise<ApiResult<Address>> {
    const result = await onCreate(input);
    if (result.ok) {
      setAddresses((current) => applyDefaultRule([...current, result.data], result.data));
      closeCreate();
      confirmSaved(result.data);
    }
    return result;
  }

  async function handleUpdate(
    addressId: string,
    input: UpdateAddressRequest,
  ): Promise<ApiResult<Address>> {
    const result = await onUpdate(addressId, input);
    if (result.ok) {
      const saved = result.data;
      setAddresses((current) =>
        applyDefaultRule(
          current.map((address) => (address.id === saved.id ? saved : address)),
          saved,
        ),
      );
      setEditing(null);
      confirmSaved(saved);
    }
    return result;
  }

  /**
   * Undo re-CREATES the address rather than un-deleting it.
   *
   * There is no restore endpoint and there does not need to be: an address is
   * eleven fields the customer already gave us, so putting it back is a create
   * with the same values. The row returns with a new id, which is invisible
   * here and is the honest description of what the server now holds.
   */
  async function restore(address: Address): Promise<void> {
    const result = await onCreate(toCreateRequest(address));
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setAddresses((current) => applyDefaultRule([...current, result.data], result.data));
  }

  async function handleDelete(address: Address): Promise<void> {
    const result = await onDelete(address.id);

    if (!result.ok) {
      // The row STAYS. A delete that failed has not happened, and removing it
      // optimistically would tell the customer the opposite of the truth while
      // the reason is sitting right above the list.
      setError(result.error);
      return;
    }

    setAddresses((current) => current.filter((entry) => entry.id !== address.id));
    setNotice(null);
    setError(null);

    // The confirmation of a REMOVAL is a toast, not a page notice, because it
    // carries the undo — and an undo that scrolls off the top of a long list is
    // an undo nobody presses. `Toast` dismisses itself once the action runs.
    toast.show({
      tone: "success",
      message: t("removed"),
      action: {
        label: tUi("undo"),
        onAction: () => {
          void restore(address);
        },
      },
    });
  }

  return (
    <div className="grid gap-4">
      {notice === null ? null : (
        // `role="status"` via the success tone: a save confirmation is polite
        // information, and an assertive region would interrupt a screen-reader
        // user mid-sentence to deliver good news.
        <Notice
          tone="success"
          {...(notice.detail === null ? {} : { title: notice.message })}
        >
          {notice.detail ?? notice.message}
        </Notice>
      )}

      {error === null ? null : (
        <ErrorState
          title={tUi("actionFailed")}
          code={error.code}
          // `""` is the client's marker for a failure that never reached the
          // API, where there is no reference to quote.
          requestId={error.requestId === "" ? null : error.requestId}
        />
      )}

      {addresses.length === 0 ? (
        // No action of its own: the header's "Añadir dirección" is on screen
        // and a second button with the same name would give a screen-reader
        // user two identical choices.
        <EmptyState icon="map-pin" title={t("emptyTitle")} body={t("emptyBody")} />
      ) : (
        <GroupedList id="addresses" hint={t("defaultHint")}>
          {addresses.map((address) => (
            <ContentRow
              key={address.id}
              title={address.line1}
              meta={addressDetail(address)}
              // Always present, default or not, so every row shares one text
              // origin and the separators line up — exactly the empty 24px
              // column the artboard draws on a non-default row.
              leading={
                address.isDefault ? (
                  <Icon
                    name="check"
                    size={20}
                    // The ONLY thing that says "default", so it is an image with
                    // a name rather than decoration.
                    title={t("default")}
                    className="text-[var(--accent)]"
                  />
                ) : (
                  <span aria-hidden="true" />
                )
              }
              // The type is not decoration: the default rule is PER TYPE, so a
              // list showing two checkmarks is only explicable next to it.
              aside={
                <Badge
                  tone="neutral"
                  label={address.type === "SHIPPING" ? t("typeShipping") : t("typeBilling")}
                />
              }
              trailing={
                <span className="flex gap-2">
                  {/* Plain <button> with `buttonClassName` rather than
                      `Button`: these two need an aria-label naming the row they
                      act on — three rows of "Editar, botón" is not a usable
                      list — and `Button` deliberately exposes no `aria-label`.
                      The visible word stays the first word of the accessible
                      name, so WCAG 2.5.3 holds. */}
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(address);
                    }}
                    aria-label={t("editNamed", { line1: address.line1 })}
                    className={buttonClassName({ variant: "standard", size: "comfortable" })}
                  >
                    {t("edit")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDeleting(address);
                    }}
                    aria-label={t("deleteNamed", { line1: address.line1 })}
                    className={buttonClassName({
                      variant: "destructivePlain",
                      size: "comfortable",
                    })}
                  >
                    {t("delete")}
                  </button>
                </span>
              }
            />
          ))}
        </GroupedList>
      )}

      {creating ? <AddressForm onSubmit={handleCreate} onCancel={closeCreate} /> : null}

      {editing === null ? null : (
        <AddressForm
          address={editing}
          onSubmit={(input) => handleUpdate(editing.id, input)}
          onCancel={() => {
            setEditing(null);
          }}
        />
      )}

      {deleting === null ? null : (
        // A PLAIN confirmation, not type-to-confirm: an address is reversible by
        // re-entering it and moves no money, so demanding that its name be
        // typed out would teach people to type through the dialog that is meant
        // to stop them at the one that really matters.
        <ConfirmAlert
          open
          onClose={() => {
            setDeleting(null);
          }}
          title={t("confirmDelete")}
          item={addressLabel(deleting)}
          consequence={`${t("confirmDeleteConsequence", { line1: deleting.line1 })} ${t(
            "confirmDeleteBody",
          )}`}
          confirmLabel={t("delete")}
          cancelLabel={tCommon("cancel")}
          busyLabel={t("deleting")}
          fallbackError={tUi("actionFailed")}
          onConfirm={() => handleDelete(deleting)}
        />
      )}
    </div>
  );
}
