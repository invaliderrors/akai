import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import { ConfirmActionError } from "./type-to-confirm-button";
import { DeleteProductButton } from "./delete-product-button";
import esMessages from "../../../messages/es.json";

/**
 * The safety control, tested through the component that supplies its copy.
 *
 * MOVED HERE FROM `order-controls.test.tsx`, where these assertions were
 * lodging in a file about order status and refunds — and where they were
 * written against the hardcoded English this component no longer carries. The
 * queries run against the REAL `es.json` rather than a fixture, so a translator
 * who reworded "puedes restaurarlo después" out of existence fails the test that
 * exists to keep that sentence true.
 *
 * What is worth pinning is not the paint. It is: the confirm stays off until the
 * slug is typed, a failure keeps the dialog open, the API's English never
 * reaches an operator, and two of these on one page do not share DOM ids.
 */

const SLUG = "bpc-157";
const del = esMessages.admin.productForm.delete;

function renderButton(onConfirm: () => Promise<void>) {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <DeleteProductButton productSlug={SLUG} onConfirm={onConfirm} />
    </NextIntlClientProvider>,
  );
}

/**
 * The trigger and the confirm differ by ONE character — "Eliminar producto…" vs
 * "Eliminar producto" — and `getByRole`'s string form matches the whole
 * accessible name, so the ellipsis is what keeps these two queries apart. That
 * is also the kit's copy rule working: a label ending in "…" opens a view, a
 * label without one does the thing.
 */
function trigger(): HTMLElement {
  return screen.getByRole("button", { name: del.trigger });
}

function confirm(): HTMLElement {
  return screen.getByRole("button", { name: del.confirm });
}

describe("<DeleteProductButton />", () => {
  it("requires the slug to be typed before deleting", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn<() => Promise<void>>(async () => {});

    renderButton(onConfirm);
    await user.click(trigger());

    expect(confirm()).toBeDisabled();

    // The safety property: typing the slug forces the operator to read WHICH
    // product they are on. The likeliest mistake is the right-looking row on the
    // wrong page, and an OK/Cancel dialog is dismissed by muscle memory.
    await user.type(screen.getByLabelText(/Escribe/), "wrong-slug");
    expect(confirm()).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("deletes once the slug matches", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn<() => Promise<void>>(async () => {});

    renderButton(onConfirm);
    await user.click(trigger());
    await user.type(screen.getByLabelText(/Escribe/), SLUG);
    await user.click(confirm());

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it("keeps the dialog open and does NOT leak the server's English when the delete fails", async () => {
    const user = userEvent.setup();

    renderButton(async () => {
      // What ProductEditor used to throw: `new Error(result.message)`, where
      // `message` is documented in lib/admin/actions.ts as "Server-authored
      // English — do NOT render it to an operator".
      throw new Error("Admin role required");
    });

    await user.click(trigger());
    await user.type(screen.getByLabelText(/Escribe/), SLUG);
    await user.click(confirm());

    // A failed delete that closes the dialog is indistinguishable from a
    // successful one until the next page load, so the dialog stays open and an
    // alert appears...
    const alert = await screen.findByRole("alert");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // ...but it carries this component's own translated copy, NOT the raw thrown
    // message.
    expect(alert).toHaveTextContent(del.fallback);
    expect(alert).not.toHaveTextContent("Admin role required");
  });

  it("shows a message the caller has explicitly marked as translated", async () => {
    const user = userEvent.setup();

    renderButton(async () => {
      throw new ConfirmActionError("Ese producto ya no existe.");
    });

    await user.click(trigger());
    await user.type(screen.getByLabelText(/Escribe/), SLUG);
    await user.click(confirm());

    // Opting in is what distinguishes "already translated" from "server prose",
    // so a specific reason is still reachable — it just has to be declared. And
    // it only works because this module RE-EXPORTS the kit's class: a second
    // class of the same name would fail `instanceof` and fall back silently.
    expect(await screen.findByRole("alert")).toHaveTextContent("Ese producto ya no existe.");
  });

  it("says the delete is reversible, because it is", async () => {
    const user = userEvent.setup();
    renderButton(async () => {});

    await user.click(trigger());

    // The API soft-deletes; orders and invoices reference products forever.
    // Copy implying permanence would send an operator asking for a restore that
    // they could have done themselves.
    expect(screen.getByRole("dialog")).toHaveTextContent(/puedes restaurarlo después/i);
  });

  it("gives two dialogs on one page their own ids", async () => {
    const user = userEvent.setup();

    render(
      <NextIntlClientProvider locale="es" messages={esMessages}>
        <DeleteProductButton productSlug={SLUG} onConfirm={async () => {}} />
        <DeleteProductButton productSlug="creatina" onConfirm={async () => {}} />
      </NextIntlClientProvider>,
    );

    const [first, second] = screen.getAllByRole("button", { name: del.trigger });
    if (first === undefined || second === undefined) {
      throw new Error("both triggers must render");
    }

    await user.click(first);
    await user.click(second);

    // The bug the extraction fixed: hardcoded ids meant the second dialog's
    // <label> pointed at the FIRST dialog's input, so typing the phrase the
    // screen asked for did nothing. Distinct ids per instance is the property,
    // and `useId()` is what supplies it.
    const inputs = screen.getAllByLabelText(/Escribe/);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.id).not.toBe(inputs[1]?.id);
  });
});
