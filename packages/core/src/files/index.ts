/**
 * FILES
 *
 * What a file is, decided from its bytes, and what may be kept.
 *
 * This module exists because three separate parts of the product needed the
 * same three decisions and only one of them had made any: `branding` sniffed
 * a logo, `attachment` held a storage key nothing ever wrote, and
 * `field_upload` held a queue of photographs from a technician's phone that
 * nothing ever drained. A second copy of a signature table would have been
 * the usual outcome, and a signature table that disagrees with another one is
 * a file that is a PNG on one screen and a document on the next.
 *
 * THE CONTENT TYPE ON AN UPLOAD IS A STRING THE CLIENT CHOSE.
 *
 * Trusting it means serving whatever somebody hands you, from your own
 * origin, under a name that makes a browser render it. That is the shape of
 * most file upload vulnerabilities and it is why nothing here reads the
 * claimed type except to disagree with it out loud.
 *
 * SVG IS NOT ACCEPTED ANYWHERE, and this is worth stating rather than
 * leaving as an omission. An SVG is a document that can carry script, so
 * serving one from the application's own origin is script execution on the
 * application's own domain by anybody who can reach an upload form. The
 * commonest reason somebody adds SVG support is a logo, and `branding` is
 * where that request arrives.
 */

export interface FileSignature {
  type: string;
  /** What the bytes look like. */
  bytes: number[];
  /** Where to look, when the magic is not at the start. */
  offset?: number;
  /** The extension a storage key gets. Never taken from the uploaded name. */
  extension: string;
}

/**
 * Every type this product will keep.
 *
 * Deliberately short. A list that accepts everything is a list nobody has
 * decided anything with, and every entry here is something a screen in this
 * product actually renders: photographs of work, a signature, and the PDF a
 * manufacturer sends as a warranty.
 */
export const SIGNATURES: readonly FileSignature[] = [
  { type: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], extension: "png" },
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff], extension: "jpg" },
  { type: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38], extension: "gif" },
  /** RIFF....WEBP. The four size bytes in between are why this needs an offset. */
  { type: "image/webp", bytes: [0x57, 0x45, 0x42, 0x50], offset: 8, extension: "webp" },
  { type: "image/x-icon", bytes: [0x00, 0x00, 0x01, 0x00], extension: "ico" },
  { type: "image/heic", bytes: [0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63], offset: 4, extension: "heic" },
  { type: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], extension: "pdf" },
];

/**
 * Call audio, accepted ONLY where a recording is being kept.
 *
 * Not in the list above, because nothing a person uploads is a call
 * recording: the only audio this product keeps is what its own carrier
 * webhook fetched for a call the recording check allowed. A general upload
 * form that took MP3s would be a way to put any audio at all on the
 * company's server.
 */
export const AUDIO_SIGNATURES: readonly FileSignature[] = [
  /** An MP3 with an ID3 tag, which is how carriers usually hand them over. */
  { type: "audio/mpeg", bytes: [0x49, 0x44, 0x33], extension: "mp3" },
  /** A bare MP3 frame header, MPEG-1 layer III, with and without a CRC. */
  { type: "audio/mpeg", bytes: [0xff, 0xfb], extension: "mp3" },
  { type: "audio/mpeg", bytes: [0xff, 0xfa], extension: "mp3" },
  { type: "audio/mpeg", bytes: [0xff, 0xf3], extension: "mp3" },
  /** RIFF....WAVE, the carrier's default when no format is asked for. */
  { type: "audio/wav", bytes: [0x57, 0x41, 0x56, 0x45], offset: 8, extension: "wav" },
];

/** What the bytes are, or nothing. Never what the upload claimed. */
export function sniff(bytes: Uint8Array, accept: "documents" | "recordings" = "documents"): FileSignature | null {
  for (const signature of accept === "recordings" ? AUDIO_SIGNATURES : SIGNATURES) {
    const at = signature.offset ?? 0;
    if (bytes.length < at + signature.bytes.length) continue;
    if (signature.bytes.every((byte, i) => bytes[at + i] === byte)) return signature;
  }
  return null;
}

