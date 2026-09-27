import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import type { ActionResult } from "@/lib/admin/actions";
import { adminDiscountSchema, type AdminDiscount } from "@/lib/admin/schemas";
import esMessages from "../../../messages/es.json";

/**
 * The point of widening `ActionResult` to carry the error CODE.
 *
 * Before it did, a failed save reached this component as `{ ok: false, message }`
 * and `message` was the API's own English — "A discount with code SAVE10 already
 * exists." Rendering that breaks the never-show-a-server-message rule and leaves
 * a Spanish operator reading English; NOT rendering it left only "something went
 * wrong", which hides the one fact that tells them what to do. These tests pin
 * the third option: branch on the closed enum, render the catalogue's string.
 */

const createDiscountAction = vi.fn<
  (input: unknown) => Promise<ActionResult<{ id: string }>>
>();
const updateDiscountAction = vi.fn<
  (id: string, input: unknown) => Promise<ActionResult<{ id: string }>>
>();
const deleteDiscountAction = vi.fn<(id: string) => Promise<ActionResult<null>>>();

const push = vi.fn<(href: string) => void>();
const refresh = vi.fn<() => void>();

vi.mock("@/lib/admin/actions", () => ({
  createDiscountAction: (input: unknown) => createDiscountAction(input),
  updateDiscountAction: (id: string, input: unknown) => updateDiscountAction(id, input),
  deleteDiscountAction: (id: string) => deleteDiscountAction(id),
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push, refresh }),
  // The form's Cancel is a real link. Mocked to a bare anchor because the
  // locale-aware one needs a router context this suite deliberately has not
  // built — the assertion here is about the href the editor chose.
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const { DiscountEditor, actionErrorKey } = await import("./discount-editor");

const DISCOUNT_ID = "77777777-7777-4777-8777-777777777777";
const SERVER_ENGLISH = "A discount with code SAVE10 already exists.";

function buildDiscount(): AdminDiscount {
  return adminDiscountSchema.parse({
    id: DISCOUNT_ID,
    code: "SAVE10",
    type: "PERCENTAGE",
    value: 1000,
    minimumSubtotal: null,
    currency: null,
    maxRedemptions: null,
    maxRedemptionsPerCustomer: null,
    timesRedeemed: 0,
    remainingRedemptions: null,
    stackable: false,
    startsAt: null,
    endsAt: null,
    affiliateId: null,
    createdAt: "2026-07-20T10:00:00.000Z",
    updatedAt: "2026-07-20T10:00:00.000Z",
    deletedAt: null,
  });
}

function renderEditor(discount?: AdminDiscount) {
  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <DiscountEditor {...(discount === undefined ? {} : { discount })} />
    </NextIntlClientProvider>,
  );
}

async function fillAndSubmitNewCode(): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Código"), "save10");
  await user.type(screen.getByLabelText("Porcentaje de descuento"), "10");
  await user.click(screen.getByRole("button", { name: "Crear código" }));
}

describe("actionErrorKey", () => {
  it("maps every code to a key under the discounts namespace", () => {
    expect(actionErrorKey("CONFLICT")).toBe("errors.CONFLICT");
    expect(actionErrorKey("UNPARSEABLE_RESPONSE")).toBe("errors.UNPARSEABLE_RESPONSE");
  });

  it("falls back for a failure that was never an API error", () => {
    // A zod refusal inside the action itself throws something with no envelope,
    // so `code` is null and there is nothing to branch on.
    expect(actionErrorKey(null)).toBe("errors.UNKNOWN");
  });
});

