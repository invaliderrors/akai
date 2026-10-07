import {
  COLOMBIAN_DEPARTAMENTOS,
  STORE_COUNTRY_CODE,
  identityDocumentTypeSchema,
  normaliseColombianMobile,
  normaliseDocumentNumber,
  type Cart,
  type IdentityDocumentType,
  type Locale,
  type ShippingOptionDto,
} from "@akai/contracts";
import { formatMoney } from "@akai/money";
import { useEffect, useMemo, useState, type SyntheticEvent } from "react";

import { errorMessage, type Messages } from "@/i18n/messages";
import { CartClient } from "@/lib/cart-client";
import { pickLocaleText } from "@/lib/view";

interface Props {
  readonly apiUrl: string;
  readonly locale: Locale;
  readonly cartHref: string;
  readonly termsVersion: string;
  readonly t: Messages["checkout"];
  readonly errors: Messages["errors"];
}

const TEXT_FIELDS = ["firstName", "lastName", "line1", "line2", "city", "phone"] as const;
type TextField = (typeof TEXT_FIELDS)[number];
const OPTIONAL: ReadonlySet<TextField> = new Set(["line2"]);
const WIDE: ReadonlySet<TextField> = new Set(["line1", "line2"]);

const EMPTY_ADDRESS: Readonly<Record<TextField, string>> = {
  firstName: "",
  lastName: "",
  line1: "",
  line2: "",
  city: "",
  phone: "",
};

/**
 * Guest checkout: Colombian address + identity document → shipping quote →
 * hosted payment redirect.
 *
 * Colombia is the only country served, so it is fixed rather than offered.
 * The departamento comes from the contracts' closed list, the number goes in
 * the street line ("Calle 10 # 43-21"), and the buyer's identity document
 * (type + number) is required — the order snapshots it.
 *
 * Phone and document are checked here with the SAME normalisers the API uses,
 * so the shopper is told what to fix before the round trip; the API stays the
 * authority.
 */
export default function CheckoutForm({ apiUrl, locale, cartHref, termsVersion, t, errors }: Props) {
  const client = useMemo(() => new CartClient(apiUrl, locale), [apiUrl, locale]);

  const [cart, setCart] = useState<Cart | null | undefined>(undefined);
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState<Record<TextField, string>>({ ...EMPTY_ADDRESS });
  const [region, setRegion] = useState("");
  const [documentType, setDocumentType] = useState<IdentityDocumentType>("CC");
  const [documentNumber, setDocumentNumber] = useState("");
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
      const response = await client.quote({ countryCode: STORE_COUNTRY_CODE, postalCode: null });
      setOptions(response.options);
      setRateId(response.options[0]?.rateId ?? null);
    } catch (cause: unknown) {
      setError(errorMessage(errors, cause));
    }
  }

  // The destination is fixed, so the methods can be priced as soon as the cart
  // is known — no address field changes them.
  useEffect(() => {
    if (cart === null || cart === undefined || cart.items.length === 0) return;
    let cancelled = false;
    client.quote({ countryCode: STORE_COUNTRY_CODE, postalCode: null }).then(
      (response) => {
        if (cancelled) return;
        setOptions(response.options);
        setRateId(response.options[0]?.rateId ?? null);
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorMessage(errors, cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, cart, errors]);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (cart === null || cart === undefined || rateId === null) return;

    if (normaliseColombianMobile(address.phone) === null) {
      setError(t.invalidPhone);
      return;
    }
    if (normaliseDocumentNumber(documentType, documentNumber) === null) {
      setError(t.invalidDocument);
      return;
    }

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
            line2: nullable(address.line2),
            city: address.city,
            region,
            postalCode: null,
            countryCode: STORE_COUNTRY_CODE,
            phone: address.phone,
          },
          shippingMethodId: rateId,
          documentType,
          documentNumber,
          locale,
          acceptedTermsVersion: termsVersion,
        },
        idempotencyKey,
      );
      window.location.assign(session.checkoutUrl);
    } catch (cause: unknown) {
      setSubmitting(false);
      setError(errorMessage(errors, cause));
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
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="label">{t.documentType}</span>
              <select
                className="field"
                value={documentType}
                onChange={(event) => {
                  const parsed = identityDocumentTypeSchema.safeParse(event.target.value);
                  if (parsed.success) setDocumentType(parsed.data);
                }}
              >
                {identityDocumentTypeSchema.options.map((type) => (
                  <option key={type} value={type}>
                    {t.documentTypes[type]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">{t.documentNumber}</span>
              <input
                className="field"
                type="text"
                required
                maxLength={32}
                value={documentNumber}
                onChange={(event) => setDocumentNumber(event.target.value)}
              />
            </label>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="font-display text-2xl uppercase">{t.shipping}</h2>
          <p className="text-sm text-stone">{t.countryFixed}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {TEXT_FIELDS.map((field) => (
              <label key={field} className={WIDE.has(field) ? "block sm:col-span-2" : "block"}>
                <span className="label">{t[field]}</span>
                <input
                  className="field"
                  required={!OPTIONAL.has(field)}
                  type={field === "phone" ? "tel" : "text"}
                  inputMode={field === "phone" ? "numeric" : undefined}
                  autoComplete={field === "phone" ? "tel-national" : undefined}
                  value={address[field]}
                  onChange={(event) => {
                    const value = event.target.value;
                    setAddress((previous) => ({ ...previous, [field]: value }));
                  }}
                />
              </label>
            ))}
            <label className="block">
              <span className="label">{t.region}</span>
              <select className="field" required value={region} onChange={(event) => setRegion(event.target.value)}>
                <option value="" disabled>
                  {t.regionPlaceholder}
                </option>
                {COLOMBIAN_DEPARTAMENTOS.map((departamento) => (
                  <option key={departamento.code} value={departamento.name}>
                    {departamento.name}
                  </option>
                ))}
              </select>
            </label>
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
