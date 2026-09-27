import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import type { ActionResult } from "@/lib/admin/actions";
import { adminAffiliateSchema, type AdminAffiliate } from "@/lib/admin/schemas";
import esMessages from "../../../messages/es.json";

const createAffiliateAction = vi.fn<
  (input: unknown) => Promise<ActionResult<{ id: string }>>
>();
const updateAffiliateAction = vi.fn<
  (id: string, input: unknown) => Promise<ActionResult<{ id: string }>>
>();
const deleteAffiliateAction = vi.fn<(id: string) => Promise<ActionResult<null>>>();

const push = vi.fn<(href: string) => void>();
const refresh = vi.fn<() => void>();

vi.mock("@/lib/admin/actions", () => ({
  createAffiliateAction: (input: unknown) => createAffiliateAction(input),
  updateAffiliateAction: (id: string, input: unknown) => updateAffiliateAction(id, input),
  deleteAffiliateAction: (id: string) => deleteAffiliateAction(id),
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push, refresh }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const { AffiliateEditor, actionErrorKey } = await import("./affiliate-editor");

const AFFILIATE_ID = "88888888-8888-4888-8888-888888888888";
const ISO = "2026-07-20T10:00:00.000Z";

function buildAffiliate(): AdminAffiliate {
  return adminAffiliateSchema.parse({
    id: AFFILIATE_ID,
    name: "Ana",
    country: "ES",
    socialHandle: "@ana",
    email: "ana@example.com",
    discountCodes: ["SAVE10"],
    redemptionCount: 3,
    revenueMinor: 14997,
    hasLogin: false,
    createdAt: ISO,
    updatedAt: ISO,
    deletedAt: null,
  });
}

function renderEditor(affiliate?: AdminAffiliate) {
  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <AffiliateEditor {...(affiliate === undefined ? {} : { affiliate })} />
    </NextIntlClientProvider>,
  );
}

function labelStartingWith(text: string): (content: string) => boolean {
  return (content) => content.startsWith(text);
}

async function fillAndSubmitNew(): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(labelStartingWith("Nombre")), "Ana");
  await user.type(screen.getByLabelText(labelStartingWith("País")), "es");
  await user.type(screen.getByLabelText(labelStartingWith("Usuario o red social")), "@ana");
  await user.type(
    screen.getByLabelText(labelStartingWith("Correo electrónico")),
    "ana@example.com",
  );
  await user.click(screen.getByRole("button", { name: "Crear afiliado" }));
}

describe("actionErrorKey", () => {
  it("maps every code to a key under the affiliates namespace", () => {
    expect(actionErrorKey("CONFLICT")).toBe("errors.CONFLICT");
    expect(actionErrorKey("UNPARSEABLE_RESPONSE")).toBe("errors.UNPARSEABLE_RESPONSE");
  });

  it("falls back for a failure that was never an API error", () => {
    expect(actionErrorKey(null)).toBe("errors.UNKNOWN");
  });
});

describe("<AffiliateEditor />", () => {
  beforeEach(() => {
    createAffiliateAction.mockReset();
    updateAffiliateAction.mockReset();
    deleteAffiliateAction.mockReset();
    push.mockReset();
    refresh.mockReset();
  });

  it("navigates to the new affiliate's page on success", async () => {
    createAffiliateAction.mockResolvedValue({ ok: true, data: { id: AFFILIATE_ID } });

    renderEditor();
    await fillAndSubmitNew();

    expect(push).toHaveBeenCalledWith(`/admin/affiliates/${AFFILIATE_ID}`);
  });

  it("shows a translated failure rather than the API's own English", async () => {
    createAffiliateAction.mockResolvedValue({
      ok: false,
      code: "VALIDATION_FAILED",
      reason: null,
      message: "Invalid email format",
    });

    renderEditor();
    await fillAndSubmitNew();

    expect(
      await screen.findByText("Revisa los datos del formulario: el servidor los ha rechazado."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Invalid email format")).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it("archives behind a typed confirmation, and keeps the dialog open on failure", async () => {
    const user = userEvent.setup();
    deleteAffiliateAction.mockResolvedValue({
      ok: false,
      code: "FORBIDDEN",
      reason: null,
      message: "Admin role required",
    });

    renderEditor(buildAffiliate());

    await user.click(screen.getByRole("button", { name: "Archivar afiliado" }));
    // The confirm phrase is the social handle — the one short identifier this
    // record carries. See `AffiliateEditor`'s own doc comment for why.
    await user.type(screen.getByLabelText(/Escribe/), "@ana");

    const confirm = screen.getAllByRole("button", { name: "Archivar afiliado" }).at(-1);
    expect(confirm).toBeDefined();
    if (confirm === undefined) return;
    await user.click(confirm);

    expect(
      await screen.findByText("Tu cuenta no tiene permiso para gestionar afiliados."),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText("Admin role required")).toBeNull();
  });

  it("gives the form somewhere for Cancel to go", () => {
    renderEditor(buildAffiliate());

    expect(screen.getByRole("link", { name: "Cancelar" })).toHaveAttribute(
      "href",
      "/admin/affiliates",
    );
  });

  it("offers no archive action on an already-archived affiliate", () => {
    const archived = adminAffiliateSchema.parse({
      ...buildAffiliate(),
      deletedAt: "2026-07-22T10:00:00.000Z",
    });

    renderEditor(archived);

    expect(screen.queryByRole("button", { name: "Archivar afiliado" })).toBeNull();
  });
});
