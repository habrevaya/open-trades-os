import type { FieldCustomerFile } from "./wire";

/**
 * THE FILES THE CUSTOMER SENT, AS THE PHONE SHOWS THEM
 *
 * A customer signs in to their own account and sends a photograph of the broken
 * unit, or a PDF, to a visit or its job (M05). The day carries them
 * (`customerFiles` on each visit). What the phone does with each is decided here,
 * in Node: a photograph is drawn as a thumbnail that opens full size, a PDF is
 * a line that opens in whatever on the phone reads PDFs, and anything else is a
 * line that says what it is and nothing opens, because the server only ever
 * stores those two.
 *
 * The bytes are not in the day, and not on the phone's disk: they are read with
 * the phone's own sign in when the technician looks, so they need a signal, and
 * go with the person who signs out.
 */
export type CustomerFileKind = "photo" | "pdf" | "other";

/** By the type the server sniffed from the bytes when it stored the file, never by the name the customer gave it. */
export function customerFileKind(file: Pick<FieldCustomerFile, "contentType">): CustomerFileKind {
  const type = (file.contentType ?? "").toLowerCase();
  if (type === "application/pdf") return "pdf";
  if (["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(type)) return "photo";
  return "other";
}

/** What to call it: the customer's own file name, or what it is. */
export function customerFileLabel(file: Pick<FieldCustomerFile, "fileName" | "contentType">): string {
  const name = file.fileName?.trim();
  if (name) return name;
  const kind = customerFileKind(file);
  return kind === "photo" ? "A photo" : kind === "pdf" ? "A PDF" : "A file";
}

/**
 * The files to show for a visit: photographs first, then PDFs, then the rest,
 * newest first within each (the server sends them newest first and a stable
 * sort keeps that), at most `limit` so a customer who sent forty does not make
 * the visit screen forty screens long.
 */
export function customerFilesToShow(
  files: readonly FieldCustomerFile[] | undefined, limit = 12,
): { shown: FieldCustomerFile[]; more: number } {
  const rank: Record<CustomerFileKind, number> = { photo: 0, pdf: 1, other: 2 };
  const ordered = (files ?? []).map((file, i) => ({ file, i }))
    .sort((a, b) => rank[customerFileKind(a.file)] - rank[customerFileKind(b.file)] || a.i - b.i)
    .map((x) => x.file);
  return { shown: ordered.slice(0, limit), more: Math.max(ordered.length - limit, 0) };
}

/** The name a downloaded PDF is kept under: only what is safe in a file name, ending `.pdf`. */
export function pdfFileName(file: Pick<FieldCustomerFile, "id" | "fileName">): string {
  const base = (file.fileName ?? "").replace(/\.pdf$/i, "").replace(/[^A-Za-z0-9 _-]+/g, "").trim().slice(0, 60);
  return `${base || "file"}-${file.id.slice(0, 8)}.pdf`;
}

/** What the person is told when a file could not be read. */
export function fileReadProblem(offline: boolean): string {
  return offline
    ? "There is no signal, so the file cannot be opened now. It opens when the phone is back online."
    : "The file could not be opened. The office may have taken it off the job.";
}

/** Said under the thumbnails when a photograph would not load, which with no signal is every one of them. */
export const PHOTOS_NOT_LOADED = "The photos could not be loaded. They need a signal, so try again when you have one.";
