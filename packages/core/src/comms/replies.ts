/**
 * A REPLY, BY EMAIL OR WITH A PICTURE
 *
 * Two things a customer does that the inbox could not take. They reply to an
 * invoice email, and the reply went to whatever From address the email was
 * sent as: a mailbox nobody here reads, or one that bounces. And they text a
 * photograph of the leak, and the inbox showed a link to the carrier's copy
 * that only somebody logged into the carrier could open.
 *
 * Both are pure here: how a reply address carries the thread it belongs to,
 * how the quoted history under a reply is cut off, and what a picture must
 * be to be sent.
 */

/* ------------------------------------------------------- the reply address */

/**
 * A thread's token, in the local part of the address replies go to:
 * `reply+TOKEN@replies.example.com`.
 *
 * The plus form because every mail system that receives for a domain treats
 * the part after the plus as belonging to the same mailbox, so one receiving
 * address on the provider takes every thread's replies. The token is random
 * and long, because it is the only thing that says which customer's thread
 * an email lands in: an address that could be guessed is a way to post into
 * somebody else's conversation.
 */
export const REPLY_TOKEN = /^[A-Za-z0-9_-]{20,64}$/;

export function replyAddress(token: string, domain: string): string {
  if (!REPLY_TOKEN.test(token)) throw new Error("A reply token is 20 to 64 letters, digits, dashes or underscores.");
  return `reply+${token}@${domain.trim().toLowerCase()}`;
}

/**
 * Whether a domain can receive replies: a host name, nothing else.
 *
 * Checked when the operator types it, because a reply address on a domain
 * the provider does not receive for is worse than none: every reply bounces
 * back to the customer, who concludes the company ignores email.
 */
export function checkReplyDomain(domain: string): { ok: true; domain: string } | { ok: false; reason: string } {
  const value = domain.trim().toLowerCase();
  if (!/^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)) {
    return {
      ok: false,
      reason: `"${domain}" is not a domain. Use the receiving domain your email provider gave you, such as replies.yourcompany.com.`,
    };
  }
  return { ok: true, domain: value };
}

/** The bare address out of `Name <someone@example.com>`, lower cased. */
export function bareAddress(value: string): string {
  const angled = /<([^<>]+)>/.exec(value);
  return (angled ? angled[1]! : value).trim().toLowerCase();
}

/**
 * The thread token an incoming email was sent to, if any.
 *
 * Looked for in every recipient, because a reply often goes to more than one
 * address (reply all keeps the office on copy), and only on the reply domain
 * when one is given, so a customer who happens to write to
 * `reply+something@gmail.com` cannot claim a thread. Case is kept: the token
 * is case sensitive, and lower casing it would turn a valid one into
 * another.
 */
export function replyTokenIn(recipients: readonly string[], domain?: string | null): string | null {
  const wanted = domain?.trim().toLowerCase() || null;
  for (const recipient of recipients) {
    const angled = /<([^<>]+)>/.exec(recipient);
    const address = (angled ? angled[1]! : recipient).trim();
    const match = /^reply\+([^@]+)@(.+)$/i.exec(address);
    if (!match) continue;
    if (wanted && match[2]!.toLowerCase() !== wanted) continue;
    if (REPLY_TOKEN.test(match[1]!)) return match[1]!;
  }
  return null;
}

/* ----------------------------------------------------- the quoted history */

/**
 * Where the reply ends and the quoted email below it begins.
 *
 * Every mail client quotes the message being answered, and a thread that
 * shows each reply with the whole history under it is a thread where the new
 * sentence is somewhere in a screen of old ones. The cut is made at the
 * first line any common client writes above its quote ("On Tue, Smith
 * Heating wrote:", Outlook's "From:" block, "Original Message", a run of
 * lines starting with ">").
 *
 * Conservative on purpose. A reply whose first line is a quote marker is
 * kept whole, because cutting there would store nothing, and an empty
 * message reads as the customer having said nothing. The full text is kept
 * beside it either way.
 */
export function stripQuotedReply(text: string): { reply: string; quoted: boolean } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let cut = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    const next = (lines[i + 1] ?? "").trim();
    if (/^On\b.{0,200}\bwrote:$/i.test(line)) { cut = i; break; }
    /** Gmail wraps a long attribution line, so "wrote:" lands on the next one. */
    if (/^On\b.{0,200}$/i.test(line) && /^.{0,200}\bwrote:$/i.test(next) && line.length > 0) { cut = i; break; }
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(line)) { cut = i; break; }
    if (/^_{10,}$/.test(line) && /^From:/i.test(next)) { cut = i; break; }
    if (/^From:\s/i.test(line) && i > 0 && lines[i - 1]!.trim() === ""
      && lines.slice(i + 1, i + 5).some((l) => /^(Sent|Date):\s/i.test(l.trim()))) { cut = i; break; }
    if (line.startsWith(">") && lines.slice(i).every((l) => l.trim() === "" || l.trim().startsWith(">"))) {
      cut = i; break;
    }
  }

  if (cut === -1) return { reply: text.trim(), quoted: false };
  const reply = lines.slice(0, cut).join("\n").trim();
  if (reply === "") return { reply: text.trim(), quoted: false };
  return { reply, quoted: true };
}

