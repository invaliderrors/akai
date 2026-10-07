import type { Cart } from "@akai/contracts";
import { useEffect, useState } from "react";

import { CART_CHANGED_EVENT, CartClient } from "@/lib/cart-client";

interface Props {
  readonly apiUrl: string;
}

/** The header badge. Loads once, then follows every cart write on the page. */
export default function CartCount({ apiUrl }: Props) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    new CartClient(apiUrl)
      .fetch()
      .then((cart) => setCount(cart?.itemCount ?? 0))
      .catch(() => setCount(0));

    const onChange = (event: Event) => {
      if (event instanceof CustomEvent) setCount((event.detail as Cart).itemCount);
    };
    window.addEventListener(CART_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(CART_CHANGED_EVENT, onChange);
  }, [apiUrl]);

  return (
    <span className="inline-flex h-5 min-w-5 items-center justify-center bg-akai px-1 text-[10px] text-paper tabular-nums">
      {count}
    </span>
  );
}
