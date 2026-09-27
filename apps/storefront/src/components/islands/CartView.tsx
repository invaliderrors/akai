import type { Cart, CartItem, Locale, Minor } from "@akai/contracts";
import { formatMoney } from "@akai/money";
import { useEffect, useMemo, useState } from "react";

import type { Messages } from "@/i18n/messages";
import { CartClient } from "@/lib/cart-client";

interface Props {
  readonly apiUrl: string;
  readonly locale: Locale;
  readonly shopHref: string;
  readonly checkoutHref: string;
  readonly productHrefBase: string;
  readonly t: Messages["cart"];
  readonly problems: Messages["cartProblems"];
}

type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; cart: Cart | null };

export default function CartView({ apiUrl, locale, shopHref, checkoutHref, productHrefBase, t, problems }: Props) {
  const client = useMemo(() => new CartClient(apiUrl, locale), [apiUrl, locale]);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    client
      .fetch()
      .then((cart) => setState({ kind: "ready", cart }))
      .catch(() => setState({ kind: "error" }));
  }, [client]);

  async function mutate(action: () => Promise<Cart>) {
    setBusy(true);
    try {
      setState({ kind: "ready", cart: await action() });
    } catch {
      setState({ kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  const removeItem = (item: CartItem) =>
    mutate(() => (item.packInstanceId === null ? client.remove(item.id) : client.removePack(item.packInstanceId)));

  if (state.kind === "loading") return <p className="text-stone">{t.loading}</p>;
  if (state.kind === "error") return <p className="text-akai">{t.error}</p>;

  const cart = state.cart;
  if (cart === null || cart.items.length === 0) {
    return (
      <div className="space-y-6">
        <p>{t.empty}</p>
        <a href={shopHref} className="btn-outline">
          {t.continue}
        </a>
      </div>
    );
  }

  const money = (amount: Minor) => formatMoney(amount, cart.totals.currency, locale);
  const problemFor = (itemId: string) => cart.problems.find((problem) => problem.itemId === itemId)?.code;

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_22rem]">
      <ul className="divide-y divide-line border-y border-ink" aria-busy={busy}>
        {cart.items.map((item) => (
          <li key={item.id} className="flex gap-4 py-5">
            <div className="h-28 w-24 shrink-0 border border-ink bg-line">
              {item.imageUrl && <img src={item.imageUrl} alt="" className="h-full w-full object-cover" />}
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <a href={`${productHrefBase}/${item.productSlug}`} className="font-bold uppercase hover:text-akai">
                {item.name}
              </a>
              {item.variantName && <p className="text-sm text-stone">{item.variantName}</p>}
              {problemFor(item.id) !== undefined && (
                <p className="text-sm text-akai">{problems[problemFor(item.id) ?? "PRODUCT_UNAVAILABLE"]}</p>
              )}
              <div className="mt-auto flex items-center gap-4">
                {item.packInstanceId === null ? (
                  <select
                    aria-label={item.name}
                    className="field w-20"
                    value={item.quantity}
                    disabled={busy}
                    onChange={(event) => void mutate(() => client.setQuantity(item.id, Number(event.target.value)))}
                  >
                    {Array.from({ length: Math.max(10, item.quantity) }, (_, index) => index + 1).map((quantity) => (
                      <option key={quantity} value={quantity}>
                        {quantity}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-sm">× {item.quantity}</span>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void removeItem(item)}
                  className="text-xs font-bold uppercase tracking-[0.15em] text-stone hover:text-akai"
                >
                  {t.remove}
                </button>
              </div>
            </div>
            <p className="tabular-nums">{money(item.lineTotalGross)}</p>
          </li>
        ))}
      </ul>

      <aside className="h-fit space-y-3 border border-ink p-6">
        <div className="flex justify-between text-sm">
          <span>{t.subtotal}</span>
          <span className="tabular-nums">{money(cart.totals.subtotal)}</span>
        </div>
        {cart.totals.discountTotal > 0 && (
          <div className="flex justify-between text-sm text-akai">
            <span>{t.discount}</span>
            <span className="tabular-nums">−{money(cart.totals.discountTotal)}</span>
          </div>
        )}
        <div className="flex justify-between border-t border-ink pt-3 font-bold">
          <span>{t.total}</span>
          <span className="tabular-nums">{money(cart.totals.grandTotal)}</span>
        </div>
        <a href={checkoutHref} className="btn mt-3 w-full">
          {t.checkout}
        </a>
      </aside>
    </div>
  );
}
