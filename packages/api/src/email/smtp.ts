import { createTransport } from "nodemailer";
import {
  registerEmailProvider,
  type EmailProvider, type OutboundEmail, type SendResult,
} from "./provider";

/**
 * GENERIC SMTP
 *
 * The adapter that makes the rest of the catalogue optional. Every operator
 * already has one of these: a Google Workspace or Microsoft 365 mailbox, the
 * relay their web host gives them, a Postfix box, or an account with a vendor
 * this product will never have an adapter for. Pasting a host, a port, a
 * username and a password is the whole setup, and it is the difference
 * between self hosting and self hosting with a mandatory vendor signup.
 *
 * WHY THIS ONE USES A LIBRARY when Twilio and Resend deliberately do not.
 *
 * The rule those two follow is "no SDK for four REST endpoints", and it is
 * about REST wrappers: a signed HTTP request is thirty readable lines and an
 * SDK is a large dependency with its own release cadence in front of them.
 *
 * SMTP is not four REST endpoints. It is a stateful wire protocol with a
 * multi step handshake, opportunistic TLS upgrade through STARTTLS, four
 * authentication mechanisms that servers advertise and negotiate, MIME
 * multipart construction, header folding, quoted printable and base64
 * transfer encoding, and dot stuffing in the DATA phase. Hand rolling it
 * would be a thousand lines whose failure mode is mail that a receiving
 * server accepts and then silently mangles, or worse, a TLS upgrade that is
 * skipped in a way nobody notices until credentials have been crossing the
 * internet in the clear for a year. nodemailer is the standard, has no
 * runtime dependencies, and is the right call here.
 *
 * WHAT THIS PROVIDER CANNOT DO, said once and said honestly: it has no idea
 * what happened to the mail. SMTP ends at the receiving server's 250 OK. A
 * bounce comes back hours later as a new email to the envelope sender, which
 * is a mailbox this process does not read, and a spam complaint goes to a
 * feedback loop this process is not subscribed to. So `delivery` is
 * `kind: "none"` and the reason travels with it.
 */

/** The parts of a mail we hand to a transport. Kept to what this adapter sets. */
export interface SmtpMailOptions {
  from: string;
  to: string;
  subject: string;
  text?: string | undefined;
  html?: string | undefined;
  replyTo?: string | undefined;
  headers?: Record<string, string> | undefined;
}

/** What a transport tells us back. Structurally what nodemailer returns. */
export interface SmtpSendInfo {
  messageId?: string | undefined;
  accepted?: unknown[] | undefined;
  rejected?: unknown[] | undefined;
  response?: string | undefined;
}

/**
 * The seam a test replaces.
 *
 * Structural rather than nodemailer's own `Transporter`, so a test can hand
 * in six lines instead of standing up a fake SMTP server, and so nothing
 * outside this file has to know the library exists.
 */
export interface SmtpTransport {
  sendMail(options: SmtpMailOptions): Promise<SmtpSendInfo>;
}

export type SmtpSecurity = "tls" | "starttls" | "none";

export interface SmtpSettings {
  host: string;
  port: number;
  username?: string;
  /**
   * `tls`      implicit TLS from the first byte, which is port 465.
   * `starttls` plain connection upgraded before AUTH, which is port 587 and
   *            what almost every provider wants.
   * `none`     no encryption at all. See the refusal below.
   */
  security?: SmtpSecurity;
  /**
   * The envelope sender, when it must differ from the From header.
   *
   * Bounces go to this address rather than to From, and some relays reject a
   * message whose envelope sender is not a mailbox they own. Left unset it is
   * the From address, which is right for nearly everyone.
   */
  envelopeFrom?: string;
  /**
   * Accept a certificate that does not verify.
   *
   * Off by default and named for what it actually is. An internal relay with
   * a self signed certificate is a real situation, and "smtp works now" is
   * what this gets turned on for, so the name has to make the trade visible
   * in the settings row rather than hiding behind `strict: false`.
   */
  allowUntrustedCertificate?: boolean;
  /**
   * Required to use `security: "none"` while a username is set. See below.
   */
  allowPlaintextAuth?: boolean;
  connectionTimeoutMs?: number;
}

/**
 * SMTP status codes, and what a 4 versus a 5 means.
 *
 * This is the one place the retry decision is genuinely well specified rather
 * than a guess at a vendor's error names: RFC 5321 says a 4yz reply is a
 * transient failure and the sender SHOULD try again, and a 5yz is permanent.
 * Greylisting, which most well configured receivers do, is a 451 on first
 * contact from an unknown sender and an acceptance minutes later. Treating it
 * as permanent means a self hoster's first email to every new domain fails.
 */
function retryableFor(error: { responseCode?: unknown; code?: unknown }): boolean {
  const status = typeof error.responseCode === "number" ? error.responseCode : undefined;
  if (status !== undefined) return status >= 400 && status < 500;

  const code = typeof error.code === "string" ? error.code : "";
  /**
   * No status code means the conversation never got far enough to have one:
   * DNS, a refused connection, a timeout, a TLS handshake. All transient
   * from our side.
   *
   * EAUTH is in here for the same reason the Twilio adapter treats an
   * authentication error as retryable: it is almost always a password that
   * was rotated or has not been pasted in yet, a human fixes it, and then the
   * queued mail goes. Marking it permanent throws away every message sent
   * during the minutes an operator is updating a credential.
   */
  return ["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ECONNRESET", "EAUTH"].includes(code);
}

