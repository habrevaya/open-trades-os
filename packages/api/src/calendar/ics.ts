/**
 * RFC 5545, AND THE FIVE THINGS THAT MAKE A CALENDAR FEED WRONG
 *
 * A feed is a formatter over data we already hold, which makes it sound like
 * a string template. It is not, and the reason is that every way of getting
 * it wrong produces a file that parses: the technician's calendar fills up,
 * nothing errors, and the day shown is not the day they are working.
 *
 * The five, each of which has its own guard below and its own test:
 *
 *   1. LINE FOLDING AT 75 OCTETS. A content line longer than that is folded
 *      with CRLF plus one space. Octets, not characters: splitting a
 *      multi-byte character in half produces mojibake in the middle of a
 *      customer's street name, and some parsers abandon the property.
 *
 *   2. ESCAPING IN TEXT VALUES. A comma, a semicolon or a backslash inside
 *      a SUMMARY or a LOCATION is structural unless it is escaped.
 *      "Austin, TX" unescaped turns one LOCATION into a list, and a
 *      description with a raw newline in it ends the property and leaves the
 *      rest of the sentence being read as a new one.
 *
 *   3. A STABLE UID PER VISIT. The UID is the only thing a client uses to
 *      decide whether this is the event it already has. A UID that includes
 *      anything that can change between two fetches, a timestamp, a counter,
 *      the deployment's hostname, means every refresh is a NEW event and the
 *      technician has four copies of Tuesday by Thursday. This is the one
 *      that is worse than having no feed at all.
 *
 *   4. DTSTAMP AND SEQUENCE. Together they answer "which version of this
 *      event is newer". DTSTAMP here is the moment the underlying records
 *      last changed rather than the moment of the fetch, because a DTSTAMP
 *      that moves on every poll says the event changed every hour when it
 *      did not, and some clients re-alert on that. SEQUENCE is derived from
 *      the same instant, so it only ever goes up, which is what the
 *      specification requires of it.
 *
 *   5. TIME ZONES. Every DTSTART and DTEND is written in UTC with the Z
 *      suffix. The classic failure is emitting a local wall time with no
 *      zone attached, which a client reads as floating and shows in
 *      whatever zone the phone happens to be in: a two o'clock visit in
 *      Austin displayed at seven in the morning. UTC is used rather than
 *      TZID plus an embedded VTIMEZONE because it is unambiguous without
 *      shipping a timezone database, and because the instant is what we
 *      actually know.
 *
 * Nothing in this file touches a database or knows what a visit is. That is
 * deliberate: the framing is the part that is hard to get right and easy to
 * test, so it is tested without a database.
 */

/** RFC 5545 section 3.1: a content line is at most 75 octets before the break. */
export const MAX_OCTETS = 75;

/**
 * The zero point for SEQUENCE.
 *
 * SEQUENCE is a non-negative integer and clients compare it numerically, so
 * it has to be monotonic in the record's own last-changed time. Seconds since
 * the Unix epoch would do that and would also cross the signed 32-bit ceiling
 * in 2038, which is inside the working life of a scheduling system; several
 * clients store it in a 32-bit column. Counting from 2020 instead leaves room
 * until well past 2080 and costs one subtraction.
 */
const SEQUENCE_EPOCH_MS = Date.UTC(2020, 0, 1);

/**
 * What a client must be told about one visit.
 *
 * `lastModified` is the newest change to anything that appears in the event,
 * not only to the visit row: moving the visit, renaming the job and
 * correcting the address all change what the technician's phone should show,
 * and a client that is only told about the first of those keeps showing the
 * old street.
 */
export interface CalendarEvent {
  /** Stable for the life of the visit. See point 3 above. */
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  location?: string | null | undefined;
  description?: string | null | undefined;
  url?: string | null | undefined;
  status: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
  lastModified: Date;
  created?: Date | null | undefined;
}

