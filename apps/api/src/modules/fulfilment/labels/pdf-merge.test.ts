import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { mergePdfs } from "./pdf-merge";

/** A one-page PDF whose page WIDTH identifies it, so order is observable. */
async function labelPdf(width: number, pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let index = 0; index < pages; index += 1) {
    doc.addPage([width, 420]);
  }
  return doc.save();
}

describe("mergePdfs", () => {
  it("concatenates every page in request order, preserving page size", async () => {
    const merged = await mergePdfs([await labelPdf(301), await labelPdf(302), await labelPdf(303)]);

    const doc = await PDFDocument.load(merged);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPages().map((page) => page.getWidth())).toEqual([301, 302, 303]);
    expect(doc.getPages().every((page) => page.getHeight() === 420)).toBe(true);
  });

  it("keeps a multi-page input's pages together, in place", async () => {
    const merged = await mergePdfs([await labelPdf(310, 2), await labelPdf(320)]);

    const doc = await PDFDocument.load(merged);
    expect(doc.getPages().map((page) => page.getWidth())).toEqual([310, 310, 320]);
  });

  it("rejects bytes that are not a PDF rather than printing a blank page", async () => {
    await expect(mergePdfs([new Uint8Array([1, 2, 3])])).rejects.toThrow();
  });
});
