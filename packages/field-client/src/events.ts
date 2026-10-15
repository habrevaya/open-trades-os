/**
 * SERVER-SENT EVENTS, READ AS THEY ARRIVE
 *
 * The field assistant answers as it writes in this format (the server's
 * src/http/stream.ts says what each event means). A phone reads the body in
 * pieces of whatever size the network hands over, which can end in the middle
 * of a line, so the reader keeps what it has not finished and hands back only
 * whole events. Comment lines, which keep a quiet stream open, are dropped.
 *
 * No dependency and no platform API, so the same reader runs in the phone
 * app, in a browser and under a test.
 */
export interface ServerEvent {
  event: string | null;
  data: string;
}

export class EventReader {
  private buffer = "";

  /** More of the body. Returns every event it finished. */
  feed(text: string): ServerEvent[] {
    this.buffer += text;
    const out: ServerEvent[] = [];
    for (let end = this.buffer.search(/\r?\n\r?\n/); end >= 0; end = this.buffer.search(/\r?\n\r?\n/)) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end).replace(/^\r?\n\r?\n/, "");
      const found = parse(block);
      if (found) out.push(found);
    }
    return out;
  }

  /** The body ended: an event it was in the middle of counts if it has data. */
  end(): ServerEvent[] {
    const found = parse(this.buffer);
    this.buffer = "";
    return found ? [found] : [];
  }
}

function parse(block: string): ServerEvent | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length > 0 ? { event, data: data.join("\n") } : null;
}