/**
 * How big a single file may be.
 *
 * Twenty megabytes, which is roughly a modern phone photograph at full
 * resolution with room to spare. Not a hundred: these are stored by a self
 * hoster who may be running a five dollar virtual machine, and a technician
 * who can attach a two hundred megabyte video is a technician whose van
 * fills somebody's disk on a Tuesday.
 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export type FileVerdict =
  | { ok: true; contentType: string; extension: string; sizeBytes: number }
  | { ok: false; reason: string };

/**
 * Whether this may be kept.
 *
 * `claimedType` is accepted and used ONLY to make the refusal better. A
 * technician told "that is not an image" when they attached a HEIC their
 * phone called a JPEG has learned nothing; told that the file claims to be a
 * JPEG and is not one, they have something to say to whoever wrote the app.
 */
export function checkFile(
  bytes: Uint8Array,
  options: {
    maxBytes?: number;
    claimedType?: string | undefined;
    /**
     * `email` is the files that come with a reply: the pictures and PDF every upload takes, and also a Word
     * document, a spreadsheet, a text file and a zip (see `sniffEmailDocument`). Nothing else asks for it.
     */
    accept?: "documents" | "recordings" | "email";
    /** The name the file came with. Used only to tell a text file from a CSV, never to decide what the bytes are. */
    fileName?: string | undefined;
  } = {},
): FileVerdict {
  if (bytes.length === 0) return { ok: false, reason: "That file is empty." };

  const limit = options.maxBytes ?? MAX_FILE_BYTES;
  if (bytes.length > limit) {
    return {
      ok: false,
      reason: `A file may be up to ${Math.round(limit / (1024 * 1024))} MB and that one is ${Math.round(bytes.length / (1024 * 1024))} MB.`,
    };
  }

  const signature = sniff(bytes, options.accept === "recordings" ? "recordings" : "documents");
  if (!signature && options.accept === "recordings") {
    return { ok: false, reason: "That is not an MP3 or WAV recording." };
  }
  if (!signature && options.accept === "email") {
    const found = sniffEmailDocument(bytes, options.fileName ?? "");
    if (found?.ok === false) return { ok: false, reason: found.reason };
    if (found?.ok) {
      if (bytes.length > EMAIL_ATTACHMENTS.maxDocumentBytes) {
        return {
          ok: false,
          reason: `A ${found.label} may be up to ${Math.round(EMAIL_ATTACHMENTS.maxDocumentBytes / (1024 * 1024))} MB and that one is ${Math.max(1, Math.round(bytes.length / (1024 * 1024)))} MB. It is in the email at your provider.`,
        };
      }
      return { ok: true, contentType: found.type, extension: found.extension, sizeBytes: bytes.length };
    }
    return {
      ok: false,
      reason: "That is not a picture, a PDF, a Word document (.docx), a spreadsheet (.xlsx), a text file (.txt or .csv) or a zip."
        + " Older Word and Excel files (.doc, .xls) can carry macros and are not kept.",
    };
  }
  if (!signature) {
    const claimed = options.claimedType?.trim();
    const mismatch = claimed
      ? ` It claims to be ${claimed}, and it is not.`
      : "";
    return {
      ok: false,
      reason:
        "That is not a PNG, JPEG, GIF, WebP, ICO, HEIC or PDF."
        + mismatch
        + " SVG is deliberately not accepted: it can carry script, and files are served from the same origin as the application.",
    };
  }

  return {
    ok: true,
    contentType: signature.type,
    extension: signature.extension,
    sizeBytes: bytes.length,
  };
}

