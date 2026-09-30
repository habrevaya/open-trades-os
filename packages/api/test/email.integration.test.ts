import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as email from "../src/services/email";
import { flush as smsFlush, claimOne } from "../src/services/comms-outbox";
import type { MessagingProvider } from "../src/comms/provider";
import type {
  EmailProvider, OutboundEmail, SendResult,
} from "../src/email/provider";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE EMAIL BOUNDARY
 *
 * Everything here is about the four ways an email system hurts the company
 * running it: mail sent to somebody who asked it to stop, mail sent twice,
 * mail whose delivery is claimed and not known, and a suppression written
 * from a forged webhook.
 *
 * The provider is always a fake. A test that reaches a real mail server is a
 * test that fails on a train and delivers mail to a stranger the first time
 * somebody fat fingers a fixture.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("em:org");
const USER = fixtureId("em:user");
const FROM = "hello@example-trades.com";
const TO = "owner@customer.test";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

/** A provider that never opens a socket and can be told exactly how to fail. */
function fakeProvider(behaviour: {
  result?: SendResult;
  resultsInOrder?: SendResult[];
  reports?: boolean;
  /** Runs while the provider is "busy", which is where a second worker races in. */
  onSend?: (message: OutboundEmail) => Promise<void>;
} = {}): EmailProvider & { sent: OutboundEmail[] } {
  const sent: OutboundEmail[] = [];
  return {
    name: "fake",
    sent,
    delivery: behaviour.reports === false
      ? { kind: "none", because: "This fake reports nothing, like every SMTP relay." }
      : { kind: "webhook", verify: () => true, parse: () => null },
    async send(message) {
      sent.push(message);
      await behaviour.onSend?.(message);
      const next = behaviour.resultsInOrder?.[sent.length - 1];
      return next ?? behaviour.result ?? { ok: true, providerMessageId: `re_${sent.length}` };
    },
  };
}

/** The SMS side's fake, for the one test about the two outboxes sharing a table. */
function fakeCarrier(): MessagingProvider & { sent: string[] } {
  const sent: string[] = [];
  return {
    name: "fake-carrier",
    sent,
    async send(message) {
      sent.push(message.body);
      return { ok: true, providerMessageId: `SM${sent.length}` };
    },
    verify: () => true,
    parseInbound: () => null,
    parseDelivery: () => null,
  };
}

async function connect(settings: Record<string, unknown> = {}): Promise<void> {
  await raw`
    insert into public.integration_connection
      (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected',
            ${raw.json({ fromAddress: FROM, ...settings })})`;
}

async function grantMarketingConsent(address = TO): Promise<void> {
  await raw`
    insert into public.communication_consent
      (organization_id, address, channel, purpose, state, method, proof_text)
    values (${ORG}, ${address}, 'email', 'marketing', 'granted', 'web_form',
            'Tick to hear about seasonal offers')`;
}

const messageRow = (id: string) => raw<{
  status: string; provider_message_id: string | null; delivered_at: Date | null;
  error_code: string | null; consent_id: string | null;
  headers: Record<string, string>; subject: string | null;
  body: string | null; body_html: string | null;
}[]>`
  select status, provider_message_id, delivered_at, error_code, consent_id,
         headers, subject, body, body_html
  from public.message where id = ${id}`;

async function queued(overrides: Partial<email.QueueEmailInput> = {}): Promise<string> {
  const outcome = await email.queue(owner(), {
    to: TO, subject: "Your invoice", text: "Attached.", ...overrides,
  });
  if (!outcome.queued) throw new Error(`expected queued, got ${outcome.reason}`);
  return outcome.messageId;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Email Co", slug: "email-co" });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.message where organization_id = ${ORG}`;
  await raw`delete from public.conversation where organization_id = ${ORG}`;
  await raw`delete from public.suppression where organization_id = ${ORG}`;
  await raw`delete from public.communication_consent where organization_id = ${ORG}`;
  await raw`delete from public.integration_connection where organization_id = ${ORG}`;
  await raw`delete from public.audit_log where organization_id = ${ORG}`;
});

