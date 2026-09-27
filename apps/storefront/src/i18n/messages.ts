import type { CartProblem, ErrorCode, Locale } from "@akai/contracts";

/**
 * Every user-visible string. `es` is the source of truth for the key set;
 * `en` is typed against it, so a missing translation is a compile error.
 */
/**
 * Server messages (`ApiError.message`, `CartProblem.message`) are English for
 * logs and are NEVER shown to shoppers. UI branches on the closed code enums
 * instead; these maps are total, so a new code is a compile error.
 */
type ErrorMessages = Readonly<Record<ErrorCode | "NETWORK", string>>;
type ProblemMessages = Readonly<Record<CartProblem["code"], string>>;

const esErrors: ErrorMessages = {
  VALIDATION_FAILED: "Revisa los datos introducidos.",
  UNAUTHENTICATED: "Tu sesión ha caducado. Vuelve a entrar.",
  FORBIDDEN: "No tienes permiso para hacer esto.",
  NOT_FOUND: "No lo hemos encontrado.",
  CONFLICT: "Algo ha cambiado mientras tanto. Recarga la página.",
  IDEMPOTENCY_KEY_REUSED: "Esta operación ya se envió. Recarga la página.",
  RATE_LIMITED: "Demasiados intentos. Espera un momento.",
  PAYMENT_FAILED: "No se pudo iniciar el pago.",
  OUT_OF_STOCK: "Alguna prenda se ha agotado.",
  PRICE_CHANGED: "Algún precio ha cambiado. Revisa tu carrito.",
  ILLEGAL_STATE_TRANSITION: "Esta operación ya no es posible.",
  INTERNAL_ERROR: "Ha ocurrido un error. Inténtalo de nuevo.",
  NETWORK: "No hay conexión con la tienda. Inténtalo de nuevo.",
};

const esProblems: ProblemMessages = {
  OUT_OF_STOCK: "Agotado.",
  INSUFFICIENT_STOCK: "No quedan suficientes unidades.",
  PRODUCT_UNAVAILABLE: "Ya no está disponible.",
  PRICE_CHANGED: "El precio ha cambiado.",
  QUANTITY_EXCEEDS_MAX: "Has superado la cantidad máxima.",
  COUNTRY_RESTRICTED: "No se puede enviar a tu país.",
};

const es = {
  errors: esErrors,
  cartProblems: esProblems,
  meta: {
    description: "Akai — streetwear de inspiración japonesa. Ediciones limitadas, cortes amplios.",
  },
  nav: { shop: "Tienda", cart: "Carrito", account: "Mi cuenta", signIn: "Entrar", language: "English" },
  home: {
    kicker: "Streetwear · Tokio",
    title: "Vestir en rojo.",
    lead: "Ropa de corte amplio y ediciones limitadas, diseñada entre la calle y el taller.",
    cta: "Ver la colección",
    newArrivals: "Novedades",
    viewAll: "Ver todo",
  },
  shop: { title: "Tienda", all: "Todo", empty: "No hay productos todavía.", loadMore: "Ver más" },
  product: {
    addToCart: "Añadir al carrito",
    adding: "Añadiendo…",
    added: "Añadido al carrito",
    soldOut: "Agotado",
    selectOption: "Elige una opción",
    description: "Descripción",
    viewCart: "Ver carrito",
  },
  cart: {
    title: "Carrito",
    empty: "Tu carrito está vacío.",
    continue: "Seguir comprando",
    subtotal: "Subtotal",
    discount: "Descuento",
    total: "Total",
    remove: "Quitar",
    checkout: "Finalizar compra",
    loading: "Cargando carrito…",
    error: "No se pudo cargar el carrito.",
  },
  checkout: {
    title: "Finalizar compra",
    contact: "Contacto",
    email: "Email",
    shipping: "Envío",
    firstName: "Nombre",
    lastName: "Apellidos",
    line1: "Calle",
    houseNumber: "Número",
    line2: "Piso, puerta (opcional)",
    city: "Ciudad",
    postalCode: "Código postal",
    region: "Provincia (opcional)",
    country: "País",
    phone: "Teléfono",
    method: "Método de envío",
    quote: "Calcular envío",
    noMethods: "No enviamos a este destino todavía.",
    free: "Gratis",
    terms: "Acepto los términos y condiciones de venta.",
    pay: "Pagar",
    paying: "Redirigiendo al pago…",
    failed: "No se pudo iniciar el pago. Revisa los datos e inténtalo de nuevo.",
  },
  processing: {
    title: "Procesando tu pedido",
    waiting: "Estamos confirmando tu pago. No cierres esta página.",
    paid: "¡Pago confirmado! Te hemos enviado un email con los detalles.",
    failed: "El pago no se completó. Tu carrito sigue disponible.",
    order: "Pedido",
  },
  footer: { tagline: "赤い — streetwear de inspiración japonesa.", rights: "Todos los derechos reservados." },
  notFound: { title: "Página no encontrada", back: "Volver a la tienda" },
};