describe("<DiscountEditor />", () => {
  beforeEach(() => {
    createDiscountAction.mockReset();
    updateDiscountAction.mockReset();
    deleteDiscountAction.mockReset();
    push.mockReset();
    refresh.mockReset();
  });

  it("tells the operator the code is taken, in their language", async () => {
    createDiscountAction.mockResolvedValue({
      ok: false,
      code: "CONFLICT",
      reason: null,
      message: SERVER_ENGLISH,
    });

    renderEditor();
    await fillAndSubmitNewCode();

    expect(
      await screen.findByText(
        "Ya existe un código de descuento con ese nombre. Elige otro.",
      ),
    ).toBeInTheDocument();
    // The API's own sentence must never reach the screen.
    expect(screen.queryByText(SERVER_ENGLISH)).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it("distinguishes a revoked session from a duplicate code", async () => {
    // Both used to arrive as an opaque `message`. The whole value of the code is
    // that these two produce different, actionable copy.
    createDiscountAction.mockResolvedValue({
      ok: false,
      code: "UNAUTHENTICATED",
      reason: null,
      message: "Session expired",
    });

    renderEditor();
    await fillAndSubmitNewCode();

    expect(
      await screen.findByText("Tu sesión ha caducado. Vuelve a iniciar sesión."),
    ).toBeInTheDocument();
  });

  it("falls back to a generic message when there is no code to branch on", async () => {
    createDiscountAction.mockResolvedValue({
      ok: false,
      code: null,
      reason: null,
      message: "TypeError: fetch failed",
    });

    renderEditor();
    await fillAndSubmitNewCode();

    expect(
      await screen.findByText("Algo ha ido mal. Inténtalo de nuevo."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/TypeError/)).toBeNull();
  });

  it("navigates to the new code's page on success", async () => {
    createDiscountAction.mockResolvedValue({ ok: true, data: { id: DISCOUNT_ID } });

    renderEditor();
    await fillAndSubmitNewCode();

    // A created code has a new id, so the edit page is a different URL — and the
    // push goes through @/i18n/navigation so the locale prefix survives.
    expect(push).toHaveBeenCalledWith(`/admin/discounts/${DISCOUNT_ID}`);
  });

  it("archives behind a typed confirmation, and keeps the dialog open on failure", async () => {
    const user = userEvent.setup();
    deleteDiscountAction.mockResolvedValue({
      ok: false,
      code: "FORBIDDEN",
      reason: null,
      message: "Admin role required",
    });

    renderEditor(buildDiscount());

    await user.click(screen.getByRole("button", { name: "Archivar código" }));
    // Typing the code is the safety property: it forces the operator to read
    // WHICH coupon they are on.
    await user.type(screen.getByLabelText(/Escribe/), "SAVE10");

    // The LAST match, not the only one. The trigger and the dialog's confirm
    // share a label — deliberately, since they promise the same thing — and
    // whether the trigger is still in the document while the dialog is open is
    // the confirm sheet's business, not this test's. DOM order puts the
    // dialog's control after the trigger either way.
    const confirm = screen.getAllByRole("button", { name: "Archivar código" }).at(-1);
    expect(confirm).toBeDefined();
    if (confirm === undefined) return;
    await user.click(confirm);

    expect(
      await screen.findByText(
        "Tu cuenta no tiene permiso para gestionar códigos de descuento.",
      ),
    ).toBeInTheDocument();
    // A failed archive that closes the dialog is indistinguishable from a
    // successful one until the next page load.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText("Admin role required")).toBeNull();
  });

  it("gives the form somewhere for Cancel to go", () => {
    // The editor owns the route because it is rendered in two places — the
    // detail page and the list's inline panel — and only the caller knows which
    // URL "cancel" means. The default is the list.
    renderEditor(buildDiscount());

    expect(screen.getByRole("link", { name: "Cancelar" })).toHaveAttribute(
      "href",
      "/admin/discounts",
    );
  });

  it("offers no archive action on an already-archived code", () => {
    const archived = adminDiscountSchema.parse({
      ...buildDiscount(),
      deletedAt: "2026-07-22T10:00:00.000Z",
    });

    renderEditor(archived);

    // Hidden, not disabled: the API's soft delete is idempotent and 404s on a
    // second call, so offering the button could only produce a confusing error.
    expect(screen.queryByRole("button", { name: "Archivar código" })).toBeNull();
  });
});
