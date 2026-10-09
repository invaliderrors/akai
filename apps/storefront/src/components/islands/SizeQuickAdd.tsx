
import type { Messages } from "@/i18n/messages";
import type { SizeOption } from "@/lib/view";

import { useQuickAdd } from "./use-quick-add";

interface Props {
  readonly apiUrl: string;
  readonly sizes: readonly SizeOption[];
  readonly t: Pick<Messages["home"]["grid"], "addSize" | "addedToCart">;
  readonly errors: Messages["errors"];
}

/**
 * A product tile's size row: one tap adds that size. The banner it raises is
 * positioned against the tile (`astro-island` is `display: contents`).
 */
export default function SizeQuickAdd({ apiUrl, sizes, t, errors }: Props) {
  const { status, add } = useQuickAdd(apiUrl, errors);

  return (
    <>
      <div className={`mt-1.5 grid gap-[2px] ${sizes.length === 1 ? "grid-cols-1" : "grid-cols-5"}`}>
        {sizes.map((size) => (
          <button
            key={size.label}
            type="button"
            aria-label={`${t.addSize} ${size.label}`}
            disabled={size.variantId === null || status.kind === "adding"}
            onClick={() => {
              if (size.variantId !== null) void add(size.variantId);
            }}
            className="h-[34px] cursor-pointer rounded-[2px] border-0 bg-ink/5 p-0 font-mono text-[10px] text-ink transition-colors duration-150 hover:bg-akai hover:text-white disabled:cursor-not-allowed disabled:opacity-35 disabled:line-through disabled:hover:bg-ink/5 disabled:hover:text-ink"
          >
            {size.label}
          </button>
        ))}
      </div>
      <p
        role="status"
        className={
          status.kind === "added" || status.kind === "error"
            ? `absolute inset-x-0 bottom-0 m-0 rounded-[2px] p-[11px] text-center font-mono text-[11px] font-bold tracking-[.08em] text-white ${
                status.kind === "added" ? "bg-akai" : "bg-ink"
              }`
            : "sr-only"
        }
      >
        {status.kind === "added" ? t.addedToCart : status.kind === "error" ? status.message : ""}
      </p>
    </>
  );
}