export type Messages = typeof es;

const en: Messages = {
  errors: {
    VALIDATION_FAILED: "Please check the details you entered.",
    UNAUTHENTICATED: "Your session has expired. Please sign in again.",
    FORBIDDEN: "You're not allowed to do that.",
    NOT_FOUND: "We couldn't find that.",
    CONFLICT: "Something changed in the meantime. Please reload.",
    IDEMPOTENCY_KEY_REUSED: "This was already submitted. Please reload.",
    RATE_LIMITED: "Too many attempts. Please wait a moment.",
    PAYMENT_FAILED: "Payment could not be started.",
    OUT_OF_STOCK: "An item has sold out.",
    PRICE_CHANGED: "A price has changed. Please review your cart.",
    ILLEGAL_STATE_TRANSITION: "This is no longer possible.",
    INTERNAL_ERROR: "Something went wrong. Please try again.",
    NETWORK: "Can't reach the shop right now. Please try again.",
  },
  cartProblems: {
    OUT_OF_STOCK: "Sold out.",
    INSUFFICIENT_STOCK: "Not enough units left.",
    PRODUCT_UNAVAILABLE: "No longer available.",
    PRICE_CHANGED: "The price has changed.",
    QUANTITY_EXCEEDS_MAX: "Maximum quantity exceeded.",
    COUNTRY_RESTRICTED: "Can't be shipped to your country.",
  },
  meta: { description: "Akai — Japanese-inspired streetwear. Limited runs, relaxed cuts." },
  nav: { shop: "Shop", cart: "Cart", account: "Account", signIn: "Sign in", language: "Español" },
  home: {
    kicker: "Streetwear · Tokyo",
    title: "Wear red.",
    lead: "Relaxed cuts and limited runs, designed between the street and the studio.",
    cta: "Shop the collection",
    newArrivals: "New arrivals",
    viewAll: "View all",
  },
  shop: { title: "Shop", all: "All", empty: "No products yet.", loadMore: "Load more" },
  product: {
    addToCart: "Add to cart",
    adding: "Adding…",
    added: "Added to cart",
    soldOut: "Sold out",
    selectOption: "Choose an option",
    description: "Description",
    viewCart: "View cart",
  },
  cart: {
    title: "Cart",
    empty: "Your cart is empty.",
    continue: "Continue shopping",
    subtotal: "Subtotal",
    discount: "Discount",
    total: "Total",
    remove: "Remove",
    checkout: "Checkout",
    loading: "Loading cart…",
    error: "The cart could not be loaded.",
  },
  checkout: {
    title: "Checkout",
    contact: "Contact",
    email: "Email",
    shipping: "Shipping",
    firstName: "First name",
    lastName: "Last name",
    line1: "Street",
    houseNumber: "Number",
    line2: "Apartment, suite (optional)",
    city: "City",
    postalCode: "Postal code",
    region: "Region (optional)",
    country: "Country",
    phone: "Phone",
    method: "Shipping method",
    quote: "Get shipping options",
    noMethods: "We don't ship to this destination yet.",
    free: "Free",
    terms: "I accept the terms and conditions of sale.",
    pay: "Pay",
    paying: "Redirecting to payment…",
    failed: "Payment could not be started. Check your details and try again.",
  },
  processing: {
    title: "Processing your order",
    waiting: "We're confirming your payment. Please keep this page open.",
    paid: "Payment confirmed! We've emailed you the details.",
    failed: "The payment didn't go through. Your cart is still available.",
    order: "Order",
  },
  footer: { tagline: "赤い — Japanese-inspired streetwear.", rights: "All rights reserved." },
  notFound: { title: "Page not found", back: "Back to the shop" },
};

const MESSAGES: Readonly<Record<Locale, Messages>> = { es, en };

export function messages(locale: Locale): Messages {
  return MESSAGES[locale];
}

/** The translated message for any error thrown by an API call. */
export function errorMessage(errors: Messages["errors"], error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string" && error.code in errors) {
    return errors[error.code as keyof Messages["errors"]];
  }
  return error instanceof TypeError ? errors.NETWORK : errors.INTERNAL_ERROR;
}
