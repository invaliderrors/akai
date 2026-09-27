import type { EmailTemplateKey, Locale, Money } from "@akai/contracts";
import { formatMoneyValue } from "@akai/money";
import type { EmailOrderLine, EmailPayloadFor } from "./email.templates";

/**
 * RENDERING, AND WHY IT IS BLOCK-BASED.
 *
 * Templates never produce HTML. They produce a typed `Block[]`, and the single
 * layout below turns blocks into HTML — escaping every interpolated value on
 * the way out.
 *
 * That is a structural guarantee rather than a discipline: a template PHYSICALLY
 * CANNOT emit unescaped markup, because it never handles a string that reaches
 * the output unescaped. The alternative (template literals returning HTML) means
 * every future template author must remember to escape a customer-supplied name,
 * and the one who forgets ships a mail whose body is attacker-controlled markup
 * — rendered in the recipient's client, and in the admin dashboard preview.
 *
 * Rendering is PURE and synchronous: no I/O, no clock, no config. That is what
 * lets every template be asserted in a unit test in both locales without a
 * database or a network.
 */

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export type Block =
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "button"; readonly label: string; readonly url: string }
  | {
      readonly kind: "keyValue";
      readonly rows: readonly {
        readonly label: string;
        readonly value: string;
        readonly strong?: boolean;
      }[];
    }
  | { readonly kind: "lineItems"; readonly items: readonly EmailOrderLine[] }
  | { readonly kind: "note"; readonly text: string };

interface TemplateContent {
  readonly subject: string;
  /** Inbox preview line. Absent, clients scrape the first body text instead. */
  readonly preheader: string;
  readonly blocks: readonly Block[];
}

type TemplateRenderer<K extends EmailTemplateKey> = (
  payload: EmailPayloadFor<K>,
  locale: Locale,
) => TemplateContent;

// ---------------------------------------------------------------------------
// Escaping and safe URLs
// ---------------------------------------------------------------------------

/**
 * HTML-escape. Covers the five characters that can break out of either an
 * element body or a quoted attribute value.
 *
 * `'` and `"` are both escaped because block values land in `href="..."` as
 * well as in text nodes, and an unescaped quote there is an attribute-injection
 * vector (`" onclick="`), not merely a rendering glitch.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Reject any URL scheme other than http(s) before it reaches an `href`.
 *
 * `z.string().url()` is NOT sufficient: it is backed by `new URL()`, which
 * happily accepts `javascript:alert(1)` and `data:text/html,...`. Payload
 * schemas already refine to http(s), so this is the second layer — the one that
 * still holds if a future schema is written with a bare `.url()`.
 *
 * Returns a harmless placeholder rather than throwing: a bad link must not turn
 * an order confirmation into an undeliverable email.
 */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : "#";
  } catch {
    return "#";
  }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function formatDate(iso: string, locale: Locale): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(locale === "es" ? "es-ES" : "en-IE", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(parsed);
}

function money(value: Money, locale: Locale): string {
  return formatMoneyValue(value, locale);
}

function lineLabel(item: EmailOrderLine): string {
  return item.variantName === undefined
    ? item.name
    : `${item.name} — ${item.variantName}`;
}

// ---------------------------------------------------------------------------
// Design tokens
//
// Pulled from the storefront's own @theme block (apps/storefront/src/app/
// globals.css), not invented separately — an order confirmation should read
// as the same brand as the site it was bought on. Font STACKS rather than a
// web-font load: a mail client cannot be trusted to fetch one, so Schibsted
// Grotesk/Instrument Serif/JetBrains Mono are approximated with safe system
// fallbacks that carry the same character (sans body, serif display,
// monospace for anything numeric or code-like — prices, SKUs and references,
// applied here to order numbers, invoice numbers, dates and the sign-in code).
// ---------------------------------------------------------------------------

const COLOR_INK = "#0d0f15";
const COLOR_MUTED = "#565b67";
const COLOR_LINE = "rgba(13,15,21,.11)";
const COLOR_LINE_STRONG = "rgba(13,15,21,.35)";
const COLOR_ACCENT = "#2b2fd9";
// SINGLE-quoted multi-word font names, deliberately — every one of these
// stacks is embedded inside an HTML attribute already delimited with double
// quotes (style="..."), and a double-quoted "Segoe UI" inside that breaks
// the attribute at the first quote, corrupting everything after it in the
// tag. CSS accepts single quotes for a font-family name; HTML attributes do
// not accept an unescaped double quote inside a double-quoted value.
const FONT_SANS = `-apple-system,'Segoe UI',Helvetica,Arial,sans-serif`;
const FONT_SERIF = `Georgia,'Times New Roman',serif`;
const FONT_MONO = `ui-monospace,'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace`;

/** The one place the wordmark string lives, so the masthead and sign-off can't drift. */
const BRAND = "AKAI";

