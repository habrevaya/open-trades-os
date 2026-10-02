import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import * as consent from "./consent";
import { NotFoundError, type RequestMeta } from "./context";

/**
 * THE PAGE THE SENDER HAS BEEN DEMANDING SINCE IT WAS WRITTEN
 *
 * `email.queue` refuses any marketing email without an unsubscribe URL. That
 * is correct: CAN-SPAM requires a working opt out, and since February 2024
 * Gmail and Yahoo both require one click unsubscribe from bulk senders or they
 * stop delivering. The gate is one of the better lines in this codebase.
 *
 * And this product served no unsubscribe page. The only way through the gate
 * was to hand it a URL belonging to something else, which means either a 404
 * in a List-Unsubscribe header or a page on another system that cannot write a
 * suppression into this database. Either way the company looks compliant,
 * passes its own check, and keeps emailing people who asked it to stop. A live
 * gate demanding something that does not exist is worse than no gate, because
 * it reads as solved.
 *
 * GET DESCRIBES. POST ACTS. This asymmetry is the whole design and it is not
 * pedantry about HTTP verbs.
 *
 * RFC 8058 one click is a POST, sent by the mailbox provider when somebody
 * presses the unsubscribe control Gmail draws next to the sender's name. A
 * human who instead clicks the link in the body of the email arrives with a
 * GET. So does every link prefetcher, every corporate mail scanner, every
 * security product that follows URLs in inbound mail, and every chat client
 * that renders a preview. If GET unsubscribed, a company's entire list would
 * be opted out by software over a few months with no human ever having clicked
 * anything, and the symptom would be a marketing list that mysteriously
 * stopped working.
 *
 * So GET returns what will happen and the address it is about, and nothing is
 * written. POST writes it.
 *
 * WHAT IT WRITES IS NARROW ON PURPOSE. A suppression for email MARKETING, not
 * a blanket one. Somebody who stops wanting promotions has not stopped wanting
 * their invoice, their appointment confirmation or their receipt, and a
 * product that reads "unsubscribe" as "never contact this person again" breaks
 * the company's ability to do business with a customer who is still a
 * customer. The STOP keyword on SMS is the blanket case, and that is because
 * the carrier has already stopped delivering.
 *
 * SMS IS NOT HERE. A text opt out is the STOP keyword, handled by the inbound
 * webhook, because that is the mechanism carriers mandate and the one every
 * recipient already knows. A link in a marketing text would be a second
 * mechanism competing with the one that works.
 */

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * The address, mostly hidden.
 *
 * The person holding this link already knows their own address, so showing it
 * in full tells them nothing new. A forwarded link, a link in a screenshot or
 * a link in a support ticket reaches somebody who does not, and this page is
 * unauthenticated. Enough to recognise, not enough to harvest.
 */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

async function linkFor(db: Database, token: string) {
  /**
   * NO `deleted_at` FILTER, and that is the same decision as the absent
   * expiry. Nothing deletes an unsubscribe link, soft or otherwise, because
   * doing so breaks a URL that is sitting in somebody's mailbox and may be
   * clicked in three years. A filter on a column nothing writes is a check
   * that cannot fail, and the next reader stops asking whether it exists.
   *
   * By hash, and the token is never stored. A database backup carrying these
   * rows cannot be turned into a list of working unsubscribe links, which
   * would otherwise be a way to opt a competitor's whole customer list out of
   * their own mail.
   */
  const [row] = await db.select().from(schema.unsubscribeLink)
    .where(eq(schema.unsubscribeLink.tokenHash, hashOf(token)))
    .limit(1);
  return row;
}

export interface UnsubscribeView {
  /** False for a token that resolves to nothing. No address, no company. */
  known: boolean;
  address: string | null;
  company: string | null;
  /** True once it has been acted on. A second visit says so rather than erroring. */
  done: boolean;
  /** What pressing the button will do, in the recipient's words. */
  message: string;
}

const UNKNOWN: UnsubscribeView = {
  known: false,
  address: null,
  company: null,
  done: false,
  /**
   * The same sentence for an expired link, a mistyped one and one that never
   * existed. Telling the difference would turn this endpoint into an oracle
   * for whether a given token is live, and the only party who benefits from
   * that is somebody enumerating them.
   */
  message: "This link is not valid. If you are still getting mail you did not ask for, reply to "
    + "any message from the company and ask them to take you off the list.",
};

/**
 * What this link is about. Writes nothing.
 *
 * NO EXPIRY, EVER. `portal_grant` has a NOT NULL `expires_at` and this
 * deliberately does not reuse it: somebody who finds an old email and tries to
 * stop hearing from a company must not be told the link has expired. Their next
 * move is the spam button, which costs the sending domain more than ten
 * unsubscribes and is invisible to the company that caused it.
 */
