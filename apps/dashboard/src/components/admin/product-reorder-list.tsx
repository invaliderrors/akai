"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Button, IconButton } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import type { ActionResult } from "@/lib/admin/actions";

/**
 * The catalogue-wide manual order — up/down, not drag-and-drop.
 *
 * A DELIBERATE CHOICE OVER A DRAG HANDLE. `media-uploader.tsx` already solves
 * HTML5 drag-and-drop with a keyboard fallback for one product's own images —
 * a list of at most a handful of tiles. This list is the WHOLE catalogue,
 * every row already carries two focusable controls, and up/down buttons need
 * no pointer at all: Tab and Enter move a row exactly as reliably as a mouse
 * does, with no separate keyboard path to keep in sync with the pointer one.
 *
 * THE WHOLE CATALOGUE, IN MEMORY. This screen loses the point if it only
 * shows one cursor-paginated page — an operator could never move product 40
 * next to product 2. The server page that renders this asked for the API's
 * full 100-row ceiling in one request, which this store's real catalogue size
 * (see `docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md` §8)
 * sits comfortably inside.
 *
 * SAVES THE WHOLE ORDER, NOT A DIFF. The array position IS the value being
 * set — the same shape `setCategoriesSchema`/`setAddOnsSchema` already use for
 * an admin's OTHER ordered lists — so there is nothing to diff; one click
 * sends every id in its current position.
 */
export interface ProductReorderRow {
  readonly id: string;
  readonly name: string;
  readonly sku: string;
  readonly imageUrl: string | null;
}

interface ProductReorderListProps {
  readonly initial: readonly ProductReorderRow[];
  readonly onSave: (productIds: readonly string[]) => Promise<ActionResult<{ reordered: number }>>;
}

export function ProductReorderList({ initial, onSave }: ProductReorderListProps) {
  const t = useTranslations("admin.productReorder");
  const [rows, setRows] = useState<readonly ProductReorderRow[]>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function move(index: number, direction: -1 | 1): void {
    const target = index + direction;
    if (target < 0 || target >= rows.length) return;

    setSaved(false);
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

  async function handleSave(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const result = await onSave(rows.map((row) => row.id));
      if (!result.ok) {
        setError(t("saveFailed"));
        return;
      }
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  if (rows.length === 0) {
    return <Notice tone="warning">{t("empty")}</Notice>;
  }

  return (
    <div className="grid gap-3">
      <p className="text-[13px] text-[var(--label-secondary)]">{t("hint")}</p>

      <ol className="grid gap-1.5">
        {rows.map((row, index) => (
          <li
            key={row.id}
            className="flex items-center gap-3 rounded-[var(--r-card)] border border-[var(--separator-weak)] bg-[var(--bg-grouped-secondary)] p-2"
          >
            <span className="w-6 shrink-0 text-center font-mono text-[12px] text-[var(--label-secondary)]">
              {index + 1}
            </span>
            {row.imageUrl === null ? (
              <div className="size-10 shrink-0 rounded-[var(--r-check)] bg-[var(--fill-tertiary)]" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- an admin thumbnail off an arbitrary storage host, same reasoning variant-image.tsx gives.
              <img
                src={row.imageUrl}
                alt=""
                className="size-10 shrink-0 rounded-[var(--r-check)] object-cover"
              />
            )}
            <div className="min-w-0 flex-1">
              <p className="m-0 truncate text-[13px] font-medium text-[var(--label)]">
                {row.name}
              </p>
              <p className="m-0 truncate font-mono text-[11px] text-[var(--label-secondary)]">
                {row.sku}
              </p>
            </div>
            <div className="flex shrink-0 gap-1">
              <IconButton
                label={t("moveUp", { name: row.name })}
                icon="chevron-down"
                className="rotate-180"
                variant="standard"
                size="mini"
                disabled={index === 0 || saving}
                onClick={() => move(index, -1)}
              />
              <IconButton
                label={t("moveDown", { name: row.name })}
                icon="chevron-down"
                variant="standard"
                size="mini"
                disabled={index === rows.length - 1 || saving}
                onClick={() => move(index, 1)}
              />
            </div>
          </li>
        ))}
      </ol>

      {error !== null && <Notice tone="danger">{error}</Notice>}
      {saved && <Notice tone="success">{t("saveSuccess")}</Notice>}

      <div className="justify-self-end">
        <Button variant="prominent" size="compact" disabled={saving} onClick={() => void handleSave()}>
          {saving ? t("saving") : t("save")}
        </Button>
      </div>
    </div>
  );
}
