import type { Locale } from "@akai/contracts";

/**
 * Every user-visible string. `es` is the source of truth for the key set;
 * `en` is typed against it, so a missing translation is a compile error.
 */
const es = {
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