/**
 * Build the transport, or refuse.
 *
 * The refusal is the point of this function. `security: "none"` with a
 * username configured sends the operator's mailbox password across the
 * network in the clear on every message, and SMTP AUTH LOGIN is base64, which
 * is not encryption and is frequently mistaken for it. An unencrypted relay
 * on localhost with no credentials is a legitimate setup and is allowed; an
 * unencrypted relay that is handed a password is not, unless the operator
 * says in writing that they meant it.
 */
export function transportFor(settings: SmtpSettings, password: string): SmtpTransport {
  const security = settings.security ?? "starttls";

  if (security === "none" && settings.username && !settings.allowPlaintextAuth) {
    throw new Error(
      "This SMTP connection has a username but no encryption, which would send the password "
      + "in the clear on every message. Use STARTTLS or implicit TLS, or set allowPlaintextAuth "
      + "if the relay is genuinely on a trusted network.",
    );
  }

  return createTransport({
    host: settings.host,
    port: settings.port,
    // `secure` is implicit TLS. STARTTLS is an upgrade on a plain connection,
    // so it is `secure: false` plus `requireTLS`, which is the part people get
    // wrong: without `requireTLS` a server that does not offer STARTTLS is
    // silently talked to in plaintext.
    secure: security === "tls",
    requireTLS: security === "starttls",
    ...(security === "none" ? { ignoreTLS: true } : {}),
    ...(settings.username ? { auth: { user: settings.username, pass: password } } : {}),
    ...(settings.allowUntrustedCertificate ? { tls: { rejectUnauthorized: false } } : {}),
    connectionTimeout: settings.connectionTimeoutMs ?? 20_000,
  }) as unknown as SmtpTransport;
}

/**
 * @param transport Injected by tests. A test that reaches a real SMTP server
 * is a test that fails when somebody runs the suite on a train, and one that
 * delivers mail to a stranger when somebody fat fingers a fixture.
 */
export function createSmtpProvider(
  settings: Record<string, unknown>,
  password: string,
  transport?: SmtpTransport,
): EmailProvider {
  const config = settings as unknown as SmtpSettings;

  /**
   * Built lazily, so constructing the provider never opens a socket and a
   * misconfiguration surfaces on the send that hit it rather than at
   * registry lookup time, where the caller has no message to fail.
   */
  let built: SmtpTransport | undefined = transport;
  const open = (): SmtpTransport => {
    built ??= transportFor(config, password);
    return built;
  };

  return {
    name: "smtp",

    delivery: {
      kind: "none",
      because:
        "SMTP tells us only that the receiving server accepted the message. A bounce comes back "
        + "hours later as a separate email to the envelope sender, and a spam complaint goes to a "
        + "feedback loop, neither of which this product reads. Delivery, bounce and complaint "
        + "columns stay empty for mail sent this way, and that is the protocol rather than a "
        + "setting to switch on.",
    },

    async send(message: OutboundEmail): Promise<SendResult> {
      try {
        const info = await open().sendMail({
          from: message.from,
          to: message.to,
          subject: message.subject,
          ...(message.text ? { text: message.text } : {}),
          ...(message.html ? { html: message.html } : {}),
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          ...(message.headers && Object.keys(message.headers).length > 0
            ? { headers: message.headers }
            : {}),
        });

        /**
         * A resolved promise is not the same as an accepted recipient.
         *
         * nodemailer resolves when at least one recipient was accepted, and
         * this adapter always sends to exactly one. So a non-empty `rejected`
         * here means the one recipient was refused, and reporting ok would
         * mark the message sent and stop anybody looking at it again.
         */
        if (Array.isArray(info.rejected) && info.rejected.length > 0) {
          return {
            ok: false,
            code: "recipient_rejected",
            message: info.response ?? "The server refused the recipient.",
            retryable: false,
          };
        }

        /**
         * No Message-ID is a failure rather than an inconvenience. It is the
         * only handle this adapter ever gets on the message, it is what an
         * operator quotes to their relay's support, and storing a message as
         * sent with nothing to identify it makes the send unauditable.
         */
        if (!info.messageId) {
          return {
            ok: false,
            code: "no_message_id",
            message: "The SMTP server accepted the message but returned no Message-ID.",
            retryable: true,
          };
        }

        return { ok: true, providerMessageId: info.messageId };
      } catch (error) {
        const err = (error ?? {}) as { responseCode?: unknown; code?: unknown; message?: unknown };
        return {
          ok: false,
          code: String(err.code ?? err.responseCode ?? "smtp_error"),
          message: String(err.message ?? "The SMTP server refused the message."),
          retryable: retryableFor(err),
        };
      }
    },
  };
}

registerEmailProvider("smtp", (settings, secret) => createSmtpProvider(settings, secret));
