import type { Cart, CartItem, Minor, Money } from "@akai/contracts";
import { formatMoney, subtract } from "@akai/money";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Messages } from "@/i18n/messages";
import { CART_CHANGED_EVENT, CartClient } from "@/lib/cart-client";

interface Props {
  readonly apiUrl: string;
  readonly checkoutHref: string;
  readonly productHrefBase: string;
  readonly t: Messages["cart"];
  readonly problems: Messages["cartProblems"];
}

/**
 * The slide-in cart. Any `[data-cart-open]` link opens it once this island
 * has hydrated; before that, the link simply goes to the cart page.
 */
export default function CartDrawer({ apiUrl, checkoutHref, productHrefBase, t, problems }: Props) {
  const client = useMemo(() => new CartClient(apiUrl), [apiUrl]);
  const [open, setOpen] = useState(false);
  const [cart, setCart] = useState<Cart | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [threshold, setThreshold] = useState<Money | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    returnFocus.current?.focus();
  }, []);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const trigger = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-cart-open]") : null;
      if (trigger === null) return;
      event.preventDefault();
      returnFocus.current = trigger;
      setOpen(true);
    };
    const onChange = (event: Event) => {
      if (event instanceof CustomEvent) setCart(event.detail as Cart);
    };
    document.addEventListener("click", onClick);
    window.addEventListener(CART_CHANGED_EVENT, onChange);
    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener(CART_CHANGED_EVENT, onChange);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    setFailed(false);
    client
      .fetch()
      .then(setCart)
      .catch(() => setFailed(true));
    client
      .freeShippingThreshold()
      .then(setThreshold)
      .catch(() => setThreshold(null));
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, client, close]);

  async function mutate(action: () => Promise<Cart>) {
    setBusy(true);
    try {
      setCart(await action());
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const step = (item: CartItem, delta: 1 | -1) =>
    mutate(() =>
      item.packInstanceId !== null
        ? client.removePack(item.packInstanceId)
        : client.setQuantity(item.id, item.quantity + delta),
    );

  if (!open) return null;

  const items = cart?.items ?? [];
  const currency = cart?.totals.currency ?? threshold?.currency;
  const money = (amount: Minor) => (currency === undefined ? "" : formatMoney(amount, currency));
  // Measured on the subtotal after discount, as the shipping quote is.
  const basis = cart === null ? null : subtract(cart.totals.subtotal, cart.totals.discountTotal);
  const ship =
    threshold === null || basis === null || cart === null || threshold.currency !== cart.totals.currency
      ? null
      : {
          pct: Math.min(1, basis / Math.max(1, threshold.amount)),
          label:
            basis >= threshold.amount
              ? t.unlocked
              : t.away.replace("{amount}", money(subtract(threshold.amount, basis))),
        };
  const problemFor = (itemId: string) => cart?.problems.find((problem) => problem.itemId === itemId)?.code;

  return (
    <>
      <div onClick={close} aria-hidden="true" className="fixed inset-0 z-[900] bg-ink/55" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={t.title}
        className="fixed inset-y-0 right-0 z-[901] flex w-[min(440px,100vw)] flex-col border-l border-ink bg-paper font-sans text-ink shadow-[-24px_0_48px_-24px_color-mix(in_srgb,var(--color-ink)_50%,transparent)]"
      >
        <div className="flex items-center justify-between gap-3 border-b border-ink px-5 py-4">
          <div className="flex items-center gap-3">
            <img src="/brand/akai-seal.png" alt="" width={203} height={207} className="block h-auto w-[30px]" />
            <span className="font-display text-[30px] uppercase leading-none">{t.title}</span>
            <span className="font-mono text-[12px] font-bold">({cart?.itemCount ?? 0})</span>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={close}
            aria-label={t.close}
            className="h-11 w-11 cursor-pointer rounded-full border border-ink bg-transparent font-mono text-[14px] text-ink hover:border-akai hover:text-akai"
          >
            ✕
          </button>
        </div>

        {ship !== null && (
          <div className="grid gap-2 border-b border-ink px-5 pb-[18px] pt-4">
            <div className="flex justify-between gap-3 font-mono text-[11px] uppercase tracking-[.06em]">
              <span>{t.freeShipping}</span>
              <span className="font-bold">{ship.label}</span>
            </div>
            <div className="relative h-3.5">
              <span className="absolute inset-x-0 top-1.5 border-t-[1.5px] border-dashed border-ink/40" />
              <span
                className="absolute left-0 top-[5.5px] h-[2.5px] rounded-[2px] bg-akai transition-[width] duration-500"
                style={{ width: `${(ship.pct * 100).toFixed(1)}%` }}
              />
              <span
                className="absolute top-px -ml-1.5 h-3 w-3 rounded-full bg-akai shadow-[0_0_0_2px_var(--color-paper)] transition-[left] duration-500"
                style={{ left: `${(ship.pct * 100).toFixed(1)}%` }}
              />
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-1" aria-busy={busy}>
          {failed && <p className="my-7 text-center font-mono text-[12px] uppercase tracking-[.06em] text-akai">{t.error}</p>}
          {!failed && items.length === 0 && (
            <p className="my-7 text-center font-mono text-[12px] uppercase tracking-[.06em]">{t.empty}</p>
          )}
          {items.map((item) => {
            const problem = problemFor(item.id);
            return (
              <div
                key={item.id}
                className="grid grid-cols-[72px_minmax(0,1fr)_auto] items-start gap-3.5 border-b border-ink/25 py-3.5"
              >
                <div className="relative aspect-[4/5] overflow-hidden rounded-[2px] bg-ink/5">
                  {item.imageUrl === null ? (
                    <span
                      aria-hidden="true"
                      className="absolute inset-0 bg-[radial-gradient(circle,color-mix(in_srgb,var(--color-ink)_22%,transparent)_1px,transparent_1.35px)] bg-[length:5px_5px] [mask-image:linear-gradient(150deg,transparent_20%,black)]"
                    />
                  ) : (
                    <img src={item.imageUrl} alt="" className="h-full w-full object-cover" />
                  )}
                </div>
                <div className="grid min-w-0 gap-1">
                  <a
                    href={`${productHrefBase}/${item.productSlug}`}
                    className="text-[13px] font-extrabold uppercase leading-[1.25] tracking-[.02em] no-underline"
                  >
                    {item.name}
                  </a>
                  {item.variantName !== null && (
                    <div className="font-mono text-[10px] uppercase tracking-[.04em]">{item.variantName}</div>
                  )}
                  {problem !== undefined && <div className="text-[12px] text-akai">{problems[problem]}</div>}
                  <div className="mt-1.5 inline-flex h-9 items-center justify-self-start rounded-full border border-ink">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void step(item, -1)}
                      aria-label={item.quantity === 1 || item.packInstanceId !== null ? t.remove : t.decrease}
                      className="h-[34px] w-9 cursor-pointer rounded-full border-0 bg-transparent font-mono text-[14px] text-ink hover:text-akai"
                    >
                      −
                    </button>
                    <span className="min-w-[22px] text-center font-mono text-[12px] font-bold">{item.quantity}</span>
                    <button
                      type="button"
                      disabled={busy || item.packInstanceId !== null || item.quantity >= 99}
                      onClick={() => void step(item, 1)}
                      aria-label={t.increase}
                      className="h-[34px] w-9 cursor-pointer rounded-full border-0 bg-transparent font-mono text-[14px] text-ink hover:text-akai disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      +
                    </button>
                  </div>
                </div>
                <div className="font-mono text-[13px] font-bold">{money(item.lineTotalGross)}</div>
              </div>
            );
          })}
        </div>

        <div className="grid gap-2.5 border-t border-ink px-5 pb-5 pt-4">
          {cart !== null && cart.totals.discountTotal > 0 && (
            <div className="flex items-center justify-between font-mono text-[12px] uppercase tracking-[.04em]">
              <span>{t.discount}</span>
              <span className="rounded-[2px] bg-akai px-2 py-[3px] font-bold text-white">
                −{money(cart.totals.discountTotal)}
              </span>
            </div>
          )}
          <div className="flex justify-between font-mono text-[15px] font-bold uppercase">
            <span>{t.subtotal}</span>
            <span>{basis === null ? "" : money(basis)}</span>
          </div>
          <div className="font-mono text-[10px] uppercase tracking-[.04em]">{t.note}</div>
          {items.length > 0 && (
            <a
              href={checkoutHref}
              className="flex h-[58px] items-center justify-center rounded-full bg-akai font-sans text-[19px] font-extrabold uppercase tracking-[.04em] text-paper no-underline transition-colors duration-200 hover:bg-ink hover:text-paper"
            >
              {t.checkout} →
            </a>
          )}
        </div>
      </aside>
    </>
  );
}
