import { describe, it, expect } from "vitest";
import {
  FieldApi, ApiError, EventReader, OfflineError, SignedOutError, type StreamingXhr,
} from "../src/index";

/**
 * THE FIELD ASSISTANT'S ANSWER, READ AS IT ARRIVES ON THE PHONE
 *
 * With `XMLHttpRequest` played by a fake that hands the body over in pieces,
 * the way React Native's does on both platforms: `responseText` grows and
 * `onprogress` fires. The pieces are cut wherever the test likes, including in
 * the middle of an event, because a network does that.
 */

class FakeXhr implements StreamingXhr {
  readyState = 0;
  status = 0;
  responseText = "";
  headers: Record<string, string> = {};
  method = "";
  url = "";
  body: string | null = null;
  aborted = false;
  private type = "";
  onreadystatechange: (() => void) | null = null;
  onprogress: (() => void) | null = null;
  onerror: (() => void) | null = null;

  open(method: string, url: string) { this.method = method; this.url = url; this.readyState = 1; }
  setRequestHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; }
  getResponseHeader(name: string) { return name.toLowerCase() === "content-type" ? this.type : null; }
  send(body?: string | null) { this.body = body ?? null; }
  abort() { this.aborted = true; }

  /** The status line and headers have arrived. */
  answer(status: number, type: string) {
    this.status = status;
    this.type = type;
    this.readyState = 2;
    this.onreadystatechange?.();
  }
  /** More of the body. */
  more(text: string) {
    this.responseText += text;
    this.readyState = 3;
    this.onreadystatechange?.();
    this.onprogress?.();
  }
  end() { this.readyState = 4; this.onreadystatechange?.(); }
  drop() { this.readyState = 4; this.status = 0; this.onerror?.(); this.onreadystatechange?.(); }
}

const event = (name: string, value: unknown) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
const ANSWER = { answered: true, text: "Shut off the gas. Drain it.", sources: [{ kind: "procedure", title: "Flushing" }] };

function api(xhr?: FakeXhr | null, fetcher?: typeof fetch) {
  return new FieldApi({
    serverUrl: "https://ops.example.com", token: "otd_token",
    ...(xhr === null ? { xhr: undefined } : { xhr: () => xhr ?? new FakeXhr() }),
    ...(fetcher ? { fetch: fetcher } : {}),
  });
}

describe("reading events", () => {
  it("hands back only whole events, however the body is cut, and drops comments", () => {
    const reader = new EventReader();
    expect(reader.feed("event: writ")).toEqual([]);
    expect(reader.feed('ing\ndata: {"text":"One."}\n')).toEqual([]);
    expect(reader.feed("\n: still writing\n\nevent: answer\ndata: {}\r\n\r\n")).toEqual([
      { event: "writing", data: '{"text":"One."}' },
      { event: "answer", data: "{}" },
    ]);
    expect(reader.feed("event: answer\ndata: {\"a\":1}")).toEqual([]);
    expect(reader.end()).toEqual([{ event: "answer", data: '{"a":1}' }]);
  });
});