/**
 * Where a file lives, derived from what it IS rather than from what it is
 * attached to.
 *
 * Content addressed on purpose. The same photograph attached to a job, a
 * service report and an invoice is one set of bytes with three references,
 * and a technician whose phone retries an upload over a metered connection
 * sends it to the key it already occupies rather than to a second copy.
 *
 * The organization is in the key even though the hash alone would be unique,
 * because a self hoster looking at a directory or a bucket should be able to
 * see whose file is whose, and because two tenants sharing a key would mean
 * one could learn the other holds a file simply by trying to write it.
 *
 * The extension comes from the SNIFFED type. Taking it from the uploaded
 * name is the same mistake as trusting the content type, one layer down.
 */
export function storageKey(input: {
  organizationId: string;
  sha256: string;
  extension: string;
}): string {
  const hash = input.sha256.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`A storage key needs a SHA-256 hex digest, not ${input.sha256.slice(0, 16)}.`);
  }
  /**
   * Two levels of fan out from the hash, which is what every content
   * addressed store does and for the same reason: a single directory with
   * four hundred thousand files in it is a directory that takes a minute to
   * list on the day somebody needs to.
   */
  return `${input.organizationId}/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.${input.extension}`;
}

/**
 * Whether an upload should be tried again.
 *
 * Capped, because a queue that retries forever is how a phone spends a
 * technician's battery and a data allowance on a photograph the server has
 * already refused. Five is enough to survive a lift, a tunnel and a car
 * park; the sixth failure is telling you something.
 */
export const MAX_UPLOAD_ATTEMPTS = 5;

export const shouldRetry = (attempts: number): boolean => attempts < MAX_UPLOAD_ATTEMPTS;

/* ------------------------------------------------- files that come with an email */

/**
 * WHAT A REPLY BY EMAIL MAY BRING
 *
 * A customer answering an invoice attaches a photograph of the boiler or the
 * PDF of a warranty, and those are kept. Anybody on the internet can email
 * the reply address, though, so what comes in is held to the same short list
 * of types every upload here is (decided from the bytes), and to limits of its
 * own: ten files on one email, ten megabytes each and twenty five in all,
 * which is what a phone's photographs of one job come to. More than that is
 * somebody sending the company's server something it did not ask for.
 */
export const EMAIL_ATTACHMENTS = {
  maxFiles: 10,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
  /**
   * A Word document, a spreadsheet, a text file or a zip: a smaller limit than a picture's, because nothing here
   * can look inside one and a customer's quote or list of parts is a few hundred kilobytes, not ten megabytes.
   */
  maxDocumentBytes: 5 * 1024 * 1024,
} as const;

/* ------------------------------------- the documents a reply may bring besides pictures and PDFs */

/**
 * WHAT ELSE A REPLY MAY BRING: Word, spreadsheet, text and zip
 *
 * A customer's quote from another company is a .docx, a list of parts is an .xlsx or a .csv, a note is a
 * .txt, and a folder of paperwork is a .zip. Each is decided from its BYTES, as every other type is:
 *
 *   docx, xlsx   a zip with `[Content_Types].xml` and a `word/` or `xl/` folder. Never one that holds a
 *                macro project (`vbaProject.bin`), which is what a .docm is whatever it was called.
 *   zip          any other zip that can be read to the end of its table of contents. Never one that holds
 *                a program or a script by name, and never one that cannot be read (a damaged table, or
 *                the zip64 kind, which a file this small never needs).
 *   txt, csv     text with no control bytes, no NUL, and nothing that looks like a page or a script; a CSV
 *                only when the name says so. Bytes above 127 are allowed, so a spreadsheet saved as
 *                Windows text keeps its accents.
 *
 * NOT KEPT: the older Word and Excel formats (.doc, .xls), PowerPoint, RTF and templates, which can carry
 * macros or embedded objects under their ordinary extension, so there is no telling the safe one from the
 * other by looking. They are named and refused, as before.
 *
 * NONE OF THEM IS EVER SHOWN IN A PAGE. `serving` says how a stored file is sent back: pictures and PDFs
 * inline as they always were, everything else only as a download, under a content type that runs nothing.
 */
export type EmailDocumentKind = "docx" | "xlsx" | "txt" | "csv" | "zip";