export interface CalendarDocument {
  /** What the calendar is called once it is subscribed to. */
  name: string;
  /**
   * The company's own zone, carried as a display hint only. Every instant in
   * this document is in UTC, so a client that ignores this shows the same
   * minute as one that honours it.
   */
  timezone: string;
  /** How often a client is asked to come back, in minutes. */
  refreshMinutes: number;
  events: readonly CalendarEvent[];
}

/**
 * Escape a TEXT value.
 *
 * The backslash goes first and it has to: escaping the comma before the
 * backslash would then escape the backslash that was just inserted and
 * produce `\\,` where `\,` was meant, which a parser reads as a literal
 * backslash followed by a value separator.
 *
 * A colon is deliberately NOT escaped. It is structural in a parameter value
 * and ordinary inside TEXT, and escaping it produces a visible backslash in
 * front of every time of day a description mentions.
 */
export function escapeText(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");

  /**
   * Everything left below a space, apart from a tab, plus DEL.
   *
   * RFC 5545 allows a tab inside a TEXT value and nothing else in the C0
   * range, and there is no escape sequence for any of the rest: a vertical
   * tab or a form feed arriving in a pasted address is dropped rather than
   * passed through, because a parser meeting one is entitled to abandon the
   * property and take the rest of the event with it. The newlines are
   * already gone by here, turned into their escape above.
   *
   * Done by code point rather than with a regular expression containing
   * literal control characters, because such a regex is unreadable, easy to
   * get subtly wrong, and nothing else in this codebase writes one.
   */
  return Array.from(escaped, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 0x20 && code !== 0x09) || code === 0x7f ? "" : character;
  }).join("");
}

/**
 * Fold one content line to 75 octets.
 *
 * The continuation limit is 74 rather than 75 because the leading space is
 * part of the folded line and counts against it. Getting that off by one
 * wrong produces 76-octet lines, which most parsers accept, which is exactly
 * why it survives until the one that does not.
 */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= MAX_OCTETS) return line;

  const pieces: string[] = [];
  let offset = 0;
  let limit = MAX_OCTETS;

  while (offset < bytes.length) {
    let take = Math.min(limit, bytes.length - offset);

    /**
     * Back off the split point while it would land inside a UTF-8 sequence.
     * A continuation octet is 10xxxxxx; the first octet of a character never
     * is. Splitting between two continuation octets puts half a character at
     * the end of one line and half at the start of the next, and the two
     * halves are not rejoined by unfolding into anything legible.
     */
    if (offset + take < bytes.length) {
      while (take > 0 && (bytes[offset + take]! & 0xc0) === 0x80) take -= 1;
    }

    /**
     * Only reachable if a single character needed more octets than the line
     * allows, which cannot happen for UTF-8 at this limit. Taking the full
     * slice rather than looping forever is the safe way to be wrong.
     */
    if (take <= 0) take = Math.min(limit, bytes.length - offset);

    pieces.push(bytes.subarray(offset, offset + take).toString("utf8"));
    offset += take;
    limit = MAX_OCTETS - 1;
  }

  return pieces.join("\r\n ");
}

/** `20260401T140000Z`. The only form in this file, for the reason in point 5. */
export function utcStamp(at: Date): string {
  return `${at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`;
}

/**
 * SEQUENCE from the moment the record last changed.
 *
 * Derived rather than stored, because a stored counter has to be incremented
 * by every path that can change what the event says, and the one path that
 * forgets is the one where the technician's phone keeps the old address.
 * Anything before the epoch clamps to zero rather than going negative, which
 * a client would reject outright.
 */
export function sequenceFor(lastModified: Date): number {
  return Math.max(0, Math.floor((lastModified.getTime() - SEQUENCE_EPOCH_MS) / 1000));
}

/** One property, with its value escaped and the whole line folded. */
function textProperty(name: string, value: string): string {
  return foldLine(`${name}:${escapeText(value)}`);
}

