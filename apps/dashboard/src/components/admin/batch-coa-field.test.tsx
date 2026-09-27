import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { Batch } from "@akai/contracts";

import { ToastProvider } from "@/components/ui/toast";

import { BatchCoaField } from "./batch-coa-field";
import esMessages from "../../../messages/es.json";

/**
 * The batch/COA control, at its two seams: recording a lot (no batch yet), and
 * uploading a certificate against one that already exists. `uploadBatchCoa`
 * (the presign → PUT → attach dance) has its own suite; this one is about
 * naming, which step the dialog opens on, and what reaches the two actions.
 */

const refresh = vi.fn();

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

const SKU = "AK-BPC-10";
const VARIANT_ID = "11111111-1111-4111-8111-111111111111";

const t = esMessages.admin.batchCoa;

const BATCH: Batch = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  lotCode: "L-2026-01",
  purityPercent: 99.5,
  testedAt: "2026-01-10T00:00:00.000Z",
  testMethod: "HPLC",
  coaUrl: null,
  expiresAt: null,
};

function named(template: string, value = SKU): string {
  return template.replace("{variant}", value);
}

function pdf(name = "coa.pdf") {
  return new File([new Uint8Array(64)], name, { type: "application/pdf" });
}

function wrap(children: React.ReactNode) {
  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <ToastProvider closeLabel={esMessages.ui.close}>{children}</ToastProvider>
    </NextIntlClientProvider>,
  );
}

function uploads(overrides: { onCreateBatch?: ReturnType<typeof vi.fn> } = {}) {
  return {
    onCreateBatch:
      overrides.onCreateBatch ?? vi.fn().mockResolvedValue({ ok: true, data: BATCH }),
    onRequestUpload: vi.fn().mockResolvedValue({
      ok: true,
      data: { uploadUrl: "https://storage.test/signed", objectKey: "coa/b1/k.pdf", expiresInSeconds: 600 },
    }),
    onAttach: vi.fn().mockResolvedValue({ ok: true, data: { ...BATCH, coaUrl: "https://cdn.test/coa.pdf" } }),
  };
}

beforeEach(() => {
  refresh.mockReset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("<BatchCoaField /> — naming and initial state", () => {
  it("names the trigger after the variant, offering to ADD when there is no batch", () => {
    wrap(
      <BatchCoaField variantName={SKU} variantId={VARIANT_ID} batch={null} uploads={uploads()} />,
    );

    expect(screen.getByRole("button", { name: named(t.add) })).toBeInTheDocument();
  });

  it("offers to VIEW once the variant has a batch with a certificate", () => {
    wrap(
      <BatchCoaField
        variantName={SKU}
        variantId={VARIANT_ID}
        batch={{ ...BATCH, coaUrl: "https://cdn.test/coa.pdf" }}
        uploads={uploads()}
      />,
    );

    expect(screen.getByRole("button", { name: named(t.view) })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: named(t.add) })).toBeNull();
  });
});