const EMAIL_DOCUMENT_TYPES: Record<EmailDocumentKind, { type: string; label: string }> = {
  docx: { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", label: "Word document" },
  xlsx: { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", label: "spreadsheet" },
  txt: { type: "text/plain", label: "text file" },
  csv: { type: "text/csv", label: "text file" },
  zip: { type: "application/zip", label: "zip" },
};

/** Extensions that decide a file is not worth downloading before a byte is fetched. */
const LEGACY_OFFICE_EXTENSIONS = new Set(["doc", "dot", "xls", "xlt", "xla", "ppt", "pot", "pps", "rtf", "wps", "wbk"]);

const lastExtension = (fileName: string): string => {
  const parts = displayName(fileName).toLowerCase().split(".");
  return parts.length < 2 ? "" : parts[parts.length - 1]!.trim();
};

/** Whether a name says the file is an older Office file, which is never kept. */
export function isLegacyOfficeName(fileName: string): boolean {
  return LEGACY_OFFICE_EXTENSIONS.has(lastExtension(fileName));
}

/** Whether a name says the file is one of the document kinds, so the smaller limit can apply before it is downloaded. */
export function isDocumentName(fileName: string): boolean {
  return ["docx", "xlsx", "txt", "csv", "zip"].includes(lastExtension(fileName));
}

/**
 * The names in a zip's table of contents, or null when it cannot be read to the end (no end record, a table
 * outside the file, an entry that does not fit, or the zip64 marker). The bytes are never unpacked.
 */
export function zipEntryNames(bytes: Uint8Array): string[] | null {
  if (bytes.length < 22) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) return null;
  const count = view.getUint16(end + 10, true);
  const offset = view.getUint32(end + 16, true);
  if (count === 0 || count === 0xffff || offset === 0xffffffff || offset >= end) return null;
  const names: string[] = [];
  let at = offset;
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) return null;
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    if (at + 46 + nameLength + extraLength + commentLength > end) return null;
    names.push(new TextDecoder("utf-8").decode(bytes.subarray(at + 46, at + 46 + nameLength)));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

const looksLikeAPage = /<\s*(script|html|svg|iframe|object|embed)\b|<\?xml|<!doctype/i;

/**
 * What a reply's file is when it is not a picture or a PDF: one of the kinds above, a refusal in words, or
 * nothing (it is none of them). `fileName` only chooses between a text file and a CSV.
 */
export function sniffEmailDocument(
  bytes: Uint8Array, fileName: string,
): ({ ok: true; kind: EmailDocumentKind; type: string; extension: EmailDocumentKind; label: string } | { ok: false; reason: string } | null) {
  const accepted = (kind: EmailDocumentKind) => ({ ok: true as const, kind, type: EMAIL_DOCUMENT_TYPES[kind].type, extension: kind, label: EMAIL_DOCUMENT_TYPES[kind].label });
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (isZip) {
    const names = zipEntryNames(bytes);
    if (!names) return { ok: false, reason: "That zip could not be read to the end, so it is not kept." };
    if (names.some((name) => /(^|\/)vbaProject\.bin$/i.test(name))) {
      return { ok: false, reason: "That file holds a macro project, and a file that can run macros is never kept." };
    }
    /** An .xml inside a package is its content, not a program, so it is the one program extension passed over here. */
    const program = names.find((name) => !/\.(xml|rels)$/i.test(name) && isProgramName(name));
    if (program) return { ok: false, reason: `That zip holds a program or a script (${displayName(program)}), and those are never kept here.` };
    if (names.includes("[Content_Types].xml")) {
      if (names.some((name) => name.startsWith("word/"))) return accepted("docx");
      if (names.some((name) => name.startsWith("xl/"))) return accepted("xlsx");
    }
    return accepted("zip");
  }
  const extension = lastExtension(fileName);
  if (extension !== "txt" && extension !== "csv") return null;
  /** Control bytes other than tab, line feed, form feed and carriage return mean this is not text. */
  for (const byte of bytes) {
    if (byte === 0 || byte === 0x7f || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d)) return null;
  }
  const start = new TextDecoder("utf-8").decode(bytes.subarray(0, 8192));
  if (looksLikeAPage.test(start)) {
    return { ok: false, reason: "That text looks like a web page or a script, and those are never kept here." };
  }
  return accepted(extension);
}

