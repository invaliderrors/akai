"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";

import { Button, IconButton } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { ConfirmActionError, TypeToConfirmButton } from "./type-to-confirm-button";
import type { ActionResult } from "@/lib/admin/actions";

/**
 * The catalogue's category tree — create, rename, reorder, delete.
 *
 * §6 of `docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md`
 * reopened a decision the client made three days earlier ("one-time
 * seed-script edit is sufficient"); this is the screen that supersedes it.
 *
 * ONE COMBINED SCREEN, NOT FOUR. A store's category tree is tens of rows
 * (`categories.repository.ts`'s own reasoning for staying unpaginated), so a
 * create form, an inline rename, up/down reorder buttons and a per-row delete
 * all fit on one page without the list/detail split `product-editor.tsx`
 * needs for a resource with dozens of fields.
 *
 * UP/DOWN BUTTONS, NOT DRAG-AND-DROP — same reasoning as
 * `product-reorder-list.tsx`: every row already carries rename and delete
 * controls, and Tab plus Enter moves a row exactly as reliably as a pointer
 * does.
 *
 * LOCAL STATE IS THE SOURCE OF TRUTH AFTER EVERY WRITE, not a
 * `router.refresh()` the way `batch-coa-field.tsx` uses. That works there
 * because the field reads its one `batch` prop straight from the server; this
 * component holds a REORDERABLE COPY of the list (`rows`), and `useState`
 * only reads its initial value once — a later prop change from a refresh
 * would not reach it. So create, rename and delete each patch `rows`
 * themselves, deterministically, and never depend on Next re-rendering the
 * parent server component at all.
 */
export interface CategoryRow {
  readonly id: string;
  readonly slug: string;
  readonly name: { readonly es?: string; readonly en?: string };
  readonly productCount: number;
}

interface CreatedCategory {
  readonly id: string;
  readonly slug: string;
  readonly name: { readonly es?: string; readonly en?: string };
}

interface CategoryManagerProps {
  readonly initial: readonly CategoryRow[];
  readonly onCreate: (input: {
    slug: string;
    name: { es: string; en: string };
  }) => Promise<ActionResult<CreatedCategory>>;
  readonly onRename: (
    id: string,
    input: { name: { es: string; en: string } },
  ) => Promise<ActionResult<CreatedCategory>>;
  readonly onReorder: (
    categoryIds: readonly string[],
  ) => Promise<ActionResult<{ reordered: number }>>;
  readonly onDelete: (id: string) => Promise<ActionResult<null>>;
}