run("what will not be queued", () => {
  it("refuses an email with no subject", async () => {
    /**
     * A blank subject is one of the oldest spam signatures there is. It costs
     * the caller one line to supply and costs the sending domain a little
     * reputation every time it goes without one.
     */
    await connect();
    await expect(email.queue(owner(), { to: TO, subject: "   ", text: "hi" }))
      .rejects.toThrow(/needs a subject/i);
  });

  it("refuses an email with no body at all", async () => {
    await connect();
    await expect(email.queue(owner(), { to: TO, subject: "Hello" }))
      .rejects.toThrow(/needs a body/i);
  });

  it("refuses HTML with no plain text alternative", async () => {
    /**
     * The strongest content signal a spam filter has short of the words
     * themselves, and it is also what a screen reader receives. Generating
     * the text part by stripping tags would produce something unreadable and
     * claim it was an alternative.
     */
    await connect();
    await expect(email.queue(owner(), {
      to: TO, subject: "Spring service", html: "<p>Book now</p>",
    })).rejects.toThrow(/plain text alternative/i);
  });

  it("refuses a marketing email with no unsubscribe URL", async () => {
    /**
     * CAN-SPAM and the Gmail and Yahoo bulk sender rules both require a
     * working opt out, and this is the only place it can be enforced: once
     * the message is with the provider it has already left.
     */
    await connect();
    await grantMarketingConsent();
    await expect(email.queue(owner(), {
      to: TO, subject: "Spring offer", text: "Book now", purpose: "marketing",
    })).rejects.toThrow(/unsubscribe URL/i);
  });

  it("refuses a suppressed address, as a refusal rather than an error", async () => {
    await connect();
    await raw`
      insert into public.suppression (organization_id, address, channel, reason)
      values (${ORG}, ${TO}, 'email', 'hard_bounce')`;

    const outcome = await email.queue(owner(), { to: TO, subject: "Hi", text: "Hi" });
    expect(outcome.queued).toBe(false);
    if (outcome.queued) throw new Error("unreachable");
    expect(outcome.reason).toBe("suppressed");
    expect(outcome.explanation).toMatch(/do-not-email/i);
  });

  it("matches a suppression whatever case the address was typed in", async () => {
    await connect();
    await raw`
      insert into public.suppression (organization_id, address, channel, reason)
      values (${ORG}, ${TO}, 'email', 'hard_bounce')`;

    const outcome = await email.queue(owner(), {
      to: "Owner@Customer.TEST", subject: "Hi", text: "Hi",
    });
    expect(outcome.queued).toBe(false);
  });

  it("refuses marketing with no consent on record", async () => {
    /**
     * Stricter than CAN-SPAM, deliberately. A self hosted product cannot know
     * whether its operator is under CASL or the GDPR, and the alternative is
     * two consent models in one codebase.
     */
    await connect();
    const outcome = await email.queue(owner(), {
      to: TO, subject: "Spring offer", text: "Book now",
      purpose: "marketing", unsubscribeUrl: "https://example.com/u/1",
    });
    expect(outcome.queued).toBe(false);
    if (outcome.queued) throw new Error("unreachable");
    expect(outcome.reason).toBe("no_consent");
  });

  it("refuses everything when no email provider is connected", async () => {
    const outcome = await email.queue(owner(), { to: TO, subject: "Hi", text: "Hi" });
    expect(outcome.queued).toBe(false);
    if (outcome.queued) throw new Error("unreachable");
    expect(outcome.reason).toBe("channel_not_registered");
  });

  it("tells canSend the channel is unregistered when nothing is connected", async () => {
    /**
     * Asserted on the DECISION rather than only on the queue, because the
     * queue refuses a missing sender a second time on its own. With only the
     * outer test, `channelRegistered` could answer true for a company with no
     * provider at all and nothing would notice, and that answer is what a
     * settings screen and every future caller of `emailability` would read.
     */
    const decision = await email.emailability(db(), ORG, TO, "transactional");
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.reason).toBe("channel_not_registered");
  });

  it("refuses a From address outside the domains the operator declared verified", async () => {
    /**
     * The declared list is opt in, because a generic SMTP relay has no
     * concept of a verified domain. Once an operator HAS declared one,
     * sending from outside it is the mistake the list exists to catch.
     */
    await connect({ verifiedDomains: ["other-company.com"] });
    const outcome = await email.queue(owner(), { to: TO, subject: "Hi", text: "Hi" });
    expect(outcome.queued).toBe(false);
    if (outcome.queued) throw new Error("unreachable");
    expect(outcome.reason).toBe("channel_not_registered");
  });
});