/**
 * HOW A STORED FILE IS SENT BACK
 *
 * Pictures and PDFs are drawn in the page, as they always were. Everything else, which is what a Word
 * document, a spreadsheet, a text file or a zip is, is sent only as a download under a content type that
 * names no program and renders nothing, whatever it is stored as. Every route that serves a stored file
 * asks this rather than deciding for itself.
 */
export function serving(contentType: string): { contentType: string; inline: boolean } {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  if (type === "application/pdf" || (type.startsWith("image/") && type !== "image/svg+xml")) return { contentType: type, inline: true };
  return { contentType: "application/octet-stream", inline: false };
}

/**
 * Names a computer will run when the file is opened. Refused by name before a
 * byte is downloaded, so a program that says what it is costs nothing, and
 * refused by name even when the bytes would pass, because "invoice.pdf.exe"
 * saved from a download is a name somebody will double click.
 */
const PROGRAM_EXTENSIONS = new Set([
  "exe", "com", "bat", "cmd", "msi", "msp", "msc", "scr", "pif", "cpl", "dll", "sys", "lnk", "reg",
  "js", "jse", "mjs", "vbs", "vbe", "wsf", "wsh", "ws", "hta", "ps1", "psm1", "psd1", "ps1xml",
  "jar", "class", "sh", "bash", "zsh", "csh", "ksh", "command", "app", "dmg", "pkg", "apk", "deb", "rpm",
  "iso", "img", "vhd", "vhdx", "appx", "msix", "py", "pyw", "pl", "rb", "php", "html", "htm", "xhtml",
  "svg", "xml", "xsl", "url", "website", "inf", "gadget", "application", "chm", "docm", "xlsm", "pptm",
]);

/** Content types that are a program or a page, whatever the name says. */
const PROGRAM_TYPES = [
  "application/x-msdownload", "application/x-msdos-program", "application/x-ms-installer",
  "application/vnd.microsoft.portable-executable", "application/x-executable", "application/x-elf",
  "application/x-mach-binary", "application/x-sh", "application/x-shellscript", "application/java-archive",
  "application/javascript", "text/javascript", "application/x-javascript", "text/html", "application/xhtml+xml",
  "image/svg+xml", "application/hta", "application/x-bat", "application/vnd.ms-cab-compressed",
];

/** Whether a name or a claimed type says the file is a program, a script or a page. */
export function isProgramName(fileName: string, contentType?: string | null): boolean {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (PROGRAM_TYPES.includes(type)) return true;
  const parts = fileName.toLowerCase().trim().replace(/[.\s]+$/, "").split(".");
  if (parts.length < 2) return false;
  return parts.slice(1).some((part) => PROGRAM_EXTENSIONS.has(part.trim()));
}

/**
 * Whether the bytes are a program, whatever they were called: a Windows
 * program ("MZ"), a Linux one (ELF), a Mac one (Mach-O, both byte orders and
 * the universal kind) or a script that names its interpreter ("#!").
 */
export function isProgramBytes(bytes: Uint8Array): boolean {
  const at = (...magic: number[]) => magic.every((byte, i) => bytes[i] === byte);
  return at(0x4d, 0x5a)
    || at(0x7f, 0x45, 0x4c, 0x46)
    || at(0xfe, 0xed, 0xfa, 0xce) || at(0xfe, 0xed, 0xfa, 0xcf)
    || at(0xce, 0xfa, 0xed, 0xfe) || at(0xcf, 0xfa, 0xed, 0xfe)
    || at(0xca, 0xfe, 0xba, 0xbe)
    || at(0x23, 0x21);
}

