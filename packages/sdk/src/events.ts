/**
 * READING SERVER-SENT EVENTS
 *
 * A route marked `x-streams` answers as Server-Sent Events when asked with
 * `Accept: text/event-stream` (docs/modules/m26, "Read an answer as it is
 * written"). This is the parser the client's `events()` reads them with,
 * written to the format's own rules rather than to what one server happens
 * to send today, so a server that later adds event ids or a retry hint is
 * read correctly by a client already in the field:
 *
 *   - a line is ended by CRLF, LF or CR, and may arrive split across chunks;
 *   - a line starting with a colon is a comment (the server's keep alive);
 *   - `data` lines are joined with newlines; `event` names the event;
 *   - `id` sets the last event id, which outlives the event it came with and
 *     is what a reconnect sends back as `Last-Event-ID`;
 *   - `retry` is the reconnection delay the server asks for, in milliseconds;
 *   - an event is sent on a blank line, and one with no data is not sent;
 *   - an event still unfinished when the stream ends is dropped, because a
 *     half received `answer` is not an answer.
 */

export interface RawEvent {
  /** The event's name, `message` when the server gave none. */
  event: string;
  data: string;
  /** The last event id as of this event, or null when the server has sent none. */
  id: string | null;
}

export class EventStreamParser {
  private buffer = "";
  private started = false;
  private event = "";
  private data: string[] = [];
  /** Kept across events and across `end`, so a reconnect can say where it was. */
  lastEventId: string | null = null;
  /** The reconnection delay the server last asked for, in milliseconds. */
  retry: number | null = null;

  constructor(lastEventId: string | null = null) {
    this.lastEventId = lastEventId;
  }

  /** Feed decoded text; get every event it completed. */
  feed(text: string): RawEvent[] {
    let chunk = text;
    if (!this.started && chunk.length > 0) {
      this.started = true;
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
    }
    this.buffer += chunk;
    const out: RawEvent[] = [];
    for (;;) {
      const match = /\r\n|\n|\r/.exec(this.buffer);
      if (!match) break;
      // A CR at the very end may be the first half of a CRLF still on its way.
      if (match[0] === "\r" && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const event = this.line(line);
      if (event) out.push(event);
    }
    return out;
  }

  /** The stream ended. Whatever was not finished by a blank line is dropped. */
  end(): void {
    this.buffer = "";
    this.event = "";
    this.data = [];
  }

  private line(line: string): RawEvent | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    else if (field === "id") {
      if (!value.includes("\0")) this.lastEventId = value === "" ? null : value;
    } else if (field === "retry") {
      if (/^\d+$/.test(value)) this.retry = Number(value);
    }
    return null;
  }

  private dispatch(): RawEvent | null {
    const event = this.event || "message";
    const data = this.data;
    this.event = "";
    this.data = [];
    if (data.length === 0) return null;
    return { event, data: data.join("\n"), id: this.lastEventId };
  }
}
