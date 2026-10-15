import { describe, it, expect } from "vitest";
import { eventStream, eventText, wantsEventStream } from "../src/http/stream";
import { ConflictError } from "../src/services/context";

/**
 * The event stream on its own, with no database: when it opens, what a
 * refusal becomes on each side of the first event, and the format itself.
 */
const request = (accept?: string) => new Request("http://localhost/api/v1/x", accept ? { headers: { accept } } : {});

describe("asking for events", () => {
  it("is Accept naming text/event-stream, among others or with parameters", () => {
    expect(wantsEventStream(request("text/event-stream"))).toBe(true);
    expect(wantsEventStream(request("application/json, text/event-stream;q=0.9"))).toBe(true);
    expect(wantsEventStream(request("application/json"))).toBe(false);
    expect(wantsEventStream(request("*/*"))).toBe(false);
    expect(wantsEventStream(request())).toBe(false);
  });
});

describe("the stream", () => {
  it("writes each line of the data on a data line of its own", () => {
    expect(eventText("writing", { text: "One.\nTwo." })).toBe('event: writing\ndata: {"text":"One.\\nTwo."}\n\n');
  });

  it("answers a refusal before anything was shown with the route's own status and body", async () => {
    const response = await eventStream(async () => { throw new ConflictError("The field assistant is off."); }, 201);
    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "The field assistant is off.", status: 409 });
  });

  it("sends a refusal after the first sentence as a problem event", async () => {
    const response = await eventStream(async (show) => {
      show("First.");
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new ConflictError("The model could not be reached.");
    }, 201);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe(
      eventText("writing", { text: "First." }) + eventText("problem", { error: "The model could not be reached.", status: 409 }),
    );
  });

  it("never echoes an error it does not recognise", async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      const response = await eventStream(async (show) => {
        show("First.");
        throw new Error("relation \"secret_table\" does not exist");
      }, 201);
      const text = await response.text();
      expect(text).toContain('"error":"Internal error","status":500');
      expect(text).not.toContain("secret_table");
    } finally {
      console.error = quiet;
    }
  });

  it("sends only the answer when it came before any sentence", async () => {
    const response = await eventStream(async () => ({ answered: true, text: "Yes." }), 201);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toBe(eventText("answer", { answered: true, text: "Yes." }));
  });
});