export function CategoryManager({
  initial,
  onCreate,
  onRename,
  onReorder,
  onDelete,
}: CategoryManagerProps) {
  const t = useTranslations("admin.categoryManager");
  const [rows, setRows] = useState<readonly CategoryRow[]>(initial);

  const [slug, setSlug] = useState("");
  const [nameEs, setNameEs] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>(undefined);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftEs, setDraftEs] = useState("");
  const [draftEn, setDraftEn] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | undefined>(undefined);

  const [reordering, setReordering] = useState(false);
  const [orderError, setOrderError] = useState<string | undefined>(undefined);
  const [orderSaved, setOrderSaved] = useState(false);

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setCreateError(undefined);
    setCreating(true);
    try {
      const result = await onCreate({
        slug: slug.trim(),
        name: { es: nameEs.trim(), en: nameEn.trim() },
      });
      if (!result.ok) {
        setCreateError(result.code === "CONFLICT" ? t("duplicateSlug") : t("createFailed"));
        return;
      }
      setRows((current) => [
        ...current,
        { id: result.data.id, slug: result.data.slug, name: result.data.name, productCount: 0 },
      ]);
      setSlug("");
      setNameEs("");
      setNameEn("");
    } finally {
      setCreating(false);
    }
  }

  function startEditing(row: CategoryRow): void {
    setEditingId(row.id);
    setDraftEs(row.name.es ?? "");
    setDraftEn(row.name.en ?? "");
    setRenameError(undefined);
  }

  async function handleRename(id: string): Promise<void> {
    setRenameError(undefined);
    setRenaming(true);
    try {
      const result = await onRename(id, { name: { es: draftEs.trim(), en: draftEn.trim() } });
      if (!result.ok) {
        setRenameError(t("renameFailed"));
        return;
      }
      setRows((current) =>
        current.map((row) => (row.id === id ? { ...row, name: result.data.name } : row)),
      );
      setEditingId(null);
    } finally {
      setRenaming(false);
    }
  }

  function move(index: number, direction: -1 | 1): void {
    const target = index + direction;
    if (target < 0 || target >= rows.length) return;

    setOrderSaved(false);
    setRows((current) => {
      const next = [...current];
      const a = next[index];
      const b = next[target];
      if (a === undefined || b === undefined) return current;
      next[index] = b;
      next[target] = a;
      return next;
    });
  }

  async function handleSaveOrder(): Promise<void> {
    setReordering(true);
    setOrderError(undefined);
    try {
      const result = await onReorder(rows.map((row) => row.id));
      if (!result.ok) {
        setOrderError(t("orderFailed"));
        return;
      }
      setOrderSaved(true);
    } finally {
      setReordering(false);
    }
  }

  function categoryName(row: CategoryRow): string {
    return row.name.es ?? row.name.en ?? row.slug;
  }

  return (
    <div className="grid gap-6">
      <form
        onSubmit={(event) => void handleCreate(event)}
        className="grid gap-3 rounded-[var(--r-card)] bg-[var(--bg-grouped-secondary)] p-[var(--card-p)]"
      >
        <h2 className="m-0 text-[13px] font-semibold text-[var(--label)]">{t("createTitle")}</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField
            label={t("slugLabel")}
            name="slug"
            id="category-slug"
            value={slug}
            onChange={setSlug}
            hint={t("slugHint")}
            required
            disabled={creating}
          />
          <TextField
            label={t("nameEsLabel")}
            name="nameEs"
            id="category-name-es"
            value={nameEs}
            onChange={setNameEs}
            required
            disabled={creating}
          />
          <TextField
            label={t("nameEnLabel")}
            name="nameEn"
            id="category-name-en"
            value={nameEn}
            onChange={setNameEn}
            required
            disabled={creating}
          />
        </div>
        {createError !== undefined && <Notice tone="danger">{createError}</Notice>}
        <div className="justify-self-start">
          <Button type="submit" variant="prominent" size="compact" disabled={creating}>
            {creating ? t("creating") : t("create")}
          </Button>
        </div>
      </form>

      {rows.length === 0 ? (
        <Notice tone="warning">{t("empty")}</Notice>
      ) : (
        <div className="grid gap-3">
          <p className="text-[13px] text-[var(--label-secondary)]">{t("hint")}</p>

          <ol className="grid gap-1.5">
            {rows.map((row, index) => (
              <li
                key={row.id}
                className="grid gap-2 rounded-[var(--r-card)] border border-[var(--separator-weak)] bg-[var(--bg-grouped-secondary)] p-2"
              >
                <div className="flex items-center gap-3">
                  <span className="w-6 shrink-0 text-center font-mono text-[12px] text-[var(--label-secondary)]">
                    {index + 1}
                  </span>

                  {editingId === row.id ? (
                    <div className="grid flex-1 gap-2 sm:grid-cols-2">
                      <TextField
                        label={t("nameEsLabel")}
                        name={`rename-es-${row.id}`}
                        id={`rename-es-${row.id}`}
                        value={draftEs}
                        onChange={setDraftEs}
                        disabled={renaming}
                      />
                      <TextField
                        label={t("nameEnLabel")}
                        name={`rename-en-${row.id}`}
                        id={`rename-en-${row.id}`}
                        value={draftEn}
                        onChange={setDraftEn}
                        disabled={renaming}
                      />
                    </div>
                  ) : (
                    <div className="min-w-0 flex-1">
                      <p className="m-0 truncate text-[13px] font-medium text-[var(--label)]">
                        {categoryName(row)}
                        {row.name.en !== undefined && row.name.es !== undefined ? (
                          <span className="ml-1.5 font-normal text-[var(--label-secondary)]">
                            · {row.name.en}
                          </span>
                        ) : null}
                      </p>
                      <p className="m-0 truncate text-[11px] text-[var(--label-secondary)]">
                        <span className="font-mono">{row.slug}</span>
                        {" · "}
                        {t("productCount", { count: row.productCount })}
                      </p>
                    </div>
                  )}

                  <div className="flex shrink-0 gap-1">
                    {editingId === row.id ? (
                      <>
                        <Button
                          variant="prominent"
                          size="compact"
                          disabled={renaming}
                          onClick={() => void handleRename(row.id)}
                        >
                          {renaming ? t("savingRename") : t("saveRename")}
                        </Button>
                        <Button
                          variant="standard"
                          size="compact"
                          disabled={renaming}
                          onClick={() => setEditingId(null)}
                        >
                          {t("cancelRename")}
                        </Button>
                      </>
                    ) : (
                      <>
                        <IconButton
                          label={t("moveUp", { name: categoryName(row) })}
                          icon="chevron-down"
                          className="rotate-180"
                          variant="standard"
                          size="mini"
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                        />
                        <IconButton
                          label={t("moveDown", { name: categoryName(row) })}
                          icon="chevron-down"
                          variant="standard"
                          size="mini"
                          disabled={index === rows.length - 1}
                          onClick={() => move(index, 1)}
                        />
                        <Button variant="standard" size="compact" onClick={() => startEditing(row)}>
                          {t("renameTrigger")}
                        </Button>
                        <TypeToConfirmButton
                          phrase={row.slug}
                          triggerLabel={t("deleteTrigger")}
                          title={t("deleteTitle")}
                          body={t("deleteBody")}
                          prompt={t.rich("deletePrompt", {
                            phrase: row.slug,
                            mono: (chunks) => <span className="font-mono font-semibold">{chunks}</span>,
                          })}
                          confirmLabel={t("deleteConfirm")}
                          busyLabel={t("deleteBusy")}
                          cancelLabel={t("deleteCancel")}
                          fallbackError={t("deleteFailed")}
                          onConfirm={async () => {
                            const result = await onDelete(row.id);
                            if (!result.ok) {
                              throw new ConfirmActionError(
                                result.code === "CONFLICT" ? t("deleteConflict") : t("deleteFailed"),
                              );
                            }
                            setRows((current) => current.filter((entry) => entry.id !== row.id));
                          }}
                        />
                      </>
                    )}
                  </div>
                </div>

                {editingId === row.id && renameError !== undefined && (
                  <Notice tone="danger">{renameError}</Notice>
                )}
              </li>
            ))}
          </ol>

          {orderError !== undefined && <Notice tone="danger">{orderError}</Notice>}
          {orderSaved && <Notice tone="success">{t("orderSaved")}</Notice>}

          <div className="justify-self-end">
            <Button
              variant="prominent"
              size="compact"
              disabled={reordering}
              onClick={() => void handleSaveOrder()}
            >
              {reordering ? t("savingOrder") : t("saveOrder")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
