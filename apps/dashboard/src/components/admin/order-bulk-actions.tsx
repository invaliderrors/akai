"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { BulkLabelResult } from "@akai/contracts";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { clearTableSelection, useTableSelection } from "@/components/ui/table-selection";
import { useToast } from "@/components/ui/toast";
import { useRouter } from "@/i18n/navigation";
import type { ActionResult, PrintedLabelsPayload } from "@/lib/admin/actions";
import { generateLabelsAction, printLabelsAction } from "@/lib/admin/actions";
import { SKIP_REASON_KEY, labelFailureKey } from "@/lib/admin/fulfilment-display";

/** The two server actions, injectable so the component is testable without a server. */
export interface OrderBulkActionHandlers {
  readonly generate: (
    orderIds: readonly string[],
    idempotencyKey: string,
  ) => Promise<ActionResult<BulkLabelResult>>;
  readonly print: (orderIds: readonly string[]) => Promise<ActionResult<PrintedLabelsPayload>>;
}

const DEFAULT_HANDLERS: OrderBulkActionHandlers = {
  generate: generateLabelsAction,
  print: printLabelsAction,
};

export interface OrderBulkActionsProps {
  /** The `id` of the form the table's selection checkboxes belong to. */
  readonly formId: string;
  /** The checkboxes' name — `DataTable`'s default unless the page chose another. */
  readonly name?: string;
  /** id → order number, for the rows on this page (the print tally names orders by number). */
  readonly orderNumbers: Readonly<Record<string, string>>;
  readonly handlers?: OrderBulkActionHandlers;
}

/** Hand the browser a PDF as a download, without a round trip through a URL we would have to sign. */
function downloadPdf(base64: string, filename: string): void {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next task: some engines start the download asynchronously.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

/**
 * The order list's bulk label bar: "Generar etiquetas" and "Imprimir
 * etiquetas" over whatever rows are checked (Sendcloud spec §3.6, §7).
 *
 * THE RESULT IS TWO-LEVEL, by design. The toast is the one-glance tally
 * ("3 en preparación · 2 omitidas") and goes away; the per-order reasons for
 * the skipped ones stay on the page in a dismissible notice, because "AK-…:
 * su método no está vinculado a Sendcloud" is an instruction staff have to be
 * able to read after the toast is gone (toast.tsx says the same).
 *
 * "Generated" is phrased as "en preparación": the API answers once the jobs
 * are queued, before Sendcloud has sold anything, and claiming "creadas" at
 * that moment would be claiming something that can still fail.
 *
 * One Idempotency-Key per click, held until the answer comes back, so a
 * double-click or a retried request replays the first split instead of
 * queuing a second round of jobs.
 */
export function OrderBulkActions({
  formId,
  name = "selected",
  orderNumbers,
  handlers = DEFAULT_HANDLERS,
}: OrderBulkActionsProps) {
  const t = useTranslations("admin.fulfilment");
  const tRoot = useTranslations();
  const toast = useToast();
  const router = useRouter();
  const selected = useTableSelection({ form: formId, name });
  const [busy, setBusy] = useState<"generate" | "print" | null>(null);
  /** What stays on the page after the toast has gone: a title and one line per order. */
  const [detail, setDetail] = useState<{ title: string; lines: readonly string[] } | null>(null);
  const pendingKey = useRef<string | null>(null);

  const none = selected.length === 0;

  async function onGenerate(): Promise<void> {
    if (none || busy !== null) return;
    setBusy("generate");
    pendingKey.current ??= crypto.randomUUID();
    try {
      const result = await handlers.generate(selected, pendingKey.current);
      if (!result.ok) {
        toast.show({ tone: "danger", message: tRoot(labelFailureKey(result.code, result.reason)) });
        return;
      }
      // A settled answer: the next click is a new request.
      pendingKey.current = null;
      setDetail(
        result.data.skipped.length === 0
          ? null
          : {
              title: t("skippedTitle"),
              lines: result.data.skipped.map((entry) =>
                t("skippedItem", {
                  orderNumber: entry.orderNumber ?? t("unknownOrder"),
                  reason: tRoot(SKIP_REASON_KEY[entry.reason]),
                }),
              ),
            },
      );
      toast.show({
        tone: result.data.accepted.length > 0 ? "success" : "warning",
        message: t("generateResult", {
          accepted: result.data.accepted.length,
          skipped: result.data.skipped.length,
        }),
      });
      clearTableSelection({ form: formId, name });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function onPrint(): Promise<void> {
    if (none || busy !== null) return;
    setBusy("print");
    try {
      const result = await handlers.print(selected);
      if (!result.ok) {
        toast.show({ tone: "danger", message: tRoot(labelFailureKey(result.code, result.reason)) });
        return;
      }
      downloadPdf(
        result.data.pdfBase64,
        t("printFilename", { date: new Date().toISOString().slice(0, 10) }),
      );
      const missing = result.data.skippedOrderIds.length;
      toast.show({
        tone: missing > 0 ? "warning" : "success",
        message:
          missing > 0
            ? `${t("printResult", { count: result.data.count })} · ${t("printSkipped", { count: missing })}`
            : t("printResult", { count: result.data.count }),
      });
      setDetail(
        missing === 0
          ? null
          : {
              title: t("printSkipped", { count: missing }),
              lines: result.data.skippedOrderIds.map(
                (orderId) => orderNumbers[orderId] ?? t("unknownOrder"),
              ),
            },
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-2">
      <form
        id={formId}
        aria-label={t("bulkLabel")}
        onSubmit={(event) => {
          event.preventDefault();
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <span role="status" className="me-auto text-[13px] text-[var(--label-secondary)] tabular-nums">
          {t("selectedCount", { count: selected.length })}
        </span>
        <Button
          icon="tag"
          disabled={none}
          pending={busy === "generate"}
          pendingLabel={t("generating")}
          onClick={() => {
            void onGenerate();
          }}
        >
          {t("generate")}
        </Button>
        <Button
          icon="file-text"
          disabled={none}
          pending={busy === "print"}
          pendingLabel={t("printing")}
          onClick={() => {
            void onPrint();
          }}
        >
          {t("print")}
        </Button>
      </form>

      {detail === null ? null : (
        <Notice
          tone="warning"
          placement="inline"
          title={detail.title}
          dismiss={{
            label: t("dismiss"),
            onDismiss: () => {
              setDetail(null);
            },
          }}
        >
          <ul className="m-0 mt-1 list-none p-0">
            {detail.lines.map((line) => (
              <li key={line} className="text-[12px]">
                {line}
              </li>
            ))}
          </ul>
        </Notice>
      )}
    </div>
  );
}
