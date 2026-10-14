import { z } from "zod";
import { defineRoute } from "../lib/define";

/**
 * A SIGNED IN CUSTOMER CHATTING WITH THE COMPANY FROM THEIR ACCOUNT
 *
 * From a sign in only, like adding a file: an account link can be forwarded,
 * and who is writing is the sign in, never a name typed into the chat. The
 * conversation is the one the office answers in the inbox.
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
  })),
});

export const getPortalChat = defineRoute({
  method: "get",
  path: "/v1/portal/chat",
  summary: "The signed in customer's chat with the company",
  description:
    "From a sign in only. The customer's own conversation, as the inbox has it, oldest first, or an empty one before they have written. `after` returns only what came since, for a page that keeps asking while it is open.",
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
    "From a sign in only. The message goes on the customer's own conversation in the inbox, under the customer the sign in names (or the contact signed in as them). The automated assistant answers only when the company turned it on for customer accounts and nobody in the office has taken the conversation; otherwise it waits for a person, unread, with a task when it goes from read to unread. Twelve a minute and sixty an hour per customer.",
  module: "M05",
  permissions: [],
  authorization: "grant",
  idempotent: true,
  input: z.object({ token: Token, text: z.string().min(1).max(2000) }),
  output: PortalChatView,
});

export const portalChatRoutes = { getPortalChat, sayInPortalChat } as const;
