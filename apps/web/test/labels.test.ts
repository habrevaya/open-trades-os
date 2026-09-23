import { describe, it, expect } from "vitest";
import { schema } from "@opentradesos/db";
import {
  JOB_STATUS, VISIT_STATUS, INVOICE_STATUS, PRICE_BOOK_KIND, PHONE_PURPOSE,
  JOB_TONE, VISIT_TONE, INVOICE_TONE, label, tone, type Tone,
} from "../src/lib/labels";

/**
 * EVERY STATE HAS A WORD
 *
 * These maps translate schema enums into what an operator would say. A value
 * added to the schema and not added here renders as itself, so a dispatcher
 * sees `on_hold` in a column, which is a detail they did not ask for and
 * looks like a bug because it is one.
 *
 * Checked against the enum rather than against a list written here, because a
 * list written here is the thing that goes stale.
 */
const CASES: [string, Record<string, string>, readonly string[]][] = [
  ["job status", JOB_STATUS, schema.jobStatus.enumValues],
  ["visit status", VISIT_STATUS, schema.visitStatus.enumValues],
  ["invoice status", INVOICE_STATUS, schema.invoiceStatus.enumValues],
  ["price book kind", PRICE_BOOK_KIND, schema.itemKind.enumValues],
  ["phone number purpose", PHONE_PURPOSE, schema.phoneNumberPurpose.enumValues],
];

describe("display labels", () => {
  it.each(CASES)("covers every value the schema can hold: %s", (_name, map, values) => {
    const missing = values.filter((v) => !map[v]);
    expect(missing).toEqual([]);
  });

  it.each(CASES)("does not carry a value the schema dropped: %s", (_name, map, values) => {
    // A label left behind after an enum value is removed is dead code that
    // reads like coverage.
    const stale = Object.keys(map).filter((k) => !values.includes(k));
    expect(stale).toEqual([]);
  });

  /**
   * Same check for the colours, which had the same bug and a worse symptom:
   * a chip that falls through to grey does not look broken, it looks like a
   * design choice, so the jobs list rendered one colour for every state and
   * nobody would have questioned it.
   */
  const TONES: [string, Record<string, Tone>, readonly string[]][] = [
    ["job", JOB_TONE, schema.jobStatus.enumValues],
    ["visit", VISIT_TONE, schema.visitStatus.enumValues],
    ["invoice", INVOICE_TONE, schema.invoiceStatus.enumValues],
  ];

  it.each(TONES)("gives every %s status a deliberate tone", (_name, map, values) => {
    expect(values.filter((v) => !map[v])).toEqual([]);
    expect(Object.keys(map).filter((k) => !values.includes(k))).toEqual([]);
  });

  it("does not colour everything, which is the same as colouring nothing", () => {
    // A dispatcher scanning for what needs them cannot find it if every row
    // is shouting.
    const noisy = Object.values(JOB_TONE).filter((t) => t !== "neutral").length;
    expect(noisy).toBeLessThan(Object.keys(JOB_TONE).length);
  });

  it("falls back to a neutral tone for a status it does not know", () => {
    expect(tone(JOB_TONE, "something_new")).toBe("neutral");
  });

  it("falls back to the stored value rather than rendering blank", () => {
    // Ugly is recoverable. An empty cell where a status should be is not,
    // and it is what an unguarded lookup produces.
    expect(label(JOB_STATUS, "something_new")).toBe("something_new");
    expect(label(JOB_STATUS, "completed")).toBe("Completed");
  });
});
