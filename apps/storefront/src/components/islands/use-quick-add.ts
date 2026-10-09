import { useEffect, useRef, useState } from "react";

import { errorMessage, type Messages } from "@/i18n/messages";
import { CartClient } from "@/lib/cart-client";

export type QuickAddStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "adding" }
  | { readonly kind: "added" }
  | { readonly kind: "error"; readonly message: string };

/** One-tap add to cart that flashes "added" (or the translated error), then resets. */
export function useQuickAdd(apiUrl: string, errors: Messages["errors"]) {
  const [status, setStatus] = useState<QuickAddStatus>({ kind: "idle" });
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function add(variantId: string) {
    window.clearTimeout(timer.current);
    setStatus({ kind: "adding" });
    let next: QuickAddStatus;
    try {
      await new CartClient(apiUrl).add(variantId, 1);
      next = { kind: "added" };
    } catch (cause: unknown) {
      next = { kind: "error", message: errorMessage(errors, cause) };
    }
    setStatus(next);
    timer.current = window.setTimeout(() => setStatus({ kind: "idle" }), next.kind === "added" ? 1400 : 2600);
  }

  return { status, add };
}
