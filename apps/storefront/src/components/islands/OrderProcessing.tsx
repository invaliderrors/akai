import type { Locale } from "@akai/contracts";
import { useEffect, useState } from "react";

import type { Messages } from "@/i18n/messages";
import { CartClient } from "@/lib/cart-client";

interface Props {
  readonly apiUrl: string;
  readonly locale: Locale;
  readonly orderNumber: string;
  readonly t: Messages["processing"];
}

type Outcome = "waiting" | "paid" | "failed";

const POLL_MS = 2_500;
const MAX_POLLS = 48;

/**
 * The return page from hosted checkout. It POLLS rather than trusting the
 * redirect: an order becomes PAID only through the provider's verified webhook,
 * and a client-side "success" URL is trivially forged.
 */
export default function OrderProcessing({ apiUrl, locale, orderNumber, t }: Props) {
  const [outcome, setOutcome] = useState<Outcome>("waiting");

  useEffect(() => {
    const client = new CartClient(apiUrl, locale);
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      polls += 1;
      try {
        const status = await client.orderStatus(orderNumber);
        if (status.isPaid) return setOutcome("paid");
        if (status.isTerminal) return setOutcome("failed");
      } catch {
        // Transient — keep polling until the budget runs out.
      }
      if (polls < MAX_POLLS) timer = setTimeout(() => void poll(), POLL_MS);
    };

    void poll();
    return () => clearTimeout(timer);
  }, [apiUrl, locale, orderNumber]);

  return (
    <div role="status" className="space-y-3">
      <p className="text-xs font-bold uppercase tracking-[0.2em] text-stone">
        {t.order} {orderNumber}
      </p>
      <p className={outcome === "failed" ? "text-akai" : ""}>
        {outcome === "waiting" ? t.waiting : outcome === "paid" ? t.paid : t.failed}
      </p>
    </div>
  );
}
