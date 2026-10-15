import { CUSTOMER_UPLOADS, checkCustomerUpload, displayName, type FileVerdict } from "../files/index.js";

/**
 * THE CHAT FROM A CUSTOMER'S ACCOUNT: WHAT IS SAID WHEN THE OFFICE ANSWERS,
 * AND WHAT PICTURES MAY GO IN IT
 *
 * Pure: the words and the rules in, a verdict out. The service decides who is
 * told and by what, and keeps the files.
 */

/* --------------------------------------------------- the reply notice */

/**
 * The notice a customer gets when the office has answered their chat. It names
 * the company and gives the link and nothing of the reply, on purpose: a text
 * sits on a lock screen and an email in an inbox other people read, and the
 * conversation is behind the customer's own sign in. Short, because a text
 * over 160 characters is two texts.
 */
export function chatReplyMessage(input: { companyName: string; customerName: string; url: string }):
  { subject: string; text: string; email: string } {
  const company = input.companyName.trim() || "Your service company";
  const first = input.customerName.trim().split(/\s+/)[0] ?? "";
  const hello = first === "" ? "Hi," : `Hi ${first},`;
  return {
    subject: `${company} answered your message`,
    text: `${hello} ${company} answered your message. Read it and reply here: ${input.url}`,
    email: `${hello}\n\n${company} answered your message. Read it and reply here:\n\n${input.url}\n\n`
      + "If you are not signed in, you will be asked for a sign in code first. "
      + "We send this once, and not again until you have read the answer.",
  };
}

/* ------------------------------------------------------ the pictures */

/**
 * What a customer may put in the chat, built on the customer upload rules
 * (`CUSTOMER_UPLOADS`: never a program, the type from the bytes, one file no
 * bigger than five megabytes) with three limits of the chat's own.
 *
 * Three pictures and five megabytes in one message, because the message goes
 * in one server action capped at six megabytes. And a day's total of what one
 * job may hold, because a chat has no job to count against and a sign in left
 * on a script should not be able to fill the company's disk one message at a
 * time. Photographs only: a PDF has its own place on the account.
 */
export const CHAT_PICTURES = {
  maxPerMessage: 3,
  maxMessageBytes: 5 * 1024 * 1024,
  maxBytesPerDay: CUSTOMER_UPLOADS.maxTotalBytesPerJob,
  types: ["image/jpeg", "image/png", "image/heic", "image/webp"] as readonly string[],
  /** What a browser draws in an image tag. A phone's HEIC is kept and offered as a download. */
  shownInPage: ["image/jpeg", "image/png", "image/webp", "image/gif"] as readonly string[],
} as const;

const megabytes = (bytes: number) => Math.max(1, Math.round(bytes / (1024 * 1024)));

/**
 * Whether one picture may go in this message: the upload rules first, then the
 * chat's three. The words are the customer's to read, so they say what to do.
 */
export function checkChatPicture(
  file: { fileName: string; contentType?: string | null | undefined; bytes: Uint8Array },
  options: { filesInMessage: number; bytesInMessage: number; bytesToday: number },
): FileVerdict {
  const name = displayName(file.fileName);
  if (options.filesInMessage >= CHAT_PICTURES.maxPerMessage) {
    return { ok: false, reason: `${name} was not sent: send up to ${CHAT_PICTURES.maxPerMessage} pictures in one message.` };
  }
  if (options.bytesInMessage + file.bytes.length > CHAT_PICTURES.maxMessageBytes) {
    return { ok: false, reason: `${name} was not sent: the pictures in one message can come to ${megabytes(CHAT_PICTURES.maxMessageBytes)} MB. Send fewer, or send them one at a time.` };
  }
  if (options.bytesToday + file.bytes.length > CHAT_PICTURES.maxBytesPerDay) {
    return { ok: false, reason: `${name} was not sent: you have sent a lot of pictures today. Try again tomorrow, or call us.` };
  }
  const verdict = checkCustomerUpload(file, { filesAlreadyAdded: 0, bytesAlreadyAdded: 0 });
  if (!verdict.ok) return verdict;
  if (!CHAT_PICTURES.types.includes(verdict.contentType)) {
    return { ok: false, reason: `${name} was not sent: only a photo (JPEG, PNG, HEIC or WebP) can go in the chat. A PDF goes through "Send us a photo or a PDF".` };
  }
  return verdict;
}