run("what gets queued", () => {
  it("lets a transactional email go with no consent row at all", async () => {
    /**
     * Implied by the work, exactly as an arrival text is. An invoice is not
     * a thing a customer has to opt in to receive.
     */
    await connect();
    const id = await queued();
    const [row] = await messageRow(id);
    expect(row!.status).toBe("queued");
    expect(row!.consent_id).toBeNull();
  });

  it("puts both unsubscribe headers on a marketing email", async () => {
    /**
     * The POST header is what makes the first one count. Without it Gmail
     * shows no unsubscribe control and the recipient's only way out is the
     * spam button, which is the outcome the header exists to avoid.
     */
    await connect();
    await grantMarketingConsent();
    const id = await queued({
      subject: "Spring offer", purpose: "marketing",
      unsubscribeUrl: "https://example.com/u/1",
    });
    const [row] = await messageRow(id);
    expect(row!.headers["List-Unsubscribe"]).toBe("<https://example.com/u/1>");
    expect(row!.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("records which consent row permitted a marketing send", async () => {
    /**
     * A marketing message whose consent_id is null is exactly what an audit
     * has to be able to find, so the column has to be filled when there IS a
     * row. It was null for every send while the id was dropped on the way
     * into the pure decision function.
     */
    await connect();
    await grantMarketingConsent();
    const id = await queued({
      subject: "Spring offer", purpose: "marketing",
      unsubscribeUrl: "https://example.com/u/1",
    });
    const [row] = await messageRow(id);
    expect(row!.consent_id).not.toBeNull();
  });

  it("stores Reply-To as a header and hands it to the provider as its own field", async () => {
    /**
     * Sending it in both places puts two Reply-To headers on the message,
     * which receivers resolve inconsistently.
     */
    await connect();
    const id = await queued({ replyTo: "dispatch@example-trades.com" });
    const [row] = await messageRow(id);
    expect(row!.headers["Reply-To"]).toBe("dispatch@example-trades.com");

    const provider = fakeProvider();
    await email.flush(db(), ORG, { provider });
    expect(provider.sent[0]!.replyTo).toBe("dispatch@example-trades.com");
    expect(provider.sent[0]!.headers?.["Reply-To"]).toBeUndefined();
    expect(id).toBeTruthy();
  });
});

run("handing the queue to a provider", () => {
  it("marks a message sent rather than delivered, and stores the provider id", async () => {
    /**
     * The provider has accepted it and nothing more is known. Claiming
     * delivery here would make the callback that arrives later either
     * redundant or contradictory, and for SMTP it would be a claim nothing
     * could ever confirm.
     */
    await connect();
    const id = await queued();
    const provider = fakeProvider();
    const outcomes = await email.flush(db(), ORG, { provider });

    expect(outcomes).toEqual([{ messageId: id, status: "sent" }]);
    const [row] = await messageRow(id);
    expect(row!.status).toBe("sent");
    expect(row!.provider_message_id).toBe("re_1");
  });

  it("sends oldest first", async () => {
    await connect();
    const first = await queued({ subject: "One" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await queued({ subject: "Two" });

    const provider = fakeProvider();
    const outcomes = await email.flush(db(), ORG, { provider });
    expect(outcomes.map((o) => o.messageId)).toEqual([first, second]);
  });

  it("requeues a retryable failure and leaves a permanent one failed", async () => {
    /**
     * A 451 greylisting is the normal first answer from a well configured
     * receiver to mail from a domain it has not seen. Treating it as
     * permanent means a self hoster's first email to every new customer
     * fails; treating a dead mailbox as retryable is how a queue stops being
     * a queue.
     */
    await connect();
    const soft = await queued({ subject: "Soft" });
    const hard = await queued({ subject: "Hard", to: "other@customer.test" });

    await email.flush(db(), ORG, {
      provider: fakeProvider({
        resultsInOrder: [
          { ok: false, code: "451", message: "greylisted", retryable: true },
          { ok: false, code: "550", message: "no such user", retryable: false },
        ],
      }),
    });

    expect((await messageRow(soft))[0]!.status).toBe("queued");
    expect((await messageRow(hard))[0]!.status).toBe("failed");
    expect((await messageRow(hard))[0]!.error_code).toBe("550");
  });

  it("does not send a message another worker claimed after the queue was read", async () => {
    /**
     * The window that matters. Both workers read the same queue, then race to
     * claim each row. The claim is a conditional update filtered on
     * `status = 'queued'`, so Postgres serializes them and exactly one sees a
     * returned row; the loser must skip rather than send.
     *
     * The race is made deterministic by claiming the second message from
     * "another worker" while this one is busy handing the first to a
     * provider, which is precisely when it happens in production.
     */
    await connect();
    const first = await queued({ subject: "One" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await queued({ subject: "Two" });

    const provider = fakeProvider({
      onSend: async () => {
        if (provider.sent.length === 1) await claimOne(db(), ORG, second);
      },
    });

    const outcomes = await email.flush(db(), ORG, { provider });
    expect(outcomes).toEqual([
      { messageId: first, status: "sent" },
      { messageId: second, status: "skipped", reason: "claimed_elsewhere" },
    ]);
    expect(provider.sent).toHaveLength(1);
  });

  it("never picks up a message that is already being sent", async () => {
    await connect();
    const id = await queued();
    expect(await claimOne(db(), ORG, id)).toBe(true);

    const provider = fakeProvider();
    expect(await email.flush(db(), ORG, { provider })).toEqual([]);
    expect(provider.sent).toHaveLength(0);
  });

  /**
   * `message` holds every channel, and has since the first migration. An
   * outbox that selects every queued outbound row without saying which
   * channel it wants drains the other one's queue: the carrier is handed an
   * email as the body of a text, or the mailer is handed a text with no
   * subject. Each direction is asserted on its own and each runs its own
   * outbox FIRST, because running the other one first empties the queue and
   * the test then passes whatever the select says.
   */
  async function bothQueued(): Promise<{ mail: string; text: string }> {
    await connect();
    const mail = await queued({ subject: "Invoice", text: "Attached." });

    const [conversation] = await raw<{ id: string }[]>`
      insert into public.conversation (organization_id, channel, external_address)
      values (${ORG}, 'sms', '+15125550142') returning id`;
    const [row] = await raw<{ id: string }[]>`
      insert into public.message
        (organization_id, conversation_id, direction, channel, purpose,
         from_address, to_address, body, status)
      values (${ORG}, ${conversation!.id}, 'outbound', 'sms', 'transactional',
              '+15125559997', '+15125550142', 'On my way', 'queued')
      returning id`;
    return { mail, text: row!.id };
  }

  it("the email outbox leaves a queued text where it is", async () => {
    const { mail, text } = await bothQueued();

    const mailer = fakeProvider();
    const mailed = await email.flush(db(), ORG, { provider: mailer });
    expect(mailed.map((o) => o.messageId)).toEqual([mail]);
    expect(mailer.sent.map((m) => m.subject)).toEqual(["Invoice"]);

    const [untouched] = await messageRow(text);
    expect(untouched!.status).toBe("queued");
  });

  it("the sms outbox leaves a queued email where it is", async () => {
    const { mail, text } = await bothQueued();

    const carrier = fakeCarrier();
    const carried = await smsFlush(db(), ORG, { provider: carrier });
    expect(carried.map((o) => o.messageId)).toEqual([text]);
    expect(carrier.sent).toEqual(["On my way"]);

    const [untouched] = await messageRow(mail);
    expect(untouched!.status).toBe("queued");
  });
});

run("what the provider says happened", () => {
  async function sent(to = TO): Promise<string> {
    const id = await queued({ to });
    await email.flush(db(), ORG, { provider: fakeProvider() });
    return id;
  }

  it("records a delivery and stamps when", async () => {
    await connect();
    const id = await sent();
    const outcome = await email.recordEvent(db(), ORG, {
      providerMessageId: "re_1", reference: id, type: "delivered",
    });
    expect(outcome.recorded).toBe(true);
    const [row] = await messageRow(id);
    expect(row!.status).toBe("delivered");
    expect(row!.delivered_at).not.toBeNull();
  });

  it("does not move a message backwards when callbacks arrive out of order", async () => {
    /**
     * A `sent` landing after a `delivered` must not regress, or a support
     * screen reads "sending" for mail that arrived an hour ago.
     */
    await connect();
    const id = await sent();
    await email.recordEvent(db(), ORG, {
      providerMessageId: "re_1", reference: id, type: "delivered",
    });
    const outcome = await email.recordEvent(db(), ORG, {
      providerMessageId: "re_1", reference: id, type: "sent",
    });
    expect(outcome).toEqual({ recorded: false, reason: "out_of_order" });
    expect((await messageRow(id))[0]!.status).toBe("delivered");
  });

  it("matches a callback on the provider's own id when our reference is missing", async () => {
    await connect();
    const id = await sent();
    const outcome = await email.recordEvent(db(), ORG, {
      providerMessageId: "re_1", type: "delivered",
    });
    expect(outcome.recorded).toBe(true);
    expect((await messageRow(id))[0]!.status).toBe("delivered");
  });

  it("suppresses on a hard bounce and then refuses the next send", async () => {
    await connect();
    const id = await sent();
    const outcome = await email.recordEvent(db(), ORG, {
      providerMessageId: "re_1", reference: id, type: "bounced", permanent: true,
    });
    expect(outcome).toMatchObject({ recorded: true, status: "undelivered", suppressed: true });

    const next = await email.queue(owner(), { to: TO, subject: "Again", text: "Again" });
    expect(next.queued).toBe(false);
    if (next.queued) throw new Error("unreachable");
    expect(next.reason).toBe("suppressed");
  });

  it("does not suppress on a soft bounce", async () => {
    /**
     * A full mailbox or a receiver having a bad afternoon is transient.
     * Suppressing on one takes a real customer off this company's email for
     * good over a condition nobody will ever think to look for.
     */
    await connect();
    const id = await sent();
    const outcome = await email.recordEvent(db(), ORG, {
      providerMessageId: "re_1", reference: id, type: "bounced", permanent: false,
    });
    expect(outcome).toMatchObject({ recorded: true, suppressed: false });
    expect(await email.listSuppressed(owner())).toHaveLength(0);
  });

  it("records a complaint without calling it a delivery failure", async () => {
    /**
     * The message ARRIVED. A human read enough of it to press a button.
     * Recording it as undelivered would overwrite the one true fact with a
     * false one, and hide the only signal that predicts a sending domain
     * being blocked.
     */
    await connect();
    const id = await sent();
    await email.recordEvent(db(), ORG, {
      providerMessageId: "re_1", reference: id, type: "delivered",
    });
    const outcome = await email.recordEvent(db(), ORG, {
      providerMessageId: "re_1", reference: id, type: "complained",
    });
    expect(outcome).toMatchObject({ recorded: true, suppressed: true });
    expect((await messageRow(id))[0]!.status).toBe("delivered");
  });

  it("stops marketing after a complaint and still sends the invoice", async () => {
    /**
     * Somebody who marks a promotion as spam has not said they do not want
     * their invoice, and a company that stops invoicing over a complaint has
     * a worse problem than a complaint.
     */
    await connect();
    await grantMarketingConsent();
    const id = await sent();
    await email.recordEvent(db(), ORG, {
      providerMessageId: "re_1", reference: id, type: "complained",
    });

    const promotion = await email.queue(owner(), {
      to: TO, subject: "Spring offer", text: "Book now",
      purpose: "marketing", unsubscribeUrl: "https://example.com/u/1",
    });
    expect(promotion.queued).toBe(false);

    const invoice = await email.queue(owner(), { to: TO, subject: "Invoice", text: "Attached." });
    expect(invoice.queued).toBe(true);
  });

  it("ignores a deferral rather than moving the message", async () => {
    await connect();
    const id = await sent();
    const outcome = await email.recordEvent(db(), ORG, {
      providerMessageId: "re_1", reference: id, type: "deferred",
    });
    expect(outcome).toEqual({ recorded: false, reason: "no_status_change" });
    expect((await messageRow(id))[0]!.status).toBe("sent");
  });

  it("says so when the callback names a message this company does not have", async () => {
    await connect();
    const outcome = await email.recordEvent(db(), ORG, {
      providerMessageId: "re_nobody", type: "delivered",
    });
    expect(outcome).toEqual({ recorded: false, reason: "unknown_message" });
  });
});

run("the webhook", () => {
  const request = { url: "https://example.com/hook", headers: {}, body: "{}" };

  it("rejects a request whose signature does not verify, and writes nothing", async () => {
    /**
     * A forged hard bounce writes a suppression. One unauthenticated POST and
     * a company can no longer email that customer at all, so verification
     * happens before parsing and long before anything is written.
     */
    await connect();
    const id = await queued();
    await email.flush(db(), ORG, { provider: fakeProvider() });

    const provider: EmailProvider = {
      name: "fake",
      delivery: {
        kind: "webhook",
        verify: () => false,
        parse: () => ({
          providerMessageId: "re_1", reference: id, type: "bounced", permanent: true,
        }),
      },
      send: async () => ({ ok: true, providerMessageId: "re_1" }),
    };

    const outcome = await email.receive(db(), {
      connectionId: "x", organizationId: ORG, provider,
    }, request);

    expect(outcome).toEqual({ kind: "rejected", reason: "bad_signature" });
    expect((await messageRow(id))[0]!.status).toBe("sent");
    expect(await email.listSuppressed(owner())).toHaveLength(0);
  });

  it("answers not_supported for a provider that reports nothing", async () => {
    /**
     * An operator who pointed something at this URL for an SMTP connection
     * has made a configuration mistake. "Bad signature" would send them
     * looking for a key that does not exist.
     */
    await connect();
    const outcome = await email.receive(db(), {
      connectionId: "x", organizationId: ORG, provider: fakeProvider({ reports: false }),
    }, request);
    expect(outcome).toEqual({ kind: "rejected", reason: "not_supported" });
  });

  it("does not resolve a token short enough to guess", async () => {
    /**
     * The floor is in the SQL rather than in TypeScript, so a deployment that
     * configures a weak token gets no webhooks rather than an endpoint
     * anybody can post to.
     */
    await connect({ webhookToken: "short" });
    expect(await email.resolveWebhook(db(), "short")).toBeNull();
  });
});

run("the do-not-email list", () => {
  it("refuses a suppression with no reason", async () => {
    /**
     * A suppression nobody can explain is a customer nobody can email and
     * nobody can decide about, a year later, when it matters.
     */
    await connect();
    await expect(email.suppressAddress(owner(), {
      address: TO, purpose: null, reason: "  ",
    })).rejects.toThrow(ConflictError);
  });

  it("is idempotent, so two bounce callbacks do not fight", async () => {
    await connect();
    const first = await email.suppressAddress(owner(), {
      address: TO, purpose: null, reason: "hard_bounce",
    });
    const second = await email.suppressAddress(owner(), {
      address: TO, purpose: null, reason: "hard_bounce",
    });
    expect(first.alreadySuppressed).toBe(false);
    expect(second.alreadySuppressed).toBe(true);
    expect(await email.listSuppressed(owner())).toHaveLength(1);
  });

  it("lets mail flow again once a suppression is lifted", async () => {
    await connect();
    await email.suppressAddress(owner(), { address: TO, purpose: null, reason: "asked to stop" });
    expect((await email.queue(owner(), { to: TO, subject: "Hi", text: "Hi" })).queued).toBe(false);

    const lifted = await email.liftSuppression(owner(), { address: TO });
    expect(lifted.lifted).toBe(1);
    expect((await email.queue(owner(), { to: TO, subject: "Hi", text: "Hi" })).queued).toBe(true);
  });
});

run("permissions", () => {
  it("refuses a role that cannot send", async () => {
    await connect();
    /**
     * An actor with no role and one named grant, which is the shape a
     * connected application has. It can read the log and cannot send, and the
     * guard is what makes that distinction real rather than a line in a
     * settings screen.
     */
    const reader: ServiceContext = {
      actor: { userId: USER, organizationId: ORG, roles: [], grants: ["message:read"] },
      db: db(),
    };
    await expect(email.queue(reader, { to: TO, subject: "Hi", text: "Hi" }))
      .rejects.toThrow(/message:send/);
    await expect(email.list(reader)).resolves.toEqual([]);
  });
});
