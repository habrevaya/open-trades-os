import { adapterSettings } from "../secrets/endpoints";
import { timingSafeEqual } from "node:crypto";

/**
 * THE EMAIL PROVIDER SEAM
 *
 * Same shape and same reasoning as `../comms/provider.ts`, which is the point.
 * A contractor self hosting this must be able to point it at whatever already
 * sends their mail and must be able to leave, so the product knows about
 * "send this email" and nothing about Resend, Postmark or a Postfix box in a
 * cupboard.
 *
 * Two things are deliberately NOT the provider's business, for the same
 * reasons as on the SMS side.
 *
 * CONSENT is decided before a provider is chosen. Most email vendors keep a
 * suppression list of their own, and that is a courtesy rather than a
 * compliance position: it knows nothing about the box a customer ticked on a
 * form in 2024, and it does not follow an operator who changes vendor. The
 * decision lives in core, the suppression list lives in our database, and the
 * provider is told what to send rather than asked whether to.
 *
 * THREADING is decided by us. Mail clients thread on References and
 * In-Reply-To, which no provider populates on our behalf and which breaks the
 * moment a customer replies from a different address.
 *
 * WHERE THIS DIFFERS FROM THE SMS SEAM, and it is the interesting part:
 *
 * A carrier always tells you what happened to a text. An SMTP relay does not
 * and cannot: the protocol ends when the receiving server says 250 OK, and
 * everything after that (a mailbox full, a spam folder, a human clicking "this
 * is junk") happens somewhere this process will never hear about. So
 * `delivery` below is a required, discriminated field rather than an optional
 * method. A provider that cannot report has to say so in its own shape and
 * carry a sentence explaining it to the operator, because the alternative is
 * an adapter that returns `ok: true` and a screen that reads "delivered" for
 * a message that bounced an hour ago.
 */

export interface OutboundEmail {
  to: string;
  from: string;
  subject: string;
  /**
   * Both parts, and at least one of them. Sending HTML with no plain text
   * alternative is one of the strongest spam signals there is, so the service
   * refuses it rather than leaving it to each adapter to notice.
   */
  text?: string | undefined;
  html?: string | undefined;
  replyTo?: string | undefined;
  /**
   * Headers we are asking the provider to set, List-Unsubscribe above all.
   * Not a place for the provider's own API fields: an adapter that needs
   * something the interface lacks means the interface is wrong.
   */
  headers?: Record<string, string> | undefined;
  /**
   * Files that go with it: a delivered report's CSV. The bytes travel with
   * the message rather than as a link, because the person reading it may be an
   * accountant with no login to fetch a link with.
   */
  attachments?: EmailAttachment[] | undefined;
  /**
   * Our message id, handed to the provider so a delivery callback can be
   * matched back without a lookup table. Providers that cannot carry it are
   * matched on their own id instead, which is why both are stored.
   */
  reference: string;
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export type SendResult =
  | { ok: true; providerMessageId: string }
  /**
   * `retryable` is the whole reason this is not an exception, and email makes
   * the case harder than SMS does. SMTP says it out loud: a 4xx reply is
   * "come back later" and a 5xx is "never". Treating them the same means
   * either abandoning mail a greylisting receiver would have accepted on the
   * second attempt, which is most first contact with a well configured
   * server, or retrying a dead mailbox until the sending domain's reputation
   * is gone.
   */
  | { ok: false; code: string; message: string; retryable: boolean };

/**
 * What a provider tells us happened after the handoff.
 *
 * `sent` and `delivered` are different facts and both are kept. `sent` means
 * the provider accepted it, which is all that is known at the moment the API
 * call returns. `delivered` means a receiving server accepted it.
 *
 * `deferred` is a temporary failure at the receiving end, usually greylisting.
 * It is recorded as nothing at all, on purpose: the provider is still trying
 * and moving the message backwards would make a support screen show "sending"
 * for mail that arrives ten minutes later.
 *
 * `complained` is a spam report. It is NOT a delivery failure. The message
 * arrived, the human read enough of it to press a button, and treating it as
 * undelivered would hide the one signal that actually predicts a sending
 * domain being blocked.
 */
export type EmailEventType = "sent" | "delivered" | "deferred" | "bounced" | "complained";

export interface EmailEvent {
  providerMessageId: string;
  /** Our id, when the provider carried it back. */
  reference?: string | undefined;
  type: EmailEventType;
  /**
   * Whether a bounce is permanent. Meaningless on every other type.
   *
   * A hard bounce means the mailbox does not exist and never will, and it is
   * the thing that has to reach the suppression list: continuing to send to
   * an address that does not resolve is what a receiving provider measures
   * when it decides whether to accept the next message from this domain. A
   * soft bounce is a full mailbox or a server having a bad day.
   */
  permanent?: boolean | undefined;
  recipient?: string | undefined;
  code?: string | undefined;
  message?: string | undefined;
}

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  /** The raw body, exactly as received. Re-serializing breaks every signature. */
  body: string;
}

