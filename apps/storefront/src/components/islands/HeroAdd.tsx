
import type { Messages } from "@/i18n/messages";

import { useQuickAdd } from "./use-quick-add";

interface Props {
  readonly apiUrl: string;
  /** The product's only sellable variant — a product with a choice links to its page instead. */
  readonly variantId: string;
  readonly label: string;
  readonly addedLabel: string;
  readonly errors: Messages["errors"];
}

/** The hero card's one-tap add. */
export default function HeroAdd({ apiUrl, variantId, label, addedLabel, errors }: Props) {
  const { status, add } = useQuickAdd(apiUrl, errors);

  return (
    <button
      type="button"
      disabled={status.kind === "adding"}
      onClick={() => void add(variantId)}
      aria-live="polite"
      className="h-11 cursor-pointer rounded-full border-0 bg-ink font-sans text-[11px] font-extrabold uppercase tracking-[.08em] text-paper transition-colors duration-200 hover:bg-akai hover:text-white"
    >
      {status.kind === "added" ? addedLabel : status.kind === "error" ? status.message : label}
    </button>
  );
}