/**
 * The whole document.
 *
 * Throws on a duplicate UID rather than emitting one, because two VEVENTs
 * sharing a UID in one PUBLISH document is the single defect this file most
 * exists to prevent and it is always a bug on our side rather than bad data:
 * a client meeting it either shows the event twice or picks one arbitrarily,
 * and neither is recoverable by the person looking at their phone.
 */
export function renderCalendar(document: CalendarDocument): string {
  const seen = new Set<string>();
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    /**
     * PRODID is required and is a constant. It is not built from the
     * deployment's hostname, for the same reason the UID is not: anything
     * here that differs between two deployments of the same product is a
     * difference somebody will eventually have to migrate across.
     */
    "PRODID:-//OpenTradesOS//Visit feed//EN",
    "CALSCALE:GREGORIAN",
    /**
     * PUBLISH, not REQUEST. This is a read-only feed somebody subscribed to,
     * not an invitation: a REQUEST would make some clients offer accept and
     * decline buttons that send email to an ORGANIZER that does not exist.
     */
    "METHOD:PUBLISH",
    textProperty("X-WR-CALNAME", document.name),
    /**
     * A display hint for the clients that read it, and nothing more. Every
     * instant below carries Z, so this cannot move an event by an hour the
     * way it can in a feed that emits floating times.
     */
    textProperty("X-WR-TIMEZONE", document.timezone),
    `REFRESH-INTERVAL;VALUE=DURATION:PT${document.refreshMinutes}M`,
    /** The same interval under the name older clients look for. */
    `X-PUBLISHED-TTL:PT${document.refreshMinutes}M`,
  ];

  for (const event of document.events) {
    if (seen.has(event.uid)) {
      throw new Error(
        `Two events in one calendar carry the UID "${event.uid}". A client would `
        + "show the visit twice or pick one of them arbitrarily, and the person "
        + "holding the phone has no way to tell which.",
      );
    }
    seen.add(event.uid);

    /**
     * An end on or before the start is bad data rather than a reason to
     * refuse the whole feed. A zero length or inverted event is dropped by
     * some clients and drawn as a point by others, so it is clamped to one
     * minute and still shown: the technician losing a visit off their day is
     * a worse outcome than a visit whose length is visibly wrong.
     */
    const end = event.end.getTime() > event.start.getTime()
      ? event.end
      : new Date(event.start.getTime() + 60_000);

    lines.push(
      "BEGIN:VEVENT",
      textProperty("UID", event.uid),
      `DTSTAMP:${utcStamp(event.lastModified)}`,
      `DTSTART:${utcStamp(event.start)}`,
      `DTEND:${utcStamp(end)}`,
      `SEQUENCE:${sequenceFor(event.lastModified)}`,
      `LAST-MODIFIED:${utcStamp(event.lastModified)}`,
      `STATUS:${event.status}`,
      /**
       * PRIVATE, on every event. It is advisory and most clients honour it
       * when a calendar is shared on: this feed carries somebody's home
       * address, and the default when it is forwarded should be that the
       * details do not travel with it.
       */
      "CLASS:PRIVATE",
      /**
       * TRANSPARENT would leave the technician's day showing as free, which
       * is the opposite of what a dispatch calendar is for.
       */
      "TRANSP:OPAQUE",
      textProperty("SUMMARY", event.summary),
    );

    if (event.created) lines.push(`CREATED:${utcStamp(event.created)}`);
    if (event.location) lines.push(textProperty("LOCATION", event.location));
    if (event.description) lines.push(textProperty("DESCRIPTION", event.description));
    /**
     * URL is a URI property rather than TEXT, so it is NOT escaped: a
     * backslash in front of the query string's commas is a link that does
     * not open. It is still folded, because the length rule is about the
     * line rather than about the value.
     */
    if (event.url) lines.push(foldLine(`URL:${event.url}`));

    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  /**
   * CRLF between every line and after the last one. A file ending without
   * the final break is accepted by most parsers and rejected by enough of
   * them to matter, and the rule in the specification is unambiguous.
   */
  return `${lines.join("\r\n")}\r\n`;
}