describe("the assistant on the phone, as it writes", () => {
  it("asks the route for events with the phone's token and key, shows each piece, and settles with the whole answer", async () => {
    const x = new FakeXhr();
    const shown: string[] = [];
    const asking = api(x).askAssistantAsItWrites("How do we flush it?", "visit-1", "key-1", (text) => shown.push(text));
    expect(x.method).toBe("POST");
    expect(x.url).toBe("https://ops.example.com/api/v1/ai/field-assistant");
    expect(x.headers).toMatchObject({
      accept: "text/event-stream", authorization: "Bearer otd_token", "idempotency-key": "key-1",
    });
    expect(JSON.parse(x.body!)).toEqual({ question: "How do we flush it?", visitId: "visit-1" });

    x.answer(201, "text/event-stream; charset=utf-8");
    x.more(event("writing", { text: "Shut off the gas." }).slice(0, 20));
    expect(shown).toEqual([]);
    x.more(event("writing", { text: "Shut off the gas." }).slice(20));
    expect(shown).toEqual(["Shut off the gas."]);
    x.more(": still writing\n\n");
    x.more(event("answer", ANSWER));
    x.end();
    await expect(asking).resolves.toEqual(ANSWER);
    expect(shown).toEqual(["Shut off the gas."]);
  });

  it("reads a server that answers whole as the whole answer", async () => {
    const x = new FakeXhr();
    const shown: string[] = [];
    const asking = api(x).askAssistantAsItWrites("How do we flush it?", null, "key-2", (text) => shown.push(text));
    expect(JSON.parse(x.body!)).toEqual({ question: "How do we flush it?" });
    x.answer(201, "application/json");
    x.more(JSON.stringify(ANSWER).slice(0, 10));
    x.more(JSON.stringify(ANSWER).slice(10));
    x.end();
    await expect(asking).resolves.toEqual(ANSWER);
    expect(shown).toEqual([]);
  });

  it("gives the server's own words for a refusal before the stream, and an ended sign in as signed out", async () => {
    const x = new FakeXhr();
    const off = api(x).askAssistantAsItWrites("How?", null, "key-3", () => {});
    x.answer(409, "application/json");
    x.more(JSON.stringify({ error: "The field assistant is off.", status: 409 }));
    x.end();
    await expect(off).rejects.toEqual(new ApiError("The field assistant is off.", 409));

    const y = new FakeXhr();
    const ended = api(y).askAssistantAsItWrites("How?", null, "key-4", () => {});
    y.answer(401, "application/json");
    y.more(JSON.stringify({ error: "Not signed in", status: 401 }));
    y.end();
    await expect(ended).rejects.toBeInstanceOf(SignedOutError);
  });

  it("gives a refusal sent after the first sentence as the same error", async () => {
    const x = new FakeXhr();
    const shown: string[] = [];
    const asking = api(x).askAssistantAsItWrites("How?", null, "key-5", (text) => shown.push(text));
    x.answer(201, "text/event-stream");
    x.more(event("writing", { text: "First." }) + event("problem", { error: "The model could not be reached.", status: 409 }));
    await expect(asking).rejects.toEqual(new ApiError("The model could not be reached.", 409));
    expect(shown).toEqual(["First."]);
  });

  it("is no signal when the connection goes, before the answer or before anything", async () => {
    const x = new FakeXhr();
    const midway = api(x).askAssistantAsItWrites("How?", null, "key-6", () => {});
    x.answer(201, "text/event-stream");
    x.more(event("writing", { text: "First." }));
    x.end();
    await expect(midway).rejects.toBeInstanceOf(OfflineError);

    const y = new FakeXhr();
    const never = api(y).askAssistantAsItWrites("How?", null, "key-7", () => {});
    y.drop();
    await expect(never).rejects.toBeInstanceOf(OfflineError);
  });

  it("gives up when the server goes quiet for longer than a request may take", async () => {
    const x = new FakeXhr();
    const quiet = new FieldApi({ serverUrl: "https://ops.example.com", token: "otd_token", xhr: () => x, timeoutMs: 20 })
      .askAssistantAsItWrites("How?", null, "key-8", () => {});
    x.answer(201, "text/event-stream");
    await expect(quiet).rejects.toBeInstanceOf(OfflineError);
    expect(x.aborted).toBe(true);
  });

  it("asks for the answer whole where the platform has no XMLHttpRequest", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(ANSWER), { status: 201, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const shown: string[] = [];
    const answer = await api(null, fetcher).askAssistantAsItWrites("How?", null, "key-9", (text) => shown.push(text));
    expect(answer).toEqual(ANSWER);
    expect(shown).toEqual([]);
    expect((calls[0]!.init.headers as Record<string, string>)["idempotency-key"]).toBe("key-9");
  });
});
