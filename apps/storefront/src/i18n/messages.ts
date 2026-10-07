import type { CartProblem, ErrorCode } from "@akai/contracts";

/**
 * Every user-visible string. The shop is Spanish only, so there is ONE
 * catalogue: `t`. Pages import it; islands receive the slice they need as a
 * prop, so the catalogue is not bundled into client JS wholesale.
 *
 * Server messages (`ApiError.message`, `CartProblem.message`) are English for
 * logs and are NEVER shown to shoppers. UI branches on the closed code enums
 * instead; these maps are total, so a new code is a compile error.
 */
type ErrorMessages = Readonly<Record<ErrorCode | "NETWORK", string>>;
type ProblemMessages = Readonly<Record<CartProblem["code"], string>>;

const errorMessages: ErrorMessages = {
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

const problemMessages: ProblemMessages = {
  OUT_OF_STOCK: "Agotado.",
  INSUFFICIENT_STOCK: "No quedan suficientes unidades.",
  PRODUCT_UNAVAILABLE: "Ya no está disponible.",
  PRICE_CHANGED: "El precio ha cambiado.",
  QUANTITY_EXCEEDS_MAX: "Has superado la cantidad máxima.",
  COUNTRY_RESTRICTED: "No se puede enviar a tu país.",
};

export const t = {
  errors: errorMessages,
  cartProblems: problemMessages,
  meta: {
    description: "Akai — streetwear de inspiración japonesa. Ediciones limitadas, cortes amplios.",
  },
  nav: {
    banner: "赤い · Ediciones limitadas · Tokio",
    shop: "Tienda",
    cart: "Carrito",
    account: "Mi cuenta",
    signIn: "Entrar",
  },
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
    countryFixed: "Enviamos solo a Colombia.",
    firstName: "Nombre",
    lastName: "Apellidos",
    line1: "Dirección (p. ej. Calle 10 # 43-21)",
    line2: "Apartamento, torre, barrio (opcional)",
    city: "Ciudad o municipio",
    region: "Departamento",
    regionPlaceholder: "Elige un departamento",
    phone: "Celular",
    documentType: "Tipo de documento",
    documentNumber: "Número de documento",
    documentTypes: {
      CC: "Cédula de ciudadanía",
      CE: "Cédula de extranjería",
      NIT: "NIT",
      PP: "Pasaporte",
      TI: "Tarjeta de identidad",
      PPT: "Permiso por protección temporal",
    },
    invalidPhone: "Escribe un celular colombiano: diez cifras que empiezan por 3.",
    invalidDocument: "Revisa el número de documento para el tipo elegido.",
    method: "Método de envío",
    quote: "Calcular envío",
    noMethods: "No hay métodos de envío disponibles ahora mismo.",
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
    pending:
      "Tu pago sigue en proceso (puede tardar con PSE, Nequi o transferencia). Te escribiremos por email en cuanto se confirme; puedes cerrar esta página.",
    review:
      "Estamos revisando tu pago. No intentes pagar de nuevo: te contactaremos por email en breve.",
    order: "Pedido",
  },
  footer: { tagline: "赤い — streetwear de inspiración japonesa.", rights: "Todos los derechos reservados." },
  notFound: { title: "Página no encontrada", back: "Volver a la tienda" },
};

export type Messages = typeof t;

/** The shopper-facing message for any error thrown by an API call. */
export function errorMessage(errors: Messages["errors"], error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string" && error.code in errors) {
    return errors[error.code as keyof Messages["errors"]];
  }
  return error instanceof TypeError ? errors.NETWORK : errors.INTERNAL_ERROR;
}
