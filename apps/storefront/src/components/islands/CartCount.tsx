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
    <span className="absolute -right-[7px] -top-[7px] box-border grid h-5 min-w-5 place-items-center rounded-full bg-akai px-[5px] text-[10px] font-bold text-white tabular-nums">
      {count}
    </span>
  );
}
