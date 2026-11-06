import { describe, it, expect } from "vitest";
import { eventStream, eventText, heldLength } from "../src/http/stream";

/**
 * M26. Every `writing` event carries how long the answer so far is, `answer`
 * carries `answer`, and a request sending `Last-Event-ID` is not sent what it
 * already has.
 */
describe("event ids and Last-Event-ID", () => {
  it("writes an id line before the data", () => {
    expect(eventText("writing", { text: "One." }, "4")).toBe('event: writing\nid: 4\ndata: {"text":"One."}\n\n');
  });

  it("gives each sentence the length of the answer so far, and the answer its own id", async () => {
    const response = await eventStream(async (show) => {
      show("One.");
      show("One. Two.");
      return { done: true };
    }, 201);
    expect(await response.text()).toBe(
      eventText("writing", { text: "One." }, "4") + eventText("writing", { text: "One. Two." }, "9") + eventText("answer", { done: true }, "answer"),
    );
  });

  it("does not send a resuming client what it already has", async () => {
    const response = await eventStream(async (show) => {
      show("One.");
      show("One. Two.");
      show("One. Two.");
      show("One. Two. Three.");
      return { done: true };
    }, 201, "9");
    expect(await response.text()).toBe(
      eventText("writing", { text: "One. Two. Three." }, "16") + eventText("answer", { done: true }, "answer"),
    );
  });

  it("reads only a length from Last-Event-ID, and anything else as nothing held", () => {
    expect(heldLength("23")).toBe(23);
    expect(heldLength(" 7 ")).toBe(7);
    expect(heldLength("answer")).toBe(-1);
    expect(heldLength("-3")).toBe(-1);
    expect(heldLength("99999999")).toBe(-1);
    expect(heldLength(null)).toBe(-1);
  });
});