/** One file an email named, as the provider described it before anything was downloaded. */
export interface EmailAttachmentNamed {
  fileName: string;
  contentType: string;
  /** What the provider says it weighs, when it says. */
  size?: number | null | undefined;
}

/**
 * Which of an email's files are worth downloading, from what the provider
 * said about them, in order: the first ten that are not programs and are not
 * said to be over the limit. A refusal says which file and why, in words, for
 * the thread.
 */
export function planEmailAttachments(named: readonly EmailAttachmentNamed[]): Array<{ fetch: true } | { fetch: false; refused: string }> {
  let taken = 0;
  return named.map((file) => {
    const name = displayName(file.fileName);
    if (isProgramName(file.fileName, file.contentType)) {
      return { fetch: false, refused: `${name} came with this email and was not kept: it is a program or a script, and those are never kept here.` };
    }
    if (taken >= EMAIL_ATTACHMENTS.maxFiles) {
      return { fetch: false, refused: `${name} came with this email and was not kept: only the first ${EMAIL_ATTACHMENTS.maxFiles} files on one email are kept. It is in the email at your provider.` };
    }
    if (isLegacyOfficeName(file.fileName)) {
      return { fetch: false, refused: `${name} came with this email and was not kept: an older Word, Excel or PowerPoint file can carry macros, and only .docx and .xlsx files are kept. It is in the email at your provider.` };
    }
    if (typeof file.size === "number" && isDocumentName(file.fileName) && file.size > EMAIL_ATTACHMENTS.maxDocumentBytes) {
      return { fetch: false, refused: `${name} came with this email and was not kept: a Word document, spreadsheet, text file or zip may be up to ${megabytes(EMAIL_ATTACHMENTS.maxDocumentBytes)} MB and it is ${megabytes(file.size)} MB. It is in the email at your provider.` };
    }
    if (typeof file.size === "number" && file.size > EMAIL_ATTACHMENTS.maxFileBytes) {
      return { fetch: false, refused: `${name} came with this email and was not kept: a file may be up to ${megabytes(EMAIL_ATTACHMENTS.maxFileBytes)} MB and it is ${megabytes(file.size)} MB. It is in the email at your provider.` };
    }
    taken += 1;
    return { fetch: true };
  });
}

/**
 * Whether one downloaded file may be kept: not a program by its bytes, within
 * the limit for one file and what is left of the limit for the email, and one
 * of the types kept anywhere here, decided from the bytes, or one of the document kinds a reply may bring.
 */
export function checkEmailAttachment(
  file: { fileName: string; contentType: string; bytes: Uint8Array },
  options: { bytesAlreadyKept: number },
): FileVerdict {
  const name = displayName(file.fileName);
  if (isProgramName(file.fileName, file.contentType) || isProgramBytes(file.bytes)) {
    return { ok: false, reason: `${name} came with this email and was not kept: it is a program or a script, and those are never kept here.` };
  }
  if (options.bytesAlreadyKept + file.bytes.length > EMAIL_ATTACHMENTS.maxTotalBytes) {
    return { ok: false, reason: `${name} came with this email and was not kept: the files on one email may come to ${megabytes(EMAIL_ATTACHMENTS.maxTotalBytes)} MB. It is in the email at your provider.` };
  }
  const verdict = checkFile(file.bytes, {
    maxBytes: EMAIL_ATTACHMENTS.maxFileBytes, claimedType: file.contentType, accept: "email", fileName: file.fileName,
  });
  if (!verdict.ok) return { ok: false, reason: `${name} came with this email and was not kept. ${verdict.reason}` };
  return verdict;
}

const megabytes = (bytes: number) => Math.max(1, Math.round(bytes / (1024 * 1024)));

/* ------------------------------------------ files a customer adds from the portal */

