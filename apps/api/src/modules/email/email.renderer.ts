import { STORE_LOCALE, STORE_TIME_ZONE, type EmailTemplateKey, type Money } from "@akai/contracts";
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
 * lets every template be asserted in a unit test without a database or a
 * network.
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

/** A date as a Colombian reader expects it: es-CO, in Colombian time. */
function formatDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(STORE_LOCALE, {
    dateStyle: "long",
    timeZone: STORE_TIME_ZONE,
  }).format(parsed);
}

function money(value: Money): string {
  return formatMoneyValue(value);
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

function blockToHtml(block: Block): string {
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
            `${escapeHtml(money(item.lineTotal))}</td></tr>`,
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

function blockToText(block: Block): string {
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
            `- ${lineLabel(item)} x${item.quantity}  ${money(item.lineTotal)}`,
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
function wrapHtml(content: TemplateContent): string {
  const body = content.blocks.map((block) => blockToHtml(block)).join("\n");
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
    `<!doctype html><html lang="${STORE_LOCALE}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width"><title>` +
    `${escapeHtml(content.subject)}</title></head>` +
    `<body style="margin:0;padding:40px 24px;font-family:${FONT_SANS};color:${COLOR_INK};">` +
    `${preheader}` +
    `<div style="max-width:560px;margin:0 auto;">${masthead}${body}${signoff}</div>` +
    `</body></html>`
  );
}

function wrapText(content: TemplateContent): string {
  const body = content.blocks
    .map((block) => blockToText(block))
    .filter((part) => part.length > 0)
    .join("\n\n");
  return `${BRAND}\n\n${body}\n\n---\n${BRAND}\n`;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const renderVerifyEmail: TemplateRenderer<"verify-email"> = (payload) => {
  const copy = {
    subject: "Confirma tu correo electrónico",
    preheader: "Un último paso para activar tu cuenta.",
    greeting: `Hola ${payload.firstName},`,
    body: "Confirma tu dirección de correo para activar tu cuenta de Akai.",
    button: "Confirmar correo",
    expiry: `Este enlace caduca en ${payload.expiresInHours} horas.`,
    ignore: "Si no has creado una cuenta, puedes ignorar este mensaje.",
  };

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

const renderResetPassword: TemplateRenderer<"reset-password"> = (payload) => {
  const copy = {
    subject: "Restablecer tu contraseña",
    preheader: "Enlace para crear una contraseña nueva.",
    greeting: `Hola ${payload.firstName},`,
    body: "Hemos recibido una solicitud para restablecer tu contraseña.",
    button: "Crear contraseña nueva",
    expiry: `El enlace caduca en ${payload.expiresInMinutes} minutos y solo puede usarse una vez.`,
    ignore:
      "Si no has solicitado el cambio, ignora este mensaje: tu contraseña actual sigue siendo válida.",
  };

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
const renderLoginCode: TemplateRenderer<"login-code"> = (payload) => {
  const copy = {
    subject: `${payload.code} es tu código de acceso`,
    preheader: "Tu código de un solo uso para entrar en Akai.",
    greeting: `Hola ${payload.firstName},`,
    body: "Escribe este código en la pestaña donde lo has pedido:",
    label: "Código de acceso",
    expiry: `El código caduca en ${payload.expiresInMinutes} minutos y solo puede usarse una vez.`,
    ignore:
      "Si no has intentado entrar, ignora este mensaje y no compartas el código con nadie. Nunca te lo pediremos por teléfono ni por correo.",
  };

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

const renderOrderConfirmation: TemplateRenderer<"order-confirmation"> = (payload) => {
  const copy = {
    subject: `Pedido confirmado ${payload.orderNumber}`,
    preheader: `Hemos recibido tu pedido ${payload.orderNumber}.`,
    greeting: `Gracias, ${payload.firstName}.`,
    body: `Hemos recibido tu pedido del ${formatDate(payload.placedAt)}. Te avisaremos en cuanto salga de nuestro almacén.`,
    subtotal: "Subtotal",
    discount: "Descuento",
    shipping: "Envío",
    tax: "IVA incluido",
    total: "Total",
    button: "Ver pedido",
  };

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
          { label: copy.subtotal, value: money(payload.subtotal) },
          { label: copy.discount, value: money(payload.discountTotal) },
          { label: copy.shipping, value: money(payload.shippingTotal) },
          { label: copy.tax, value: money(payload.taxTotal) },
          { label: copy.total, value: money(payload.grandTotal), strong: true },
        ],
      },
      { kind: "button", label: copy.button, url: payload.orderUrl },
    ],
  };
};

const renderPaymentReceipt: TemplateRenderer<"payment-receipt"> = (payload) => {
  const card =
    payload.cardLast4 === undefined
      ? undefined
      : `${payload.cardBrand ?? "····"} ···· ${payload.cardLast4}`;

  const copy = {
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
  };

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
          { label: copy.paidAt, value: formatDate(payload.paidAt) },
          ...(card === undefined ? [] : [{ label: copy.method, value: card }]),
          { label: copy.amount, value: money(payload.amountPaid), strong: true },
        ],
      },
      { kind: "button", label: copy.button, url: payload.invoiceUrl },
    ],
  };
};

