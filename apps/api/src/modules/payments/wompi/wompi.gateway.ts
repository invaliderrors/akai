import type { WompiTransaction } from "./wompi-events";

/**
 * The ONLY outbound call this codebase makes to Wompi.
 *
 * ONE METHOD, AND THAT IS THE WHOLE INTEGRATION. Web Checkout needs no API call
 * to open (the URL is built and signed locally — `wompi-checkout.ts`), events
 * arrive by webhook, and Wompi has no refund endpoint for Web Checkout
 * payments. What is left is reading a transaction back with the PRIVATE key:
 * the return page and the reconciliation sweep both settle from Wompi's own
 * answer rather than from anything the browser says.
 *
 * A port rather than a bare `fetch` so the services are testable without
 * stubbing a global, and so "what can this system do to Wompi" is answerable
 * from one file. There is no card tokenisation, payment source, PSE bank list,
 * payout or wallet here, by design.
 */
export interface WompiGateway {
  /**
   * `GET /v1/transactions/{id}` with the private key.
   *
   * @returns the parsed transaction, or `null` when Wompi does not know the id
   *   (404) — a shopper-supplied id that is wrong is not an error worth a 5xx.
   * @throws PaymentsNotConfiguredError when no Wompi keys are configured.
   * @throws PaymentProviderUnavailableError on transport failure, 429 or 5xx.
   * @throws PaymentProviderRequestError on any other non-2xx, or a 2xx body
   *   that is not a transaction.
   */
  getTransaction(transactionId: string): Promise<WompiTransaction | null>;
}

/** DI token — `WompiGateway` is an interface and does not survive to runtime. */
export const WOMPI_GATEWAY = Symbol("WOMPI_GATEWAY");
