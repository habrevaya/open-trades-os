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
  options: { maxBytes?: number; claimedType?: string | undefined; accept?: "documents" | "recordings" } = {},
): FileVerdict {
  if (bytes.length === 0) return { ok: false, reason: "That file is empty." };

  const limit = options.maxBytes ?? MAX_FILE_BYTES;
  if (bytes.length > limit) {
    return {
      ok: false,
      reason: `A file may be up to ${Math.round(limit / (1024 * 1024))} MB and that one is ${Math.round(bytes.length / (1024 * 1024))} MB.`,
    };
  }

  const signature = sniff(bytes, options.accept ?? "documents");
  if (!signature && options.accept === "recordings") {
    return { ok: false, reason: "That is not an MP3 or WAV recording." };
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
} as const;

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
 * of the types kept anywhere here, decided from the bytes.
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
  const verdict = checkFile(file.bytes, { maxBytes: EMAIL_ATTACHMENTS.maxFileBytes, claimedType: file.contentType });
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
