import { PDFDocument } from "pdf-lib";

/**
 * Concatenate label PDFs into one document, IN THE ORDER GIVEN (spec §3.6 —
 * "one merged PDF of our stored label files, in the selected order").
 *
 * `pdf-lib` rather than a hand-rolled xref rewrite: PDF concatenation means
 * renumbering objects, merging resource dictionaries and rebuilding the page
 * tree, and a label that prints blank on the warehouse's thermal printer is a
 * bad way to find the edge case. It is pure JS with no native dependency.
 *
 * Every page of every input is copied (a Sendcloud A6 label is one page, but
 * nothing here assumes so), and the page size is preserved — A6 stays A6.
 */
export async function mergePdfs(pdfs: readonly Uint8Array[]): Promise<Uint8Array> {
  const merged = await PDFDocument.create();
  for (const bytes of pdfs) {
    const source = await PDFDocument.load(bytes);
    const pages = await merged.copyPages(source, source.getPageIndices());
    for (const page of pages) {
      merged.addPage(page);
    }
  }
  return merged.save();
}