function blockToHtml(block: Block, locale: Locale): string {
  switch (block.kind) {
    case "heading":
      return (
        `<h1 style="font-family:${FONT_SERIF};font-weight:400;font-size:22px;` +
        `line-height:1.3;margin:0 0 18px;color:${COLOR_INK};">${escapeHtml(block.text)}</h1>`
      );

    case "paragraph":
      return (
        `<p style="margin:0 0 16px;line-height:1.65;color:${COLOR_INK};">` +
        `${escapeHtml(block.text)}</p>`
      );

    case "button": {
      const href = escapeHtml(safeUrl(block.url));
      return (
        `<p style="margin:28px 0;">` +
        `<a href="${href}" style="background:${COLOR_ACCENT};color:#fff;padding:13px 26px;` +
        `border-radius:4px;text-decoration:none;display:inline-block;font-size:14px;` +
        `font-weight:500;letter-spacing:.01em;">${escapeHtml(block.label)}</a></p>`
      );
    }

    case "keyValue": {
      // A `strong` row (always the grand/settled total in practice) reads as
      // a receipt's sum: a heavier rule ABOVE it rather than a line below,
      // since it is the row every other row here is building toward.
      const rows = block.rows
        .map((row) => {
          const strong = row.strong === true;
          const border = strong
            ? `border-top:1px solid ${COLOR_LINE_STRONG};`
            : `border-bottom:1px solid ${COLOR_LINE};`;
          const padding = strong ? "12px 0 4px" : "9px 0";
          return (
            `<tr><td style="padding:${padding};${border}font-size:14px;color:${COLOR_MUTED};">` +
            `${escapeHtml(row.label)}</td>` +
            `<td style="padding:${padding};${border}text-align:right;` +
            `font-family:${FONT_MONO};font-size:14px;font-weight:${strong ? "600" : "400"};` +
            `color:${COLOR_INK};">${escapeHtml(row.value)}</td></tr>`
          );
        })
        .join("");
      return (
        `<table role="presentation" width="100%" style="margin:18px 0;border-collapse:collapse;">` +
        `${rows}</table>`
      );
    }

    case "lineItems": {
      const rows = block.items
        .map(
          (item) =>
            `<tr><td style="padding:9px 0;border-bottom:1px solid ${COLOR_LINE};` +
            `font-size:14px;color:${COLOR_INK};">${escapeHtml(lineLabel(item))} ` +
            `<span style="font-family:${FONT_MONO};font-size:12.5px;color:${COLOR_MUTED};">` +
            `&times;${escapeHtml(String(item.quantity))}</span></td>` +
            `<td style="padding:9px 0;border-bottom:1px solid ${COLOR_LINE};text-align:right;` +
            `font-family:${FONT_MONO};font-size:14px;color:${COLOR_INK};">` +
            `${escapeHtml(money(item.lineTotal, locale))}</td></tr>`,
        )
        .join("");
      return (
        `<table role="presentation" width="100%" style="margin:18px 0;border-collapse:collapse;">` +
        `${rows}</table>`
      );
    }

    case "note":
      return (
        `<p style="margin:20px 0 0;font-size:12.5px;line-height:1.6;color:${COLOR_MUTED};">` +
        `${escapeHtml(block.text)}</p>`
      );
  }
}

function blockToText(block: Block, locale: Locale): string {
  switch (block.kind) {
    case "heading":
      return `${block.text}\n${"=".repeat(Math.min(block.text.length, 60))}`;
    case "paragraph":
      return block.text;
    case "button":
      return `${block.label}: ${safeUrl(block.url)}`;
    case "keyValue":
      return block.rows.map((row) => `${row.label}: ${row.value}`).join("\n");
    case "lineItems":
      return block.items
        .map(
          (item) =>
            `- ${lineLabel(item)} x${item.quantity}  ${money(item.lineTotal, locale)}`,
        )
        .join("\n");
    case "note":
      return block.text;
  }
}

/**
 * Opens and closes every mail with the same quiet identity mark — a plain
 * wordmark above a hairline rule, and a smaller, muted echo of it below the
 * last block. No fill anywhere: the ask was specifically "no background
 * colors, etc.", so the whole page stays the recipient's own background
 * and typography, spacing and 1px rules carry the design instead of a card.
 */
function wrapHtml(content: TemplateContent, locale: Locale): string {
  const body = content.blocks.map((block) => blockToHtml(block, locale)).join("\n");
  const preheader =
    `<span style="display:none;max-height:0;overflow:hidden;">` +
    `${escapeHtml(content.preheader)}</span>`;

  const masthead =
    `<div style="padding-bottom:20px;margin-bottom:28px;border-bottom:1px solid ${COLOR_LINE};">` +
    `<span style="font-family:${FONT_MONO};font-size:12px;font-weight:500;` +
    `letter-spacing:.16em;color:${COLOR_INK};">${BRAND}</span></div>`;

  const signoff =
    `<div style="padding-top:24px;margin-top:32px;border-top:1px solid ${COLOR_LINE};">` +
    `<span style="font-family:${FONT_MONO};font-size:11px;letter-spacing:.12em;` +
    `color:${COLOR_MUTED};">${BRAND}</span></div>`;

  return (
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width"><title>` +
    `${escapeHtml(content.subject)}</title></head>` +
    `<body style="margin:0;padding:40px 24px;font-family:${FONT_SANS};color:${COLOR_INK};">` +
    `${preheader}` +
    `<div style="max-width:560px;margin:0 auto;">${masthead}${body}${signoff}</div>` +
    `</body></html>`
  );
}

