import {
  DESTINATION_COUNTRY_CODES,
  type Cart,
  type Locale,
  type ShippingOptionDto,
} from "@akai/contracts";
import { formatMoney } from "@akai/money";
import { useEffect, useMemo, useState, type SyntheticEvent } from "react";

import type { Messages } from "@/i18n/messages";
import { CartClient } from "@/lib/cart-client";
import { pickLocaleText } from "@/lib/view";

interface Props {
  readonly apiUrl: string;
  readonly locale: Locale;
  readonly cartHref: string;
  readonly termsVersion: string;
  readonly t: Messages["checkout"];
}

const FIELDS = ["firstName", "lastName", "line1", "houseNumber", "line2", "city", "postalCode", "region", "phone"] as const;
type Field = (typeof FIELDS)[number];
const OPTIONAL: ReadonlySet<Field> = new Set(["line2", "region"]);

/**
 * Guest checkout: address → shipping quote → hosted payment redirect.
 *
 * Only HOME delivery options are offered: SERVICE_POINT rates need a pickup
 * point search the API does not expose yet, and checkout would reject them
 * without a `servicePointId`.
 */
export default function CheckoutForm({ apiUrl, locale, cartHref, termsVersion, t }: Props) {
  const client = useMemo(() => new CartClient(apiUrl, locale), [apiUrl, locale]);
  const countries = useMemo(() => {
    const names = new Intl.DisplayNames([locale], { type: "region" });
    return DESTINATION_COUNTRY_CODES.map((code) => ({ code, name: names.of(code) ?? code })).sort((a, b) =>
      a.name.localeCompare(b.name, locale),
    );
  }, [locale]);

  const [cart, setCart] = useState<Cart | null | undefined>(undefined);
  const [email, setEmail] = useState("");
  const [countryCode, setCountryCode] = useState("ES");
  const [address, setAddress] = useState<Record<Field, string>>(
    Object.fromEntries(FIELDS.map((field) => [field, ""])) as Record<Field, string>,
  );
  const [options, setOptions] = useState<readonly ShippingOptionDto[] | null>(null);
  const [rateId, setRateId] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per checkout attempt: a double submit replays, it does not duplicate.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    client.fetch().then(setCart, () => setCart(null));
  }, [client]);

  async function quote() {
    setError(null);
    try {
      const response = await client.quote({ countryCode, postalCode: address.postalCode || null });
      const home = response.options.filter((option) => option.deliveryType === "HOME");
      setOptions(home);
      setRateId(home[0]?.rateId ?? null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t.failed);
    }
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (cart === null || cart === undefined || rateId === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const nullable = (value: string) => (value.trim() === "" ? null : value.trim());
      const session = await client.startCheckout(
        {
          cartId: cart.id,
          email,
          shippingAddress: {
            firstName: address.firstName,
            lastName: address.lastName,
            company: null,
            line1: address.line1,
            houseNumber: address.houseNumber,
            line2: nullable(address.line2),
            city: address.city,
            region: nullable(address.region),
            postalCode: address.postalCode,
            countryCode,
            phone: address.phone,
          },
          shippingMethodId: rateId,
          locale,
          acceptedTermsVersion: termsVersion,
        },
        idempotencyKey,
      );
      window.location.assign(session.checkoutUrl);
    } catch (cause: unknown) {
      setSubmitting(false);
      setError(cause instanceof Error ? cause.message : t.failed);
    }
  }

  if (cart === undefined) return null;
  if (cart === null || cart.items.length === 0) {
    if (typeof window !== "undefined") window.location.replace(cartHref);
    return null;
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-10 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-10">
        <section className="space-y-4">
          <h2 className="font-display text-2xl uppercase">{t.contact}</h2>
          <label className="block">
            <span className="label">{t.email}</span>
            <input
              className="field"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
        </section>

        <section className="space-y-4">
          <h2 className="font-display text-2xl uppercase">{t.shipping}</h2>
          <label className="block">
            <span className="label">{t.country}</span>
            <select
              className="field"
              value={countryCode}
              onChange={(event) => {
                setCountryCode(event.target.value);
                setOptions(null);
                setRateId(null);
              }}
            >
              {countries.map((country) => (
                <option key={country.code} value={country.code}>
                  {country.name}
                </option>
              ))}
            </select>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            {FIELDS.map((field) => (
              <label key={field} className={field === "line1" || field === "line2" ? "block sm:col-span-2" : "block"}>
                <span className="label">{t[field]}</span>
                <input
                  className="field"
                  required={!OPTIONAL.has(field)}
                  type={field === "phone" ? "tel" : "text"}
                  value={address[field]}
                  onChange={(event) => {
                    const value = event.target.value;
                    setAddress((previous) => ({ ...previous, [field]: value }));
                    if (field === "postalCode") setOptions(null);
                  }}
                />
              </label>
            ))}
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="font-display text-2xl uppercase">{t.method}</h2>
          {options === null ? (
            <button type="button" className="btn-outline" onClick={() => void quote()}>
              {t.quote}
            </button>
          ) : options.length === 0 ? (
            <p className="text-akai">{t.noMethods}</p>
          ) : (
            <div className="space-y-2">
              {options.map((option) => (
                <label key={option.rateId} className="flex cursor-pointer items-center gap-3 border border-line p-4 has-[:checked]:border-ink">
                  <input
                    type="radio"
                    name="rate"
                    checked={rateId === option.rateId}
                    onChange={() => setRateId(option.rateId)}
                  />
                  <span className="flex-1">{pickLocaleText(option.name, locale)}</span>
                  <span className="tabular-nums">
                    {option.isFree ? t.free : formatMoney(option.priceGross, option.currency, locale)}
                  </span>
                </label>
              ))}
            </div>
          )}
        </section>
      </div>

      <aside className="h-fit space-y-4 border border-ink p-6">
        <ul className="space-y-2 text-sm">
          {cart.items.map((item) => (
            <li key={item.id} className="flex justify-between gap-3">
              <span>
                {item.name}
                {item.variantName ? ` — ${item.variantName}` : ""} × {item.quantity}
              </span>
              <span className="tabular-nums">{formatMoney(item.lineTotalGross, cart.totals.currency, locale)}</span>
            </li>
          ))}
        </ul>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" required checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
          {t.terms}
        </label>
        <button type="submit" className="btn w-full" disabled={submitting || rateId === null || !accepted}>
          {submitting ? t.paying : t.pay}
        </button>
        {error && (
          <p role="alert" className="text-sm text-akai">
            {error}
          </p>
        )}
      </aside>
    </form>
  );
}