/**
 * Whether this provider can say what happened, and how.
 *
 * Required on every adapter, and discriminated, so a new adapter cannot be
 * written without answering the question. The honest `none` carries a
 * sentence rather than a boolean because the operator reading a settings
 * screen deserves to know WHY their delivery column is empty, and "delivery
 * reporting: off" beside a provider that has no such feature reads as
 * something they forgot to switch on.
 */
export type DeliveryFeedback =
  | {
      kind: "webhook";
      /**
       * Whether this request genuinely came from the provider.
       *
       * Not optional and not a settings toggle. An unverified endpoint lets
       * anyone on the internet forge a hard bounce for a customer's address,
       * and a forged hard bounce writes a suppression: one unauthenticated
       * POST and a company can no longer email that customer at all.
       */
      verify(request: WebhookRequest): boolean;
      parse(request: WebhookRequest): EmailEvent | null;
    }
  | {
      kind: "none";
      /** Shown to the operator. A full sentence, not a code. */
      because: string;
    };

export interface EmailProvider {
  readonly name: string;
  send(message: OutboundEmail): Promise<SendResult>;
  readonly delivery: DeliveryFeedback;
}

/**
 * Named `EmailProviderNotConfiguredError` rather than reusing the messaging
 * seam's `ProviderNotConfiguredError`. The two are exported from sibling
 * barrels that a single file routinely imports both of, and two classes with
 * one name means `instanceof` silently checks the wrong one.
 */
export class EmailProviderNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`No email provider configured for "${provider}"`);
    this.name = "EmailProviderNotConfiguredError";
  }
}

/**
 * Providers are registered rather than imported.
 *
 * A self hoster writing an adapter for whatever their host gives them should
 * not have to edit a switch statement in the middle of the send path, and a
 * build that imports every provider pulls every provider's dependencies into
 * a deployment that uses one. That last part is not hypothetical here: the
 * SMTP adapter drags nodemailer in, and a deployment sending through Resend
 * has no reason to load it.
 */
/**
 * Secrets beyond the main credential, already read from the secret store.
 *
 * A provider that needs a second secret (Resend's webhook signing secret is
 * a different credential from its API key) declares a `...Ref` setting naming
 * it, the service reads it through the same reader as `credentialRef`, and
 * the adapter gets the value here. The adapter never reads a secret out of
 * `settings`, because `settings` is a database column.
 */
export interface ProviderSecrets {
  webhookSecret?: string;
}

type EmailFactory = (
  settings: Record<string, unknown>, secret: string, secrets: ProviderSecrets,
) => EmailProvider;

const registry = new Map<string, EmailFactory>();

export function registerEmailProvider(name: string, factory: EmailFactory): void {
  registry.set(name, factory);
}

export function createEmailProvider(
  name: string,
  settings: Record<string, unknown>,
  secret: string,
  secrets: ProviderSecrets = {},
): EmailProvider {
  const factory = registry.get(name);
  if (!factory) throw new EmailProviderNotConfiguredError(name);
  // Never a stored endpoint override: see `adapterSettings`.
  return factory(adapterSettings(name, settings), secret, secrets);
}

export const registeredEmailProviders = (): string[] => [...registry.keys()];

/**
 * Constant time string comparison, for signatures.
 *
 * Duplicated from the Twilio adapter rather than shared, because the
 * alternative is `../comms/twilio` exporting it and this seam importing the
 * SMS seam's carrier adapter to send an email. Six lines is cheaper than that
 * dependency, and both copies are covered by their own tests.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // A length mismatch is not equal. `timingSafeEqual` throws on one, and a
  // thrown error escaping here would itself be a length oracle.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