/**
 * Readable text from an HTML email, for one that arrived with no plain part.
 *
 * Not a renderer and not a sanitiser: nothing here is ever put back into a
 * page as HTML. It is the words, with paragraphs and line breaks kept, so a
 * reply from a client that only sends HTML is still something a person can
 * read in the thread.
 */
export function textFromHtml(html: string): string {
  let out = "";
  let i = 0;
  const n = html.length;
  const lower = html.toLowerCase();
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    const next = html[lt + 1] ?? "";
    // A "<" that does not open a tag or a comment is just a less-than sign.
    if (!/[a-zA-Z/!?]/.test(next)) { out += "<"; i = lt + 1; continue; }
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    // A tag that never closes is dropped with everything after it, so no
    // half a tag survives into the text.
    if (gt === -1) break;
    const tag = /^<\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(html.slice(lt, gt + 1));
    const name = tag ? tag[1]!.toLowerCase() : "";
    const closing = html[lt + 1] === "/";
    i = gt + 1;
    if (!closing && (name === "script" || name === "style" || name === "head")) {
      // Everything up to the matching close goes with it; unclosed, the rest.
      const close = lower.indexOf(`</${name}`, i);
      if (close === -1) break;
      const closeEnd = html.indexOf(">", close);
      if (closeEnd === -1) break;
      i = closeEnd + 1;
      continue;
    }
    if (name === "br" || (closing && /^(p|div|li|tr|h[1-6]|blockquote)$/.test(name))) out += "\n";
  }
  const entities: Record<string, string> = {
    nbsp: " ", lt: "<", gt: ">", quot: "\"", "#39": "'", apos: "'", amp: "&",
  };
  return out
    .replace(/&(nbsp|lt|gt|quot|#39|apos|amp);/gi, (_m, name: string) => entities[name.toLowerCase()]!)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Whether an email was written by software rather than a person.
 *
 * An out of office reply to an invoice is not the customer writing back, and
 * a workflow that answers "when a customer writes in" by emailing them again
 * is how two autoresponders talk to each other all weekend. RFC 3834's
 * `Auto-Submitted` is the standard signal; the others are what the clients
 * that ignore the standard send instead.
 */
export function isAutomaticReply(headers: Readonly<Record<string, string>>): boolean {
  const get = (name: string) => {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
    return key ? String(headers[key]).trim().toLowerCase() : "";
  };
  const submitted = get("auto-submitted");
  if (submitted !== "" && submitted !== "no") return true;
  if (get("x-autoreply") !== "" || get("x-autorespond") !== "") return true;
  return ["auto_reply", "bulk", "junk", "list"].includes(get("precedence"));
}

/* ------------------------------------------------------------ pictures */

/**
 * What a carrier will carry as a picture message.
 *
 * Five megabytes in all, because that is the ceiling the US carriers put on
 * one picture message, and a send over it is accepted by the API and then
 * dropped by the carrier, so the customer receives nothing and the log says
 * sent. Three pictures, because a reply needs one photograph of the part and
 * an inbox that attaches twenty is a file transfer.
 */
export const MMS_MAX_BYTES = 5 * 1024 * 1024;
export const MMS_MAX_PICTURES = 3;
export const MMS_TYPES = ["image/jpeg", "image/png", "image/gif"] as const;

export function checkPictures(pictures: readonly { contentType: string; sizeBytes: number }[]):
  { ok: true } | { ok: false; reason: string } {
  if (pictures.length > MMS_MAX_PICTURES) {
    return { ok: false, reason: `Send up to ${MMS_MAX_PICTURES} pictures in one message.` };
  }
  for (const picture of pictures) {
    if (!(MMS_TYPES as readonly string[]).includes(picture.contentType)) {
      return {
        ok: false,
        reason: "Pictures go as JPEG, PNG or GIF. Phones send other kinds as a file the customer may not be able to open.",
      };
    }
  }
  const total = pictures.reduce((sum, picture) => sum + picture.sizeBytes, 0);
  if (total > MMS_MAX_BYTES) {
    return {
      ok: false,
      reason: "Those pictures are over 5 MB together, which is more than a carrier will deliver as a text. Send a smaller one.",
    };
  }
  return { ok: true };
}