export async function describe(db: Database, input: { token: string }): Promise<UnsubscribeView> {
  const link = await linkFor(db, input.token);
  if (!link) return UNKNOWN;

  const [org] = await db.select({ name: schema.organization.name })
    .from(schema.organization)
    .where(eq(schema.organization.id, link.organizationId))
    .limit(1);

  return {
    known: true,
    address: maskAddress(link.address),
    company: org?.name ?? null,
    done: link.usedAt !== null,
    message: link.usedAt !== null
      ? "You are already unsubscribed from marketing email. You will still get messages about "
        + "work you have booked, invoices and receipts."
      : "Unsubscribing stops marketing email to this address. You will still get messages about "
        + "work you have booked, invoices and receipts.",
  };
}

/**
 * Do it.
 *
 * IDEMPOTENT, and the second press is answered with the same page rather than
 * an error. Somebody who clicks twice is somebody who is not sure it worked,
 * and "something went wrong" is the last thing to show them.
 */
export async function confirm(
  db: Database,
  input: { token: string },
  meta?: RequestMeta,
): Promise<UnsubscribeView> {
  const link = await linkFor(db, input.token);
  if (!link) return UNKNOWN;

  const [org] = await db.select({ name: schema.organization.name })
    .from(schema.organization)
    .where(eq(schema.organization.id, link.organizationId))
    .limit(1);

  const view: UnsubscribeView = {
    known: true,
    address: maskAddress(link.address),
    company: org?.name ?? null,
    done: true,
    message: "You are unsubscribed from marketing email. You will still get messages about work "
      + "you have booked, invoices and receipts.",
  };

  if (link.usedAt !== null) return view;

  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;

    /**
     * BOTH ROWS, and they do different jobs. The suppression is the
     * enforcement: `canSend` checks it first and refuses before anything else
     * can override it. The consent revocation is the evidence, which is what
     * answers "were you allowed to send that, on that day" a year later, and
     * it is also what stops an operator granting consent again from a stale
     * form and quietly resurrecting the address.
     *
     * Written here rather than through `consent.revoke`, which needs a
     * ServiceContext this caller does not have and cannot be given one: there
     * is nobody signed in. `recordWithin` is the shared half, so the
     * supersede-then-insert order has one implementation rather than two.
     */
    await consent.recordWithin(
      tx,
      { organizationId: link.organizationId, capturedByUserId: null },
      {
        address: link.address,
        channel: "email",
        purpose: "marketing",
        /**
         * `web_form` rather than `api`. The distinction is who acted, and the
         * recipient acted: they pressed a control in their own mail client.
         * Recording it as an API call would make the company's own evidence
         * say a system withdrew the consent on their behalf.
         */
        method: "web_form",
        proofReference: `unsubscribe_link:${link.id}`,
        ipAddress: meta?.ip ?? null,
      },
      "revoked",
    );

    /**
     * `onConflictDoNothing` with the partial index's own predicate. Both live
     * suppression indexes are partial on `lifted_at is null`, and the blanket
     * one is partial on `purpose is null` as well, so naming the columns alone
     * is a runtime error rather than a type error: Postgres answers "no unique
     * or exclusion constraint matching the ON CONFLICT specification".
     *
     * The conflict is the ordinary case rather than a race: an address already
     * suppressed for email marketing, reached through a second campaign's
     * link.
     */
    await tx.insert(schema.suppression).values({
      organizationId: link.organizationId,
      address: link.address,
      channel: "email",
      purpose: "marketing",
      reason: "unsubscribed",
    }).onConflictDoNothing({
      target: [
        schema.suppression.organizationId,
        schema.suppression.address,
        schema.suppression.channel,
        schema.suppression.purpose,
      ],
      /**
       * The per-purpose index's predicate, exactly. `purpose is not null`
       * rather than `is null`: this row carries a purpose, so the blanket
       * index is the wrong one and naming its predicate would have matched no
       * constraint at all.
       */
      where: sql`lifted_at is null and purpose is not null`,
    });

    await tx.update(schema.unsubscribeLink).set({
      usedAt: new Date(),
      usedIp: meta?.ip ?? null,
      updatedAt: new Date(),
    }).where(eq(schema.unsubscribeLink.id, link.id));
  });

  return view;
}

/**
 * Mint one for an address with no campaign behind it.
 *
 * The office sending a one off marketing email to a single customer hits the
 * same gate as a campaign does, and before this had the same nothing to point
 * at.
 */
export async function forAddress(db: Database, input: {
  organizationId: string; address: string;
}): Promise<{ url: string }> {
  const { mintUnsubscribe } = await import("./campaigns");
  const { url } = await mintUnsubscribe(db, input.organizationId, { address: input.address });
  return { url };
}

export const handlers = {
  describeUnsubscribe: (db: Database, input: { token: string }) => describe(db, input),
  confirmUnsubscribe: (db: Database, input: { token: string }, meta?: RequestMeta) =>
    confirm(db, input, meta),
} as const;

/** Re-exported so a caller that has a link can look it up without the token. */
export async function linkById(db: Database, id: string) {
  const [row] = await db.select().from(schema.unsubscribeLink)
    .where(eq(schema.unsubscribeLink.id, id))
    .limit(1);
  if (!row) throw new NotFoundError("Unsubscribe link");
  return row;
}