describe("<BatchCoaField /> — recording a lot", () => {
  async function openDialog() {
    const user = userEvent.setup();
    const u = uploads();
    wrap(<BatchCoaField variantName={SKU} variantId={VARIANT_ID} batch={null} uploads={u} />);
    await user.click(screen.getByRole("button", { name: named(t.add) }));
    return { user, u };
  }

  it("opens straight to the create-batch form when no batch exists yet", async () => {
    await openDialog();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText(t.lotCodeLabel)).toBeInTheDocument();
    expect(screen.getByLabelText(t.purityLabel)).toBeInTheDocument();
    expect(screen.getByLabelText(t.testMethodLabel)).toBeInTheDocument();
    expect(screen.getByLabelText(t.testedAtLabel)).toBeInTheDocument();
  });

  it("refuses to submit with a missing field or an out-of-range purity", async () => {
    const { user, u } = await openDialog();

    await user.type(screen.getByLabelText(t.lotCodeLabel), "L-1");
    await user.type(screen.getByLabelText(t.purityLabel), "150");
    await user.type(screen.getByLabelText(t.testMethodLabel), "HPLC");
    await user.click(screen.getByRole("button", { name: t.recordBatch }));

    expect(screen.getByText(t.invalidBatch)).toBeInTheDocument();
    expect(u.onCreateBatch).not.toHaveBeenCalled();
  });

  it("records the lot, in minor-free numeric form, against THIS variant", async () => {
    const { user, u } = await openDialog();

    await user.type(screen.getByLabelText(t.lotCodeLabel), "L-2026-01");
    await user.type(screen.getByLabelText(t.purityLabel), "99.5");
    await user.type(screen.getByLabelText(t.testMethodLabel), "HPLC");
    await user.type(screen.getByLabelText(t.testedAtLabel), "2026-01-10");
    await user.click(screen.getByRole("button", { name: t.recordBatch }));

    await waitFor(() => expect(u.onCreateBatch).toHaveBeenCalledTimes(1));
    expect(u.onCreateBatch).toHaveBeenCalledWith(VARIANT_ID, {
      lotCode: "L-2026-01",
      purityPercent: 99.5,
      testMethod: "HPLC",
      testedAt: new Date("2026-01-10").toISOString(),
    });
  });

  it("moves straight to the upload step once the lot is recorded, same dialog", async () => {
    const { user } = await openDialog();

    await user.type(screen.getByLabelText(t.lotCodeLabel), "L-2026-01");
    await user.type(screen.getByLabelText(t.purityLabel), "99.5");
    await user.type(screen.getByLabelText(t.testMethodLabel), "HPLC");
    await user.type(screen.getByLabelText(t.testedAtLabel), "2026-01-10");
    await user.click(screen.getByRole("button", { name: t.recordBatch }));

    expect(await screen.findByText(t.uploadLabel)).toBeInTheDocument();
    expect(screen.queryByLabelText(t.lotCodeLabel)).toBeNull();
  });

  it("names a duplicate lot code distinctly from a generic failure", async () => {
    const user = userEvent.setup();
    const u = uploads({
      onCreateBatch: vi
        .fn()
        .mockResolvedValue({ ok: false, code: "CONFLICT", reason: null, message: "dup" }),
    });
    wrap(<BatchCoaField variantName={SKU} variantId={VARIANT_ID} batch={null} uploads={u} />);
    await user.click(screen.getByRole("button", { name: named(t.add) }));

    await user.type(screen.getByLabelText(t.lotCodeLabel), "L-1");
    await user.type(screen.getByLabelText(t.purityLabel), "50");
    await user.type(screen.getByLabelText(t.testMethodLabel), "HPLC");
    await user.type(screen.getByLabelText(t.testedAtLabel), "2026-01-10");
    await user.click(screen.getByRole("button", { name: t.recordBatch }));

    expect(await screen.findByText(t.duplicateLot)).toBeInTheDocument();
  });
});

describe("<BatchCoaField /> — uploading a certificate", () => {
  it("uploads against the EXISTING batch without asking to record a lot again", async () => {
    const user = userEvent.setup();
    const u = uploads();
    wrap(<BatchCoaField variantName={SKU} variantId={VARIANT_ID} batch={BATCH} uploads={u} />);

    // BATCH has a recorded lot but no certificate yet, so the trigger still
    // reads "add" — "view" is reserved for a batch that already has one.
    await user.click(screen.getByRole("button", { name: named(t.add) }));
    expect(screen.queryByLabelText(t.lotCodeLabel)).toBeNull();
    expect(screen.getByText(t.uploadLabel)).toBeInTheDocument();

    const file = screen.getByLabelText(t.uploadLabel);
    await user.upload(file, pdf());

    await waitFor(() => expect(u.onAttach).toHaveBeenCalledWith(BATCH.id, { objectKey: "coa/b1/k.pdf" }));
    expect(await screen.findByText(t.uploadSuccess)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it("shows the current certificate link and the replace label inside the dialog", async () => {
    const user = userEvent.setup();
    const withCoa: Batch = { ...BATCH, coaUrl: "https://cdn.test/coa.pdf" };
    wrap(<BatchCoaField variantName={SKU} variantId={VARIANT_ID} batch={withCoa} uploads={uploads()} />);

    await user.click(screen.getByRole("button", { name: named(t.view) }));

    expect(screen.getByRole("link", { name: t.viewCurrent })).toHaveAttribute(
      "href",
      "https://cdn.test/coa.pdf",
    );
    expect(screen.getByText(t.replaceLabel)).toBeInTheDocument();
    expect(screen.queryByText(t.uploadLabel)).toBeNull();
  });

  it("surfaces an upload failure without pretending it succeeded", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    const u = uploads();
    wrap(<BatchCoaField variantName={SKU} variantId={VARIANT_ID} batch={BATCH} uploads={u} />);

    await user.click(screen.getByRole("button", { name: named(t.add) }));
    await user.upload(screen.getByLabelText(t.uploadLabel), pdf());

    expect(await screen.findByText(t.uploadError.uploadFailed)).toBeInTheDocument();
    expect(u.onAttach).not.toHaveBeenCalled();
    expect(screen.queryByText(t.uploadSuccess)).toBeNull();
  });
});