const renderPaymentFailed: TemplateRenderer<"payment-failed"> = (payload) => {
  const copy = {
    subject: `No hemos podido procesar el pago de ${payload.orderNumber}`,
    preheader: "Tu pedido sigue reservado; puedes reintentar el pago.",
    greeting: `Hola ${payload.firstName},`,
    body: `No hemos podido procesar el pago de tu pedido ${payload.orderNumber}. Motivo: ${payload.reason}.`,
    reassure:
      "No se te ha cobrado nada. Tu pedido sigue guardado y puedes reintentar el pago desde el enlace.",
    button: "Reintentar el pago",
  };

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

const renderShippingConfirmation: TemplateRenderer<"shipping-confirmation"> = (payload) => {
  const tracked = payload.trackingNumber !== undefined;
  const copy = {
    subject: `Tu pedido ${payload.orderNumber} está en camino`,
    preheader: tracked
      ? `Enviado con ${payload.carrier} — seguimiento ${payload.trackingNumber}.`
      : `Enviado con ${payload.carrier}.`,
    greeting: `Hola ${payload.firstName},`,
    body: `Tu pedido salió de nuestro almacén el ${formatDate(payload.shippedAt)}.`,
    carrier: "Transportista",
    tracking: "Nº de seguimiento",
    track: "Seguir el envío",
    viewOrder: "Ver pedido",
    untracked:
      "Este envío no lleva seguimiento. Si no llega en los próximos días hábiles, responde a este correo y lo revisamos.",
  };

  const rows: { label: string; value: string }[] = [
    { label: copy.carrier, value: payload.carrier },
  ];
  if (payload.trackingNumber !== undefined) {
    rows.push({ label: copy.tracking, value: payload.trackingNumber });
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
  if (!tracked) {
    blocks.push({ kind: "note", text: copy.untracked });
  }

  return { subject: copy.subject, preheader: copy.preheader, blocks };
};

const renderDeliveryConfirmation: TemplateRenderer<"delivery-confirmation"> = (payload) => {
  const copy = {
    subject: `Pedido ${payload.orderNumber} entregado`,
    preheader: "Tu pedido consta como entregado.",
    greeting: `Hola ${payload.firstName},`,
    body: `Tu pedido consta como entregado el ${formatDate(payload.deliveredAt)}.`,
    help: "Si hay cualquier problema con el envío, responde a este correo y lo resolvemos.",
    button: "Ver pedido",
  };

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

const renderRefundConfirmation: TemplateRenderer<"refund-confirmation"> = (payload) => {
  const copy = {
    subject: payload.isPartial
      ? `Reembolso parcial del pedido ${payload.orderNumber}`
      : `Reembolso del pedido ${payload.orderNumber}`,
    preheader: "Hemos emitido tu reembolso.",
    greeting: `Hola ${payload.firstName},`,
    body: `Hemos emitido el reembolso el ${formatDate(payload.refundedAt)}. Motivo: ${payload.reason}.`,
    amount: payload.isPartial ? "Importe reembolsado (parcial)" : "Importe reembolsado",
    timing:
      "Según tu banco, el abono puede tardar entre 5 y 10 días hábiles en aparecer en tu cuenta.",
  };

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
            value: money(payload.refundAmount),
            strong: true,
          },
        ],
      },
      { kind: "note", text: copy.timing },
    ],
  };
};