/**
 * WHAT A SIGNED IN CUSTOMER MAY ADD TO A JOB
 *
 * A photograph of the broken unit before the visit, or the PDF of a warranty.
 * The customer is known (they signed in with a code), but the upload form is
 * still on the open internet, so the same rules as a reply by email apply:
 * never a program, by its name, its claimed type or its bytes, and only the
 * types kept anywhere here, decided from the bytes. Narrower than that list,
 * too: a photograph (JPEG, PNG, HEIC, WebP) or a PDF, because that is what was
 * asked for and an icon or a GIF is not either.
 *
 * Five megabytes a file, because the form goes through a server action whose
 * body is capped at six. Ten files on one job and twenty five megabytes in
 * all, the email's limits, which is what a phone's photographs of one fault
 * come to. Twenty an hour per customer, counted before anything is kept, so a
 * script holding somebody's sign in cannot fill the company's disk.
 */
export const CUSTOMER_UPLOADS = {
  maxFileBytes: 5 * 1024 * 1024,
  maxFilesPerJob: EMAIL_ATTACHMENTS.maxFiles,
  maxTotalBytesPerJob: EMAIL_ATTACHMENTS.maxTotalBytes,
  perHour: 20,
  types: ["image/jpeg", "image/png", "image/heic", "image/webp", "application/pdf"] as readonly string[],
} as const;

/**
 * Whether one file a customer sent may be added to a job: not a program, a
 * photograph or a PDF by its bytes, within the size of one file, and within
 * what is left of the job's count and total. The words are the customer's to
 * read, so they say what to do instead.
 */
export function checkCustomerUpload(
  file: { fileName: string; contentType?: string | null | undefined; bytes: Uint8Array },
  options: { filesAlreadyAdded: number; bytesAlreadyAdded: number },
): FileVerdict {
  const name = displayName(file.fileName);
  if (isProgramName(file.fileName, file.contentType) || isProgramBytes(file.bytes)) {
    return { ok: false, reason: `${name} was not added: it is a program or a script, and those are never kept. Send a photo or a PDF.` };
  }
  if (options.filesAlreadyAdded >= CUSTOMER_UPLOADS.maxFilesPerJob) {
    return { ok: false, reason: `${name} was not added: you can add up to ${CUSTOMER_UPLOADS.maxFilesPerJob} files to one job. Remove one first, or call us.` };
  }
  if (file.bytes.length > CUSTOMER_UPLOADS.maxFileBytes) {
    return { ok: false, reason: `${name} was not added: a file can be up to ${megabytes(CUSTOMER_UPLOADS.maxFileBytes)} MB and that one is ${megabytes(file.bytes.length)} MB.` };
  }
  if (options.bytesAlreadyAdded + file.bytes.length > CUSTOMER_UPLOADS.maxTotalBytesPerJob) {
    return { ok: false, reason: `${name} was not added: the files on one job can come to ${megabytes(CUSTOMER_UPLOADS.maxTotalBytesPerJob)} MB in all.` };
  }
  const verdict = checkFile(file.bytes, {
    maxBytes: CUSTOMER_UPLOADS.maxFileBytes, ...(file.contentType ? { claimedType: file.contentType } : {}),
  });
  if (!verdict.ok || !CUSTOMER_UPLOADS.types.includes(verdict.contentType)) {
    return { ok: false, reason: `${name} was not added: only a photo (JPEG, PNG, HEIC or WebP) or a PDF can be added.` };
  }
  return verdict;
}

/* ------------------------------------------- files that come with a lead form */

/**
 * WHAT A STRANGER MAY SEND WITH A LEAD FORM
 *
 * A photograph of the leak, the PDF of last year's quote. Nobody is signed in:
 * the hosted form is on the open internet, so the rules are the customer
 * upload's (never a program, by name, claimed type or bytes; a photograph or a
 * PDF decided from the bytes) and the limits are smaller.
 *
 * Five files on one submission and four megabytes in all, because the whole
 * form goes in one post through a server action capped at six, and base64 makes
 * four megabytes a little over five. The page makes a photograph smaller before
 * it sends it, so five pictures of one fault fit with room to spare. Twenty
 * files an hour from one address, counted before a byte is read, so a script
 * cannot fill the company's disk one submission at a time.
 */
