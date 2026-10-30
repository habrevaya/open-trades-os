/**
 * WHAT CAME WITH A MESSAGE, IN THE THREAD
 *
 * A picture kept here is shown from this product's own copy, so nobody needs
 * a login at the carrier or the mail provider; a PDF, a Word document, a
 * spreadsheet, a text file or a zip on an email is a link to download it, by
 * the name it came with (a download only: the route never draws the last four). Both are served by the thread's own
 * route, which checks the reader may see this conversation. Anything not
 * kept says what it was and why, rather than leaving a gap.
 *
 * And the email's formatted part, when it said more than its plain words: as
 * TEXT, the only form it is kept in. React writes it as text, so a tag in it
 * is shown as the characters it is and never becomes markup.
 */
import { customerPortal } from "@opentradesos/core";

export interface MessageFile {
  contentType: string;
  storageKey?: string | undefined;
  refused?: string | undefined;
  name?: string | undefined;
  bytes?: number | undefined;
}

const size = (bytes: number | undefined) => {
  if (!bytes) return "";
  return bytes >= 1024 * 1024 ? `, ${(bytes / (1024 * 1024)).toFixed(1)} MB` : `, ${Math.max(1, Math.round(bytes / 1024))} KB`;
};

/** What a kept file is, in the words the thread uses beside its download. */
const kindOf = (contentType: string) =>
  contentType === "application/pdf" ? "PDF"
    : contentType.startsWith("image/") ? "photo"
      : contentType.includes("wordprocessingml") ? "Word document"
        : contentType.includes("spreadsheetml") ? "spreadsheet"
          : contentType === "text/csv" ? "spreadsheet text"
            : contentType === "text/plain" ? "text file"
              : contentType === "application/zip" ? "zip"
                : "file";

export function MessageFiles({
  conversationId, media, outbound, htmlText, body,
}: {
  conversationId: string;
  media: readonly MessageFile[];
  outbound: boolean;
  /** The email's HTML part as plain text, already stripped when it was kept. */
  htmlText?: string | null | undefined;
  body?: string | null | undefined;
}) {
  const href = (item: MessageFile) => `/inbox/${conversationId}/media/${item.storageKey!.split("/").map(encodeURIComponent).join("/")}`;
  const formatted = htmlText && htmlText.trim() !== (body ?? "").trim() ? htmlText : null;
  return (
    <>
      {media.map((item, i) => {
        if (item.storageKey && customerPortal.CHAT_PICTURES.shownInPage.includes(item.contentType)) {
          return (
            <a key={i} href={href(item)} target="_blank" rel="noreferrer" className="mt-2 block">
              <img src={href(item)} alt={item.name ?? (outbound ? "Picture sent" : "Picture from the customer")}
                   className="max-h-64 rounded border border-steel-200" />
            </a>
          );
        }
        if (item.storageKey) {
          return (
            <p key={i} className="mt-2">
              <a href={`${href(item)}?download=1`} className="underline underline-offset-4">
                Download {item.name ?? "the file"}
              </a>
              <span className="text-xs opacity-75"> ({kindOf(item.contentType)}{size(item.bytes)})</span>
            </p>
          );
        }
        return item.refused ? <p key={i} className="mt-2 text-xs italic">{item.refused}</p> : null;
      })}
      {formatted ? (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer">The email as it was laid out, as text</summary>
          <p className="mt-1 whitespace-pre-wrap">{formatted}</p>
        </details>
      ) : null}
    </>
  );
}