const renderOrderCancelled: TemplateRenderer<"order-cancelled"> = (payload) => {
  const copy = {
    subject: `Pedido ${payload.orderNumber} cancelado`,
    preheader: "Tu pedido ha sido cancelado.",
    greeting: `Hola ${payload.firstName},`,
    body: `Tu pedido ha sido cancelado el ${formatDate(payload.cancelledAt)}. Motivo: ${payload.reason}.`,
    charge:
      "Si ya se había autorizado un cargo, se libera automáticamente. No se te cobrará nada.",
  };

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

const renderAdminNewOrder: TemplateRenderer<"admin-new-order"> = (payload) => {
  const copy = {
    subject: `Nuevo pedido ${payload.orderNumber} — ${money(payload.grandTotal)}`,
    preheader: `Nuevo pedido pagado por ${money(payload.grandTotal)}.`,
    order: "Pedido",
    customer: "Cliente",
    items: "Artículos",
    total: "Total",
    placedAt: "Fecha",
    button: "Abrir en el panel",
  };

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
          { label: copy.placedAt, value: formatDate(payload.placedAt) },
          { label: copy.total, value: money(payload.grandTotal), strong: true },
        ],
      },
      { kind: "button", label: copy.button, url: payload.adminUrl },
    ],
  };
};

const renderContactAutoreply: TemplateRenderer<"contact-autoreply"> = (payload) => {
  const copy = {
    subject: `Hemos recibido tu mensaje (${payload.referenceId})`,
    preheader: "Te responderemos en un plazo de 1–2 días hábiles.",
    greeting: `Hola ${payload.name},`,
    body: `Hemos recibido tu mensaje sobre "${payload.subject}". Te responderemos en un plazo de 1 a 2 días hábiles.`,
    reference: "Referencia",
    noreply: "Este es un mensaje automático; no hace falta que respondas.",
  };

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
 * The message body goes through the same `paragraph` block as every other piece
 * of copy, which is HTML-escaped by `wrapHtml` — a contact form is untrusted
 * input arriving from an anonymous stranger, and rendering it raw into a mail an
 * employee opens is a stored-XSS delivery mechanism with a human on the other
 * end.
 */
const renderContactReceived: TemplateRenderer<"contact-received"> = (payload) => {
  const copy = {
    subject: `Nuevo mensaje de contacto (${payload.referenceId})`,
    preheader: `De ${payload.name} <${payload.replyTo}>`,
    reference: "Referencia",
    from: "De",
    email: "Email",
    topic: "Asunto",
    received: "Recibido",
    note: "Responde directamente a la dirección indicada arriba.",
  };

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
          { label: copy.received, value: formatDate(payload.submittedAt) },
        ],
      },
      { kind: "paragraph", text: payload.message },
      { kind: "note", text: copy.note },
    ],
  };
};

const renderAffiliateApplicationAutoreply: TemplateRenderer<
  "affiliate-application-autoreply"
> = (payload) => {
  const copy = {
    subject: `Hemos recibido tu solicitud de afiliado (${payload.referenceId})`,
    preheader: "Nuestro equipo revisará tu solicitud en unos días.",
    greeting: `Hola ${payload.name},`,
    body: "Hemos recibido tu solicitud para el programa de afiliados. Nuestro equipo la revisará y se pondrá en contacto contigo en unos días.",
    reference: "Referencia",
    noreply: "Este es un mensaje automático; no hace falta que respondas.",
  };

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
 * Every field here is form data the applicant typed, not free text — unlike `renderContactReceived`'s `message` block,
 * there is no `paragraph` needing HTML-escaping, because there is no
 * free-text field on this form at all.
 */
const renderAffiliateApplicationReceived: TemplateRenderer<
  "affiliate-application-received"
> = (payload) => {
  const copy = {
    subject: `Nueva solicitud de afiliado (${payload.referenceId})`,
    preheader: `De ${payload.name} <${payload.replyTo}>`,
    reference: "Referencia",
    from: "Nombre",
    email: "Email",
    country: "País",
    social: "Red social",
    received: "Recibido",
    note: "Responde directamente a la dirección indicada arriba.",
  };

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
          { label: copy.received, value: formatDate(payload.submittedAt) },
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
 * Render one template, in Spanish. Pure — no I/O, no clock, no config.
 *
 * Indexing the mapped type with the generic `K` yields `TemplateRenderer<K>`
 * directly, so the payload flows through with no cast at the dispatch point.
 */
export function renderEmail<K extends EmailTemplateKey>(
  templateKey: K,
  payload: EmailPayloadFor<K>,
): RenderedEmail {
  const renderer: TemplateRenderer<K> = RENDERERS[templateKey];
  const content = renderer(payload);

  return {
    subject: content.subject,
    html: wrapHtml(content),
    text: wrapText(content),
  };
}