export const FORM_UPLOADS = {
  maxFiles: 5,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  perAddressPerHour: 20,
  types: CUSTOMER_UPLOADS.types,
} as const;

/** The longest base64 a file within the limit can be, for a check made before decoding. */
export const FORM_UPLOAD_MAX_BASE64 = Math.ceil(FORM_UPLOADS.maxFileBytes / 3) * 4;

/**
 * Whether a file named on a lead form is worth reading at all, from what the
 * page said about it: not a program by its name or its claimed type, and not
 * said to be larger than one file may be. Decided before the bytes are
 * decoded, so a program that says what it is costs nothing.
 */
export function planFormUpload(
  file: { fileName: string; contentType?: string | null | undefined; encodedLength: number },
): { ok: true } | { ok: false; reason: string } {
  const name = displayName(file.fileName);
  if (isProgramName(file.fileName, file.contentType)) {
    return { ok: false, reason: `${name} was not sent: it is a program or a script, and those are never kept. Send a photo or a PDF.` };
  }
  if (file.encodedLength > FORM_UPLOAD_MAX_BASE64) {
    return { ok: false, reason: `${name} was not sent: a file can be up to ${megabytes(FORM_UPLOADS.maxFileBytes)} MB.` };
  }
  return { ok: true };
}

/**
 * Whether one file sent with a lead form may be kept: not a program by its
 * bytes either, within what is left of the submission's count and total, and
 * a photograph or a PDF by its bytes. The words are for the person filling the
 * form in, so they say what to do instead.
 */
export function checkFormUpload(
  file: { fileName: string; contentType?: string | null | undefined; bytes: Uint8Array },
  options: { filesAlreadyAdded: number; bytesAlreadyAdded: number },
): FileVerdict {
  const name = displayName(file.fileName);
  if (isProgramName(file.fileName, file.contentType) || isProgramBytes(file.bytes)) {
    return { ok: false, reason: `${name} was not sent: it is a program or a script, and those are never kept. Send a photo or a PDF.` };
  }
  if (options.filesAlreadyAdded >= FORM_UPLOADS.maxFiles) {
    return { ok: false, reason: `${name} was not sent: you can send up to ${FORM_UPLOADS.maxFiles} files with this form.` };
  }
  if (file.bytes.length > FORM_UPLOADS.maxFileBytes) {
    return { ok: false, reason: `${name} was not sent: a file can be up to ${megabytes(FORM_UPLOADS.maxFileBytes)} MB and that one is ${megabytes(file.bytes.length)} MB.` };
  }
  if (options.bytesAlreadyAdded + file.bytes.length > FORM_UPLOADS.maxTotalBytes) {
    return { ok: false, reason: `${name} was not sent: the files sent with this form can come to ${megabytes(FORM_UPLOADS.maxTotalBytes)} MB in all.` };
  }
  const verdict = checkFile(file.bytes, {
    maxBytes: FORM_UPLOADS.maxFileBytes, ...(file.contentType ? { claimedType: file.contentType } : {}),
  });
  if (!verdict.ok || !FORM_UPLOADS.types.includes(verdict.contentType)) {
    return { ok: false, reason: `${name} was not sent: only a photo (JPEG, PNG, HEIC or WebP) or a PDF can be sent.` };
  }
  return verdict;
}

/**
 * A name somebody else chose, made safe to show and to offer as a download:
 * no folders, no control characters, no quotes, at most a hundred characters,
 * and never empty.
 */
export function displayName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, "").replace(/\s+/g, " ").trim().slice(0, 100);
  return cleaned || "attachment";
}

/**
 * The name a kept file is downloaded under: its own name with the extension
 * of what the bytes ARE, so a file sent as "photo.exe" that passed as a JPEG
 * could never be saved as a program, and with only letters, digits and a few
 * marks, because it goes into a header.
 */
export function downloadName(fileName: string, extension: string): string {
  const stem = displayName(fileName).replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9 ._-]/g, "").trim() || "attachment";
  return `${stem.slice(0, 80)}.${extension}`;
}
