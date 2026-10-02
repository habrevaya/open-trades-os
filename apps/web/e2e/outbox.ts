import { createClient, schema } from "@opentradesos/db";
import { commsOutbox } from "@opentradesos/api/services";
import type { MessagingProvider, OutboundMessage } from "@opentradesos/api/comms";
import { eq } from "drizzle-orm";

/**
 * The carrier, faked the way the service layer's own tests fake it.
 *
 * A text the office sends is queued, and the outbox hands it to whichever
 * provider the company connected. The outbox takes that provider as an
 * argument precisely so a test can hand it one that never reaches a network,
 * and this is that provider: it records what it was asked to send and says
 * it went. The seeded company has no carrier connected, so without this the
 * text would sit queued forever and the suite would have proved only that a
 * row was written.
 */
export function fakeCarrier() {
  const sent: OutboundMessage[] = [];
  const provider: MessagingProvider = {
    name: "e2e",
    async send(message) {
      sent.push(message);
      return { ok: true, providerMessageId: `E2E${sent.length}` };
    },
    verify: () => false,
    parseInbound: () => null,
    parseDelivery: () => null,
  };
  return { provider, sent };
}

/** Run the outbox for the company that owns this conversation, once. */
export async function flushOutbox(conversationId: string, provider: MessagingProvider) {
  const db = createClient();
  try {
    const [conversation] = await db.select({ organizationId: schema.conversation.organizationId })
      .from(schema.conversation).where(eq(schema.conversation.id, conversationId)).limit(1);
    if (!conversation) throw new Error(`No conversation ${conversationId}`);
    return await commsOutbox.flush(db, conversation.organizationId, { provider });
  } finally {
    await db.$close();
  }
}
