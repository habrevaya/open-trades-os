import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";
import { Base64Bytes } from "./files";

/**
 * A SIGNED IN CUSTOMER CHATTING WITH THE COMPANY FROM THEIR ACCOUNT
 *
 * From a sign in only, like adding a file: an account link can be forwarded,
 * and who is writing is the sign in, never a name typed into the chat. The
 * conversation is the one the office answers in the inbox.
 *
 * Pictures go both ways, up to three in a message. A customer's are held to the
 * customer upload rules: a photo (JPEG, PNG, HEIC or WebP) by its bytes, never a
 * program, five megabytes in all in a message, and the same twenty an hour as a
 * file added to a job. The office's are the inbox reply's pictures.
 */

const Token = z.string().min(20).max(200);

const PortalChatView = z.object({
  /** Whether the company's automated assistant answers in customer accounts. */
  assistant: z.boolean(),
  /** Null before the customer has written. `handed_off` once a person has the conversation. */
  status: z.enum(["open", "handed_off", "closed"]).nullable(),
  bookingTaken: z.boolean(),
  messages: z.array(z.object({
    id: z.string(),
    /** `visitor` is the customer; `person` is somebody in the office; `assistant` is the automated assistant. */
    from: z.enum(["visitor", "assistant", "person"]),
    text: z.string(),
    at: z.string(),
    /** Pictures that came with it, by position, asked for with `getPortalChatPicture`. */
    pictures: z.array(z.object({
      index: z.number().int(),
      contentType: z.string(),
      name: z.string().nullable(),
      /** A browser can draw it. A phone's HEIC is kept and has to be opened, not drawn. */
      shown: z.boolean(),
    })),
  })),
});

export const getPortalChat = defineRoute({
  method: "get",
  path: "/v1/portal/chat",
  summary: "The signed in customer's chat with the company",
  description:
    "From a sign in only. The customer's own conversation, as the inbox has it, oldest first, or an empty one before they have written. `after` returns only what came since, for a page that keeps asking while it is open. Asking marks the chat read: the office's answers up to now stop counting as unread, and the customer is not told of the next one while the page is open.",
  module: "M05",
  permissions: [],
  authorization: "grant",
  input: z.object({ token: Token, after: z.string().datetime().optional() }),
  output: PortalChatView,
});

export const sayInPortalChat = defineRoute({
  method: "post",
  path: "/v1/portal/chat/messages",
  summary: "Write to the company from the customer's account",
  description:
    "From a sign in only. The message goes on the customer's own conversation in the inbox, under the customer the sign in names (or the contact signed in as them). The automated assistant answers only when the company turned it on for customer accounts and nobody in the office has taken the conversation; otherwise it waits for a person, unread, with a task when it goes from read to unread. A message with a picture always goes to a person, because the assistant cannot see it. Twelve a minute and sixty an hour per customer. Words, pictures or both: up to three photos (JPEG, PNG, HEIC or WebP, by their bytes) and 5 MB in a message, 25 MB a day, and the twenty an hour a file added to a job counts against. Any picture refused refuses the whole message.",
  module: "M05",
  permissions: [],
  authorization: "grant",
  idempotent: true,
  input: z.object({
    token: Token,
    text: z.string().max(2000),
    pictures: z.array(z.object({
      fileName: z.string().min(1).max(255),
      /** What the browser thinks it is. Not believed. */
      contentType: z.string().max(100).optional(),
      bytes: Base64Bytes,
    })).max(3).optional(),
  }),
  output: PortalChatView,
});

export const getPortalChatUnread = defineRoute({
  method: "get",
  path: "/v1/portal/chat/unread",
  summary: "How many answers from the office the signed in customer has not seen",
  description:
    "From a sign in only. The count behind the mark on the account page: answers from the office newer than the last time the customer opened the chat. Asking does not mark anything read.",
  module: "M05",
  permissions: [],
  authorization: "grant",
  input: z.object({ token: Token }),
  output: z.object({ unread: z.number().int() }),
});

export const getPortalChatPicture = defineRoute({
  method: "get",
  path: "/v1/portal/chat/pictures/{messageId}/{index}",
  summary: "One picture from the signed in customer's chat",
  description:
    "From a sign in only. The picture at that position on that message, only when the message is in this customer's own conversation: another customer's, a position with nothing kept and a made up id are the same not found. The bytes are base64, typed as they were found to be when kept.",
  module: "M05",
  permissions: [],
  authorization: "grant",
  input: z.object({ token: Token, messageId: Uuid, index: z.coerce.number().int().min(0).max(2) }),
  output: z.object({ contentType: z.string(), fileName: z.string().nullable(), bytes: z.string() }),
});

export const portalChatRoutes = { getPortalChat, sayInPortalChat, getPortalChatUnread, getPortalChatPicture } as const;
