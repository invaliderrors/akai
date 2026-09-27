import type { Locale, PublicProductVariant } from "@akai/contracts";
import { formatMoney } from "@akai/money";
import { useMemo, useState } from "react";

import { errorMessage, type Messages } from "@/i18n/messages";
import { CartClient } from "@/lib/cart-client";
import { isSellable, pickLocaleText } from "@/lib/view";

interface Props {
  readonly apiUrl: string;
  readonly locale: Locale;
  readonly variants: readonly PublicProductVariant[];
  readonly cartHref: string;
  readonly t: Messages["product"];
  readonly errors: Messages["errors"];
}

type Status = "idle" | "adding" | "added" | "error";

/** A variant's label: its translated name, else its options ("M · Black"). */
function variantLabel(variant: PublicProductVariant, locale: Locale): string {
  return pickLocaleText(variant.name, locale) ?? (Object.values(variant.options).join(" · ") || variant.sku);
}

export default function AddToCart({ apiUrl, locale, variants, cartHref, t, errors }: Props) {
  const active = useMemo(() => variants.filter((variant) => variant.isActive), [variants]);
  const [selectedId, setSelectedId] = useState<string | null>(
    active.length === 1 ? (active[0]?.id ?? null) : (active.find(isSellable)?.id ?? null),
  );
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  const selected = active.find((variant) => variant.id === selectedId) ?? null;
  const canAdd = selected !== null && isSellable(selected) && status !== "adding";

  async function add() {
    if (selected === null) return;
    setStatus("adding");
    setError(null);
    try {
      await new CartClient(apiUrl, locale).add(selected.id, 1);
      setStatus("added");
    } catch (cause: unknown) {
      setStatus("error");
      setError(errorMessage(errors, cause));
    }
  }

  return (
    <div className="space-y-5">
      {selected && (
        <p className="font-display text-3xl tabular-nums">
          {formatMoney(selected.price.gross, selected.price.currency, locale)}
          {selected.price.compareAtGross !== null && (
            <s className="ml-3 text-lg text-stone">
              {formatMoney(selected.price.compareAtGross, selected.price.currency, locale)}
            </s>
          )}
        </p>
      )}

      {active.length > 1 && (
        <fieldset>
          <legend className="label">{t.selectOption}</legend>
          <div className="flex flex-wrap gap-2">
            {active.map((variant) => {
              const sellable = isSellable(variant);
              const isSelected = variant.id === selectedId;
              return (
                <button
                  key={variant.id}
                  type="button"
                  aria-pressed={isSelected}
                  disabled={!sellable}
                  onClick={() => {
                    setSelectedId(variant.id);
                    setStatus("idle");
                  }}
                  className={`min-w-14 border px-4 py-2 text-sm font-bold uppercase ${
                    isSelected ? "border-ink bg-ink text-paper" : "border-line hover:border-ink"
                  } disabled:cursor-not-allowed disabled:text-stone disabled:line-through`}
                >
                  {variantLabel(variant, locale)}
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

      <button type="button" className="btn w-full" disabled={!canAdd} onClick={() => void add()}>
        {selected !== null && !isSellable(selected)
          ? t.soldOut
          : status === "adding"
            ? t.adding
            : t.addToCart}
      </button>

      <p role="status" className="min-h-5 text-sm">
        {status === "added" && (
          <>
            {t.added} —{" "}
            <a href={cartHref} className="underline hover:text-akai">
              {t.viewCart}
            </a>
          </>
        )}
        {status === "error" && <span className="text-akai">{error}</span>}
      </p>
    </div>
  );
}
