import { useEffect, useState } from "react";

import type { Messages } from "@/i18n/messages";
import { CartClient } from "@/lib/cart-client";
import { processingOutcome, type ProcessingOutcome } from "@/lib/payment-status";

interface Props {
  readonly apiUrl: string;
  readonly orderNumber: string;
  /** Wompi's `?id=`, already shape-checked by the page; null when absent. */
  readonly transactionId: string | null;
  readonly t: Messages["processing"];
}

/** What the screen says: a polled outcome, or "still pending" once the budget ran out. */
type Shown = ProcessingOutcome | "pending";

const POLL_MS = 2_500;
const MAX_POLLS = 48;

/**
 * The return page from Wompi. It POLLS rather than trusting the redirect: an
 * order becomes PAID only from a verified Wompi event or a transaction the API
 * read back from Wompi itself, and a client-side "success" URL is trivially
 * forged.
 *
 * When Wompi handed back a transaction id, the FIRST request asks the API to
 * confirm it (`POST …/confirm`) — which settles the order straight away if the
 * webhook is slow. The id is only a pointer: the API looks it up with its own
 * private key and checks it belongs to this order.
 */
export default function OrderProcessing({ apiUrl, orderNumber, transactionId, t }: Props) {
  const [shown, setShown] = useState<Shown>("waiting");

  useEffect(() => {
    const client = new CartClient(apiUrl);
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      polls += 1;
      try {
        const status =
          polls === 1 && transactionId !== null
            ? await client.confirmPayment(orderNumber, transactionId)
            : await client.orderStatus(orderNumber);
        const outcome = processingOutcome(status);
        if (outcome !== "waiting") return setShown(outcome);
      } catch {
        // Transient — keep polling until the budget runs out.
      }
      if (polls < MAX_POLLS) {
        timer = setTimeout(() => void poll(), POLL_MS);
      } else {
        // PSE, Nequi and bank transfers can take longer than two minutes; the
        // webhook still settles the order and the customer gets the email.
        setShown("pending");
      }
    };

    void poll();
    return () => clearTimeout(timer);
  }, [apiUrl, orderNumber, transactionId]);

  const message: Readonly<Record<Shown, string>> = {
    waiting: t.waiting,
    paid: t.paid,
    review: t.review,
    failed: t.failed,
    pending: t.pending,
  };

  return (
    <div role="status" className="space-y-3">
      <p className="text-xs font-bold uppercase tracking-[0.2em] text-stone">
        {t.order} {orderNumber}
      </p>
      <p className={shown === "failed" ? "text-akai" : ""}>{message[shown]}</p>
    </div>
  );
}