function wrapText(content: TemplateContent, locale: Locale): string {
  const body = content.blocks
    .map((block) => blockToText(block, locale))
    .filter((part) => part.length > 0)
    .join("\n\n");
  return `${BRAND}\n\n${body}\n\n---\n${BRAND}\n`;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * Bilingual by construction: `Record<Locale, T>` means a template cannot ship
 * with only English copy. Spec §10 calls an English-only confirmation for a
 * Spanish-default store a launch blocker, so the type system enforces it rather
 * than a review checklist.
 */
type Bilingual<T> = Readonly<Record<Locale, T>>;

function pick<T>(copy: Bilingual<T>, locale: Locale): T {
  return copy[locale];
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const renderVerifyEmail: TemplateRenderer<"verify-email"> = (payload, locale) => {
  const copy = pick(
    {
      es: {
        subject: "Confirma tu correo electrónico",
        preheader: "Un último paso para activar tu cuenta.",
        greeting: `Hola ${payload.firstName},`,
        body: "Confirma tu dirección de correo para activar tu cuenta de Akai.",
        button: "Confirmar correo",
        expiry: `Este enlace caduca en ${payload.expiresInHours} horas.`,
        ignore: "Si no has creado una cuenta, puedes ignorar este mensaje.",
      },
      en: {
        subject: "Confirm your email address",
        preheader: "One last step to activate your account.",
        greeting: `Hi ${payload.firstName},`,
        body: "Confirm your email address to activate your Akai account.",
        button: "Confirm email",
        expiry: `This link expires in ${payload.expiresInHours} hours.`,
        ignore: "If you did not create an account, you can ignore this message.",
      },
    },
    locale,
  );

  return {
    subject: copy.subject,
    preheader: copy.preheader,
    blocks: [
      { kind: "heading", text: copy.subject },
      { kind: "paragraph", text: copy.greeting },
      { kind: "paragraph", text: copy.body },
      { kind: "button", label: copy.button, url: payload.verifyUrl },
      { kind: "note", text: `${copy.expiry} ${copy.ignore}` },
    ],
  };
};

const renderResetPassword: TemplateRenderer<"reset-password"> = (payload, locale) => {
  const copy = pick(
    {
      es: {
        subject: "Restablecer tu contraseña",
        preheader: "Enlace para crear una contraseña nueva.",
        greeting: `Hola ${payload.firstName},`,
        body: "Hemos recibido una solicitud para restablecer tu contraseña.",
        button: "Crear contraseña nueva",
        expiry: `El enlace caduca en ${payload.expiresInMinutes} minutos y solo puede usarse una vez.`,
        ignore:
          "Si no has solicitado el cambio, ignora este mensaje: tu contraseña actual sigue siendo válida.",
      },
      en: {
        subject: "Reset your password",
        preheader: "Link to set a new password.",
        greeting: `Hi ${payload.firstName},`,
        body: "We received a request to reset your password.",
        button: "Set a new password",
        expiry: `The link expires in ${payload.expiresInMinutes} minutes and can be used only once.`,
        ignore:
          "If you did not request this, ignore this message — your current password still works.",
      },
    },
    locale,
  );

  return {
    subject: copy.subject,
    preheader: copy.preheader,
    blocks: [
      { kind: "heading", text: copy.subject },
      { kind: "paragraph", text: copy.greeting },
      { kind: "paragraph", text: copy.body },
      { kind: "button", label: copy.button, url: payload.resetUrl },
      { kind: "note", text: `${copy.expiry} ${copy.ignore}` },
    ],
  };
};

/**
 * NO BUTTON, ON PURPOSE.
 *
 * Every other credential mail in this file ends in a link, because a link is the
 * only way to carry a 256-bit token. A six-digit code does not need one, and a
 * one-click sign-in link is the single most phishable thing a store sends: it
 * survives forwarding, it renders as a domain the recipient never reads, and it
 * trains customers to click their way into a session. The code is typed into the
 * tab that asked for it, so this mail is inert — a test asserts the rendered
 * HTML contains no anchor at all.
 */
const renderLoginCode: TemplateRenderer<"login-code"> = (payload, locale) => {
  const copy = pick(
    {
      es: {
        subject: `${payload.code} es tu código de acceso`,
        preheader: "Tu código de un solo uso para entrar en Akai.",
        greeting: `Hola ${payload.firstName},`,
        body: "Escribe este código en la pestaña donde lo has pedido:",
        label: "Código de acceso",
        expiry: `El código caduca en ${payload.expiresInMinutes} minutos y solo puede usarse una vez.`,
        ignore:
          "Si no has intentado entrar, ignora este mensaje y no compartas el código con nadie. Nunca te lo pediremos por teléfono ni por correo.",
      },
      en: {
        subject: `${payload.code} is your sign-in code`,
        preheader: "Your one-time code for Akai.",
        greeting: `Hi ${payload.firstName},`,
        body: "Enter this code in the tab where you asked for it:",
        label: "Sign-in code",
        expiry: `The code expires in ${payload.expiresInMinutes} minutes and can be used only once.`,
        ignore:
          "If you did not try to sign in, ignore this message and do not share the code with anyone. We will never ask you for it by phone or email.",
      },
    },
    locale,
  );

  return {
    subject: copy.subject,
    preheader: copy.preheader,
    blocks: [
      { kind: "heading", text: copy.greeting },
      { kind: "paragraph", text: copy.body },
      { kind: "keyValue", rows: [{ label: copy.label, value: payload.code, strong: true }] },
      { kind: "note", text: `${copy.expiry} ${copy.ignore}` },
    ],
  };
};

const renderOrderConfirmation: TemplateRenderer<"order-confirmation"> = (
  payload,
  locale,
) => {
  const copy = pick(
    {
      es: {
        subject: `Pedido confirmado ${payload.orderNumber}`,
        preheader: `Hemos recibido tu pedido ${payload.orderNumber}.`,
        greeting: `Gracias, ${payload.firstName}.`,
        body: `Hemos recibido tu pedido del ${formatDate(payload.placedAt, locale)}. Te avisaremos en cuanto salga de nuestro almacén.`,
        subtotal: "Subtotal",
        discount: "Descuento",
        shipping: "Envío",
        tax: "IVA incluido",
        total: "Total",
        button: "Ver pedido",
      },
      en: {
        subject: `Order confirmed ${payload.orderNumber}`,
        preheader: `We have received your order ${payload.orderNumber}.`,
        greeting: `Thank you, ${payload.firstName}.`,
        body: `We received your order placed on ${formatDate(payload.placedAt, locale)}. We will let you know as soon as it leaves our warehouse.`,
        subtotal: "Subtotal",
        discount: "Discount",
        shipping: "Shipping",
        tax: "VAT included",
        total: "Total",
        button: "View order",
      },
    },
    locale,
  );

  return {
    subject: copy.subject,
    preheader: copy.preheader,
    blocks: [
      { kind: "heading", text: copy.subject },
      { kind: "paragraph", text: copy.greeting },
      { kind: "paragraph", text: copy.body },
      { kind: "lineItems", items: payload.lines },
      {
        kind: "keyValue",
        rows: [
          { label: copy.subtotal, value: money(payload.subtotal, locale) },
          { label: copy.discount, value: money(payload.discountTotal, locale) },
          { label: copy.shipping, value: money(payload.shippingTotal, locale) },
          { label: copy.tax, value: money(payload.taxTotal, locale) },
          { label: copy.total, value: money(payload.grandTotal, locale), strong: true },
        ],
      },
      { kind: "button", label: copy.button, url: payload.orderUrl },
    ],
  };
};

const renderPaymentReceipt: TemplateRenderer<"payment-receipt"> = (payload, locale) => {
  const card =
    payload.cardLast4 === undefined
      ? undefined
      : `${payload.cardBrand ?? "····"} ···· ${payload.cardLast4}`;

  const copy = pick(
    {
      es: {
        subject: `Recibo de pago ${payload.orderNumber}`,
        preheader: `Pago confirmado — factura ${payload.invoiceNumber}.`,
        greeting: `Hola ${payload.firstName},`,
        body: "Hemos recibido tu pago correctamente.",
        invoice: "Factura",
        order: "Pedido",
        paidAt: "Fecha de pago",
        method: "Método de pago",
        amount: "Importe pagado",
        button: "Descargar factura",
      },
      en: {
        subject: `Payment receipt ${payload.orderNumber}`,
        preheader: `Payment confirmed — invoice ${payload.invoiceNumber}.`,
        greeting: `Hi ${payload.firstName},`,
        body: "We have received your payment successfully.",
        invoice: "Invoice",
        order: "Order",
        paidAt: "Payment date",
        method: "Payment method",
        amount: "Amount paid",
        button: "Download invoice",
      },
    },
    locale,
  );

  return {
    subject: copy.subject,
    preheader: copy.preheader,
    blocks: [
      { kind: "heading", text: copy.subject },
      { kind: "paragraph", text: copy.greeting },
      { kind: "paragraph", text: copy.body },
      {
        kind: "keyValue",
        rows: [
          { label: copy.invoice, value: payload.invoiceNumber },
          { label: copy.order, value: payload.orderNumber },
          { label: copy.paidAt, value: formatDate(payload.paidAt, locale) },
          ...(card === undefined ? [] : [{ label: copy.method, value: card }]),
          { label: copy.amount, value: money(payload.amountPaid, locale), strong: true },
        ],
      },
      { kind: "button", label: copy.button, url: payload.invoiceUrl },
    ],
  };
};

const renderPaymentFailed: TemplateRenderer<"payment-failed"> = (payload, locale) => {
  const copy = pick(
    {
      es: {
        subject: `No hemos podido procesar el pago de ${payload.orderNumber}`,
        preheader: "Tu pedido sigue reservado; puedes reintentar el pago.",
        greeting: `Hola ${payload.firstName},`,
        body: `No hemos podido procesar el pago de tu pedido ${payload.orderNumber}. Motivo: ${payload.reason}.`,
        reassure:
          "No se te ha cobrado nada. Tu pedido sigue guardado y puedes reintentar el pago desde el enlace.",
        button: "Reintentar el pago",
      },
      en: {
        subject: `We could not process payment for ${payload.orderNumber}`,
        preheader: "Your order is still reserved; you can retry payment.",
        greeting: `Hi ${payload.firstName},`,
        body: `We could not process the payment for your order ${payload.orderNumber}. Reason: ${payload.reason}.`,
        reassure:
          "You have not been charged. Your order is still saved and you can retry payment from the link below.",
        button: "Retry payment",
      },
    },
    locale,
  );

  return {
    subject: copy.subject,
    preheader: copy.preheader,
    blocks: [
      { kind: "heading", text: copy.subject },
      { kind: "paragraph", text: copy.greeting },
      { kind: "paragraph", text: copy.body },
      { kind: "paragraph", text: copy.reassure },
      { kind: "button", label: copy.button, url: payload.retryUrl },
    ],
  };
};

const renderShippingConfirmation: TemplateRenderer<"shipping-confirmation"> = (
  payload,
  locale,
) => {
  const tracked = payload.trackingNumber !== undefined;
  const copy = pick(
    {
      es: {
        subject: `Tu pedido ${payload.orderNumber} está en camino`,
        preheader: tracked
          ? `Enviado con ${payload.carrier} — seguimiento ${payload.trackingNumber}.`
          : `Enviado con ${payload.carrier}.`,
        greeting: `Hola ${payload.firstName},`,
        body: `Tu pedido salió de nuestro almacén el ${formatDate(payload.shippedAt, locale)}.`,
        carrier: "Transportista",
        tracking: "Nº de seguimiento",
        track: "Seguir el envío",
        viewOrder: "Ver pedido",
        untracked:
          "Este envío no lleva seguimiento. Si no llega en los próximos días hábiles, responde a este correo y lo revisamos.",
        pickupPoint: "Punto de recogida",
        pickupAddress: "Dirección",
        pickupNote:
          "Te avisaremos por correo en cuanto el paquete esté listo para recoger en este punto.",
      },
      en: {
        subject: `Your order ${payload.orderNumber} is on its way`,
        preheader: tracked
          ? `Shipped with ${payload.carrier} — tracking ${payload.trackingNumber}.`
          : `Shipped with ${payload.carrier}.`,
        greeting: `Hi ${payload.firstName},`,
        body: `Your order left our warehouse on ${formatDate(payload.shippedAt, locale)}.`,
        carrier: "Carrier",
        tracking: "Tracking number",
        track: "Track shipment",
        viewOrder: "View order",
        untracked:
          "This parcel ships without tracking. If it has not arrived within a few business days, reply to this email and we will look into it.",
        pickupPoint: "Pickup point",
        pickupAddress: "Address",
        pickupNote: "We will email you as soon as the parcel is ready to collect at this point.",
      },
    },
    locale,
  );

  const rows: { label: string; value: string }[] = [
    { label: copy.carrier, value: payload.carrier },
  ];
  if (payload.trackingNumber !== undefined) {
    rows.push({ label: copy.tracking, value: payload.trackingNumber });
  }
  if (payload.servicePoint !== undefined) {
    rows.push({ label: copy.pickupPoint, value: payload.servicePoint.name });
    rows.push({ label: copy.pickupAddress, value: payload.servicePoint.address });
  }

  // There is ALWAYS a button: with a tracking URL it goes to the carrier, and
  // without one it goes to the order. A shipping mail whose only call to action
  // silently disappears for untracked parcels is worse than one extra link.
  const button: Block =
    payload.trackingUrl === undefined
      ? { kind: "button", label: copy.viewOrder, url: payload.orderUrl }
      : { kind: "button", label: copy.track, url: payload.trackingUrl };

  const blocks: Block[] = [
    { kind: "heading", text: copy.subject },
    { kind: "paragraph", text: copy.greeting },
    { kind: "paragraph", text: copy.body },
    { kind: "keyValue", rows },
    { kind: "lineItems", items: payload.lines },
    button,
  ];
  if (payload.servicePoint !== undefined) {
    blocks.push({ kind: "note", text: copy.pickupNote });
  }
  if (!tracked) {
    blocks.push({ kind: "note", text: copy.untracked });
  }

  return { subject: copy.subject, preheader: copy.preheader, blocks };
};

type OpeningDay = NonNullable<EmailPayloadFor<"ready-for-pickup">["openingHours"]>[number];

const WEEKDAY_LABELS: Bilingual<Readonly<Record<OpeningDay["day"], string>>> = {
  es: {
    monday: "Lunes",
    tuesday: "Martes",
    wednesday: "Miércoles",
    thursday: "Jueves",
    friday: "Viernes",
    saturday: "Sábado",
    sunday: "Domingo",
  },
  en: {
    monday: "Monday",
    tuesday: "Tuesday",
    wednesday: "Wednesday",
    thursday: "Thursday",
    friday: "Friday",
    saturday: "Saturday",
    sunday: "Sunday",
  },
};

/** "08:00–14:00, 17:00–20:30", or the locale's "closed". */
function shiftsLabel(day: OpeningDay, closed: string): string {
  if (day.shifts.length === 0) {
    return closed;
  }
  return day.shifts.map((shift) => `${shift.start}–${shift.end}`).join(", ");
}

const renderReadyForPickup: TemplateRenderer<"ready-for-pickup"> = (payload, locale) => {
  const point = payload.servicePoint;
  const copy = pick(
    {
      es: {
        subject: `Tu pedido ${payload.orderNumber} ya está en el punto de recogida`,
        preheader:
          point === undefined
            ? "Tu paquete te espera para que lo recojas."
            : `Te espera en ${point.name}.`,
        greeting: `Hola ${payload.firstName},`,
        body:
          point === undefined
            ? `Tu paquete ha llegado y ${payload.carrier} lo tiene listo para recoger. En la página de seguimiento verás dónde.`
            : "Tu paquete ha llegado al punto de recogida y ya puedes pasar a por él.",
        bring:
          "Lleva tu documento de identidad y el número de pedido o de seguimiento. Los puntos solo guardan los paquetes unos días; si no se recoge a tiempo, vuelve al remitente.",
        pickupPoint: "Punto de recogida",
        pickupAddress: "Dirección",
        carrier: "Transportista",
        tracking: "Nº de seguimiento",
        hours: "Horario de esta semana",
        closed: "Cerrado",
        track: "Ver seguimiento",
        viewOrder: "Ver pedido",
      },
      en: {
        subject: `Your order ${payload.orderNumber} is ready for pickup`,
        preheader:
          point === undefined
            ? "Your parcel is waiting for you to collect it."
            : `It is waiting for you at ${point.name}.`,
        greeting: `Hi ${payload.firstName},`,
        body:
          point === undefined
            ? `Your parcel has arrived and ${payload.carrier} is holding it for collection. The tracking page shows where.`
            : "Your parcel has arrived at the pickup point and is ready to collect.",
        bring:
          "Bring your ID and the order or tracking number. Pickup points only hold parcels for a few days; one not collected in time goes back to the sender.",
        pickupPoint: "Pickup point",
        pickupAddress: "Address",
        carrier: "Carrier",
        tracking: "Tracking number",
        hours: "Opening hours this week",
        closed: "Closed",
        track: "View tracking",
        viewOrder: "View order",
      },
    },
    locale,
  );

  const rows: { label: string; value: string }[] = [];
  if (point !== undefined) {
    rows.push({ label: copy.pickupPoint, value: point.name });
    rows.push({ label: copy.pickupAddress, value: point.address });
  }
  rows.push({ label: copy.carrier, value: payload.carrier });
  if (payload.trackingNumber !== undefined) {
    rows.push({ label: copy.tracking, value: payload.trackingNumber });
  }

  const blocks: Block[] = [
    { kind: "heading", text: copy.subject },
    { kind: "paragraph", text: copy.greeting },
    { kind: "paragraph", text: copy.body },
    { kind: "keyValue", rows },
  ];

  if (payload.openingHours !== undefined) {
    const labels = WEEKDAY_LABELS[locale];
    blocks.push({ kind: "paragraph", text: copy.hours });
    blocks.push({
      kind: "keyValue",
      rows: payload.openingHours.map((day) => ({
        label: labels[day.day],
        value: shiftsLabel(day, copy.closed),
      })),
    });
  }

  blocks.push({ kind: "paragraph", text: copy.bring });
  // Tracking first: without a snapshot it is the only place that says WHERE.
  blocks.push(
    payload.trackingUrl === undefined
      ? { kind: "button", label: copy.viewOrder, url: payload.orderUrl }
      : { kind: "button", label: copy.track, url: payload.trackingUrl },
  );

  return { subject: copy.subject, preheader: copy.preheader, blocks };
};

const renderDeliveryConfirmation: TemplateRenderer<"delivery-confirmation"> = (
  payload,
  locale,
) => {
  const copy = pick(
    {
      es: {
        subject: `Pedido ${payload.orderNumber} entregado`,
        preheader: "Tu pedido consta como entregado.",
        greeting: `Hola ${payload.firstName},`,
        body: `Tu pedido consta como entregado el ${formatDate(payload.deliveredAt, locale)}.`,
        help: "Si hay cualquier problema con el envío, responde a este correo y lo resolvemos.",
        button: "Ver pedido",
      },
      en: {
        subject: `Order ${payload.orderNumber} delivered`,
        preheader: "Your order is marked as delivered.",
        greeting: `Hi ${payload.firstName},`,
        body: `Your order was marked delivered on ${formatDate(payload.deliveredAt, locale)}.`,
        help: "If anything is wrong with the shipment, reply to this email and we will sort it out.",
        button: "View order",
      },
    },
    locale,
  );

  return {
    subject: copy.subject,
    preheader: copy.preheader,
    blocks: [
      { kind: "heading", text: copy.subject },
      { kind: "paragraph", text: copy.greeting },
      { kind: "paragraph", text: copy.body },
      { kind: "paragraph", text: copy.help },
      { kind: "button", label: copy.button, url: payload.orderUrl },
    ],
  };
};

const renderRefundConfirmation: TemplateRenderer<"refund-confirmation"> = (
  payload,
  locale,
) => {
  const copy = pick(
    {
      es: {
        subject: payload.isPartial
          ? `Reembolso parcial del pedido ${payload.orderNumber}`
          : `Reembolso del pedido ${payload.orderNumber}`,
        preheader: "Hemos emitido tu reembolso.",
        greeting: `Hola ${payload.firstName},`,
        body: `Hemos emitido el reembolso el ${formatDate(payload.refundedAt, locale)}. Motivo: ${payload.reason}.`,
        amount: payload.isPartial ? "Importe reembolsado (parcial)" : "Importe reembolsado",
        timing:
          "Según tu banco, el abono puede tardar entre 5 y 10 días hábiles en aparecer en tu cuenta.",
      },
      en: {
        subject: payload.isPartial
          ? `Partial refund for order ${payload.orderNumber}`
          : `Refund for order ${payload.orderNumber}`,
        preheader: "We have issued your refund.",
        greeting: `Hi ${payload.firstName},`,
        body: `We issued your refund on ${formatDate(payload.refundedAt, locale)}. Reason: ${payload.reason}.`,
        amount: payload.isPartial ? "Refunded amount (partial)" : "Refunded amount",
        timing:
          "Depending on your bank, the credit can take 5–10 business days to appear on your statement.",
      },
    },
    locale,
  );

  return {
    subject: copy.subject,
    preheader: copy.preheader,
    blocks: [
      { kind: "heading", text: copy.subject },
      { kind: "paragraph", text: copy.greeting },
      { kind: "paragraph", text: copy.body },
      {
        kind: "keyValue",
        rows: [
          {
            label: copy.amount,
            value: money(payload.refundAmount, locale),
            strong: true,
          },
        ],
      },
      { kind: "note", text: copy.timing },
    ],
  };
};

const renderOrderCancelled: TemplateRenderer<"order-cancelled"> = (payload, locale) => {
  const copy = pick(
    {
      es: {
        subject: `Pedido ${payload.orderNumber} cancelado`,
        preheader: "Tu pedido ha sido cancelado.",
        greeting: `Hola ${payload.firstName},`,
        body: `Tu pedido ha sido cancelado el ${formatDate(payload.cancelledAt, locale)}. Motivo: ${payload.reason}.`,
        charge:
          "Si ya se había autorizado un cargo, se libera automáticamente. No se te cobrará nada.",
      },
      en: {
        subject: `Order ${payload.orderNumber} cancelled`,
        preheader: "Your order has been cancelled.",
        greeting: `Hi ${payload.firstName},`,
        body: `Your order was cancelled on ${formatDate(payload.cancelledAt, locale)}. Reason: ${payload.reason}.`,
        charge:
          "If a charge had already been authorised, it is released automatically. You will not be charged.",
      },
    },
    locale,
  );

  return {
    subject: copy.subject,
    preheader: copy.preheader,
    blocks: [
      { kind: "heading", text: copy.subject },
      { kind: "paragraph", text: copy.greeting },
      { kind: "paragraph", text: copy.body },
      { kind: "note", text: copy.charge },
    ],
  };
};

const renderAdminNewOrder: TemplateRenderer<"admin-new-order"> = (payload, locale) => {
  const copy = pick(
    {
      es: {
        subject: `Nuevo pedido ${payload.orderNumber} — ${money(payload.grandTotal, locale)}`,
        preheader: `Nuevo pedido pagado por ${money(payload.grandTotal, locale)}.`,
        order: "Pedido",
        customer: "Cliente",
        items: "Artículos",
        total: "Total",
        placedAt: "Fecha",
        button: "Abrir en el panel",
      },
      en: {
        subject: `New order ${payload.orderNumber} — ${money(payload.grandTotal, locale)}`,
        preheader: `New paid order for ${money(payload.grandTotal, locale)}.`,
        order: "Order",
        customer: "Customer",
        items: "Items",
        total: "Total",
        placedAt: "Placed",
        button: "Open in dashboard",
      },
    },
    locale,
  );

  return {
    subject: copy.subject,
    preheader: copy.preheader,
    blocks: [
      { kind: "heading", text: copy.subject },
      {
        kind: "keyValue",
        rows: [
          { label: copy.order, value: payload.orderNumber },
          { label: copy.customer, value: payload.customerEmail },
          { label: copy.items, value: String(payload.itemCount) },
          { label: copy.placedAt, value: formatDate(payload.placedAt, locale) },
          { label: copy.total, value: money(payload.grandTotal, locale), strong: true },
        ],
      },
      { kind: "button", label: copy.button, url: payload.adminUrl },
    ],
  };
};

const renderContactAutoreply: TemplateRenderer<"contact-autoreply"> = (
  payload,
  locale,
) => {
  const copy = pick(
    {
      es: {
        subject: `Hemos recibido tu mensaje (${payload.referenceId})`,
        preheader: "Te responderemos en un plazo de 1–2 días hábiles.",
        greeting: `Hola ${payload.name},`,
        body: `Hemos recibido tu mensaje sobre "${payload.subject}". Te responderemos en un plazo de 1 a 2 días hábiles.`,
        reference: "Referencia",
        noreply: "Este es un mensaje automático; no hace falta que respondas.",
      },
      en: {
        subject: `We received your message (${payload.referenceId})`,
        preheader: "We will reply within 1–2 business days.",
        greeting: `Hi ${payload.name},`,
        body: `We received your message about "${payload.subject}". We will reply within 1–2 business days.`,
        reference: "Reference",
        noreply: "This is an automated message; there is no need to reply.",
      },
    },
    locale,
  );

  return {
    subject: copy.subject,
    preheader: copy.preheader,
    blocks: [
      { kind: "heading", text: copy.subject },
      { kind: "paragraph", text: copy.greeting },
      { kind: "paragraph", text: copy.body },
      {
        kind: "keyValue",
        rows: [{ label: copy.reference, value: payload.referenceId }],
      },
      { kind: "note", text: copy.noreply },
    ],
  };
};

/**
 * The staff copy of a contact submission.
 *
 * Rendered in the SUBMITTER's locale rather than a fixed staff language, so the
 * subject line already tells whoever picks it up which language to reply in.
 *
 * The message body goes through the same `paragraph` block as every other piece
 * of copy, which is HTML-escaped by `wrapHtml` — a contact form is untrusted
 * input arriving from an anonymous stranger, and rendering it raw into a mail an
 * employee opens is a stored-XSS delivery mechanism with a human on the other
 * end.
 */
const renderContactReceived: TemplateRenderer<"contact-received"> = (
  payload,
  locale,
) => {
  const copy = pick(
    {
      es: {
        subject: `Nuevo mensaje de contacto (${payload.referenceId})`,
        preheader: `De ${payload.name} <${payload.replyTo}>`,
        reference: "Referencia",
        from: "De",
        email: "Email",
        topic: "Asunto",
        received: "Recibido",
        note: "Responde directamente a la dirección indicada arriba.",
      },
      en: {
        subject: `New contact message (${payload.referenceId})`,
        preheader: `From ${payload.name} <${payload.replyTo}>`,
        reference: "Reference",
        from: "From",
        email: "Email",
        topic: "Subject",
        received: "Received",
        note: "Reply directly to the address above.",
      },
    },
    locale,
  );

  return {
    subject: copy.subject,
    preheader: copy.preheader,
    blocks: [
      { kind: "heading", text: copy.subject },
      {
        kind: "keyValue",
        rows: [
          { label: copy.reference, value: payload.referenceId },
          { label: copy.from, value: payload.name },
          { label: copy.email, value: payload.replyTo },
          { label: copy.topic, value: payload.subject },
          { label: copy.received, value: formatDate(payload.submittedAt, locale) },
        ],
      },
      { kind: "paragraph", text: payload.message },
      { kind: "note", text: copy.note },
    ],
  };
};

const renderAffiliateApplicationAutoreply: TemplateRenderer<
  "affiliate-application-autoreply"
> = (payload, locale) => {
  const copy = pick(
    {
      es: {
        subject: `Hemos recibido tu solicitud de afiliado (${payload.referenceId})`,
        preheader: "Nuestro equipo revisará tu solicitud en unos días.",
        greeting: `Hola ${payload.name},`,
        body: "Hemos recibido tu solicitud para el programa de afiliados. Nuestro equipo la revisará y se pondrá en contacto contigo en unos días.",
        reference: "Referencia",
        noreply: "Este es un mensaje automático; no hace falta que respondas.",
      },
      en: {
        subject: `We received your affiliate application (${payload.referenceId})`,
        preheader: "Our team will review your application within a few days.",
        greeting: `Hi ${payload.name},`,
        body: "We received your affiliate program application. Our team will review it and get back to you within a few days.",
        reference: "Reference",
        noreply: "This is an automated message; there is no need to reply.",
      },
    },
    locale,
  );

  return {
    subject: copy.subject,
    preheader: copy.preheader,
    blocks: [
      { kind: "heading", text: copy.subject },
      { kind: "paragraph", text: copy.greeting },
      { kind: "paragraph", text: copy.body },
      {
        kind: "keyValue",
        rows: [{ label: copy.reference, value: payload.referenceId }],
      },
      { kind: "note", text: copy.noreply },
    ],
  };
};

/**
 * The staff copy of an affiliate application.
 *
 * Rendered in the APPLICANT's locale, same reasoning `renderContactReceived`
 * gives for its own choice: the subject line tells whoever picks it up which
 * language the applicant used. Every field here is form data the applicant
 * typed, not free text — unlike `renderContactReceived`'s `message` block,
 * there is no `paragraph` needing HTML-escaping, because there is no
 * free-text field on this form at all.
 */
const renderAffiliateApplicationReceived: TemplateRenderer<
  "affiliate-application-received"
> = (payload, locale) => {
  const copy = pick(
    {
      es: {
        subject: `Nueva solicitud de afiliado (${payload.referenceId})`,
        preheader: `De ${payload.name} <${payload.replyTo}>`,
        reference: "Referencia",
        from: "Nombre",
        email: "Email",
        country: "País",
        social: "Red social",
        received: "Recibido",
        note: "Responde directamente a la dirección indicada arriba.",
      },
      en: {
        subject: `New affiliate application (${payload.referenceId})`,
        preheader: `From ${payload.name} <${payload.replyTo}>`,
        reference: "Reference",
        from: "Name",
        email: "Email",
        country: "Country",
        social: "Social handle",
        received: "Received",
        note: "Reply directly to the address above.",
      },
    },
    locale,
  );

  return {
    subject: copy.subject,
    preheader: copy.preheader,
    blocks: [
      { kind: "heading", text: copy.subject },
      {
        kind: "keyValue",
        rows: [
          { label: copy.reference, value: payload.referenceId },
          { label: copy.from, value: payload.name },
          { label: copy.email, value: payload.replyTo },
          { label: copy.country, value: payload.country },
          { label: copy.social, value: payload.socialHandle },
          { label: copy.received, value: formatDate(payload.submittedAt, locale) },
        ],
      },
      { kind: "note", text: copy.note },
    ],
  };
};

/**
 * The renderer table. A MAPPED type over `EmailTemplateKey`, so it is total by
 * construction: a new template key is a compile error here, never a runtime
 * "no renderer for X" that surfaces as an order confirmation nobody received.
 */
const RENDERERS: { [K in EmailTemplateKey]: TemplateRenderer<K> } = {
  "verify-email": renderVerifyEmail,
  "reset-password": renderResetPassword,
  "login-code": renderLoginCode,
  "order-confirmation": renderOrderConfirmation,
  "payment-receipt": renderPaymentReceipt,
  "payment-failed": renderPaymentFailed,
  "shipping-confirmation": renderShippingConfirmation,
  "ready-for-pickup": renderReadyForPickup,
  "delivery-confirmation": renderDeliveryConfirmation,
  "refund-confirmation": renderRefundConfirmation,
  "order-cancelled": renderOrderCancelled,
  "admin-new-order": renderAdminNewOrder,
  "contact-autoreply": renderContactAutoreply,
  "contact-received": renderContactReceived,
  "affiliate-application-autoreply": renderAffiliateApplicationAutoreply,
  "affiliate-application-received": renderAffiliateApplicationReceived,
};

/**
 * Render one template in one locale. Pure — no I/O, no clock, no config.
 *
 * Indexing the mapped type with the generic `K` yields `TemplateRenderer<K>`
 * directly, so the payload flows through with no cast at the dispatch point.
 */
export function renderEmail<K extends EmailTemplateKey>(
  templateKey: K,
  locale: Locale,
  payload: EmailPayloadFor<K>,
): RenderedEmail {
  const renderer: TemplateRenderer<K> = RENDERERS[templateKey];
  const content = renderer(payload, locale);

  return {
    subject: content.subject,
    html: wrapHtml(content, locale),
    text: wrapText(content, locale),
  };
}
