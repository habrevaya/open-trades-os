import { describe, it, expect } from "vitest";
import {
  checkForm, checkSubmission, checkPage, shownPages, hiddenFieldKeys,
  type FormDefinition, type FormField, type ShowRule,
} from "../src/marketing/index.js";

/**
 * M19. A PAGE OR A QUESTION SHOWN OR HIDDEN BY A RULE OVER SEVERAL ANSWERS
 *
 * A rule names earlier questions and compares their answers: equals, one
 * of, more or less than a number, typed words it holds. All of them, or any
 * one. A page or question the answers do not lead to is not asked: never
 * required, and whatever was sent for it is dropped.
 */

const field = (key: string, type: FormField["type"], extra: Partial<FormField> = {}): FormField =>
  ({ key, label: key[0]!.toUpperCase() + key.slice(1), type, required: false, ...extra });

const SYSTEMS = [{ value: "boiler", label: "Boiler" }, { value: "furnace", label: "Furnace" }, { value: "ac", label: "Air conditioning" }];
const ROOMS = [{ value: "attic", label: "Attic" }, { value: "basement", label: "Basement" }, { value: "garage", label: "Garage" }];

const oldBoiler: ShowRule = {
  action: "show", match: "all",
  conditions: [{ field: "system", op: "equals", value: "boiler" }, { field: "age", op: "greater_than", value: 15 }],
};

const form: FormDefinition = {
  key: "rules",
  title: "What is wrong",
  pages: [
    { title: "About you" },
    { title: "The system" },
    { title: "An old boiler", rule: oldBoiler },
  ],
  fields: [
    field("phone", "phone", { required: true, page: 0 }),
    field("system", "choice", { required: true, page: 1, options: SYSTEMS }),
    field("age", "number", { required: true, page: 1 }),
    field("rooms", "multi_choice", { page: 1, options: ROOMS }),
    field("problem", "long_text", { page: 1 }),
    /** Asked when the problem mentions a smell, or the work is in the basement. */
    field("gas", "choice", {
      required: true, page: 1, options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
      rule: { action: "show", match: "any", conditions: [
        { field: "problem", op: "contains", value: "Smell" },
        { field: "rooms", op: "one_of", values: ["basement"] },
      ] },
    }),
    /** Hidden for a new system. */
    field("serial", "text", { required: true, page: 1, rule: { action: "hide", match: "all", conditions: [{ field: "age", op: "less_than", value: 2 }] } }),
    field("flue", "text", { required: true, page: 2 }),
  ],
};

describe("a rule over several answers", () => {
  it("is a coherent form", () => {
    expect(checkForm(form)).toMatchObject({ ok: true });
  });

  it("shows a page only when all of its conditions hold", () => {
    expect(shownPages(form, { system: "boiler", age: 20 })).toEqual([true, true, true]);
    expect(shownPages(form, { system: "boiler", age: "20" })).toEqual([true, true, true]);
    expect(shownPages(form, { system: "boiler", age: 15 })).toEqual([true, true, false]);
    expect(shownPages(form, { system: "furnace", age: 20 })).toEqual([true, true, false]);
    expect(shownPages(form, {})).toEqual([true, true, false]);
  });

  it("shows a question when any one condition holds, by typed words or a ticked option", () => {
    expect(hiddenFieldKeys(form, { problem: "There is a SMELL of gas" }).has("gas")).toBe(false);
    expect(hiddenFieldKeys(form, { rooms: ["attic", "basement"] }).has("gas")).toBe(false);
    expect(hiddenFieldKeys(form, { problem: "It is noisy", rooms: ["attic"] }).has("gas")).toBe(true);
  });

  it("hides a question when its rule holds, and shows it while the answer it waits for is missing", () => {
    expect(hiddenFieldKeys(form, { age: 1 }).has("serial")).toBe(true);
    expect(hiddenFieldKeys(form, { age: 5 }).has("serial")).toBe(false);
    expect(hiddenFieldKeys(form, {}).has("serial")).toBe(false);
  });

  it("never requires a hidden question, and drops what was sent for it", () => {
    const sent = checkSubmission(form, { values: {
      phone: "5125550134", system: "furnace", age: 1, problem: "noisy", gas: "yes", serial: "X1", flue: "steel",
    } });
    expect(sent.ok).toBe(true);
    if (sent.ok) {
      expect(sent.values).not.toHaveProperty("gas");
      expect(sent.values).not.toHaveProperty("serial");
      expect(sent.values).not.toHaveProperty("flue");
    }
    const missing = checkSubmission(form, { values: { phone: "5125550134", system: "boiler", age: 20, problem: "a smell" } });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.refusals.map((r) => r.field).sort()).toEqual(["flue", "gas", "serial"]);
  });

  it("checks a page without the questions its answers hide", () => {
    expect(checkPage(form, 1, { system: "ac", age: 1 }).map((r) => r.field)).toEqual([]);
    expect(checkPage(form, 1, { system: "ac", age: 3 }).map((r) => r.field)).toEqual(["serial"]);
  });

  it("does not let an answer on a skipped page open anything", () => {
    const chained: FormDefinition = {
      ...form,
      fields: [...form.fields, field("chimney", "text", { page: 2, rule: { action: "show", match: "all", conditions: [{ field: "flue", op: "equals", value: "brick" }] } })],
    };
    expect(hiddenFieldKeys(chained, { system: "furnace", age: 20, flue: "brick" }).has("chimney")).toBe(true);
    expect(hiddenFieldKeys(chained, { system: "boiler", age: 20, flue: "Brick " }).has("chimney")).toBe(false);
  });

  it("refuses a rule it could not keep, in words", () => {
    const problems = (patch: Partial<FormDefinition>) => {
      const verdict = checkForm({ ...form, ...patch });
      return verdict.ok ? [] : verdict.problems;
    };
    const rulePage = (rule: ShowRule) => ({ pages: [form.pages![0]!, form.pages![1]!, { title: "An old boiler", rule }] });
    expect(problems(rulePage({ ...oldBoiler, conditions: [] })).join(" ")).toContain("no conditions");
    expect(problems(rulePage({ ...oldBoiler, conditions: [{ field: "flue", op: "equals", value: "x" }] })).join(" "))
      .toContain("which is not asked before it");
    expect(problems(rulePage({ ...oldBoiler, conditions: [{ field: "nothing", op: "equals", value: "x" }] })).join(" "))
      .toContain("no such question");
    expect(problems(rulePage({ ...oldBoiler, conditions: [{ field: "phone", op: "equals", value: "x" }] })).join(" "))
      .toContain("pick one, pick several, number or typed answer");
    expect(problems(rulePage({ ...oldBoiler, conditions: [{ field: "system", op: "greater_than", value: 3 }] })).join(" "))
      .toContain("does not work for that kind of question");
    expect(problems(rulePage({ ...oldBoiler, conditions: [{ field: "system", op: "equals", value: "kettle" }] })).join(" "))
      .toContain("does not offer");
    expect(problems(rulePage({ ...oldBoiler, conditions: [{ field: "system", op: "one_of", values: ["kettle"] }] })).join(" "))
      .toContain("\"kettle\"");
    expect(problems(rulePage({ ...oldBoiler, conditions: [{ field: "age", op: "less_than", value: "old" }] })).join(" "))
      .toContain("not a number");
    expect(problems(rulePage({ ...oldBoiler, conditions: [{ field: "problem", op: "contains", value: "  " }] })).join(" "))
      .toContain("with no words");
    expect(problems({ pages: [{ title: "About you", rule: oldBoiler }, form.pages![1]!, form.pages![2]!] }).join(" "))
      .toContain("Page 1 is always shown");
    expect(problems({ pages: [form.pages![0]!, form.pages![1]!, { title: "Both", rule: oldBoiler, showWhen: { field: "system", oneOf: ["boiler"] } }] }).join(" "))
      .toContain("Page 3 has two rules");
    /** A question's rule waits only for a question asked before it, on its own page or an earlier one. */
    const later = form.fields.map((f) => (f.key === "system"
      ? { ...f, rule: { action: "show" as const, match: "all" as const, conditions: [{ field: "age", op: "equals" as const, value: 3 }] } } : f));
    expect(problems({ fields: later }).join(" ")).toContain("not asked before it");
    /** The only phone number behind a rule leaves the office no way to ring back. */
    const phoneRuled = form.fields.map((f) => (f.key === "phone"
      ? { ...f, page: 1, rule: { action: "show" as const, match: "all" as const, conditions: [{ field: "system", op: "equals" as const, value: "boiler" }] } } : f));
    expect(problems({ fields: [...phoneRuled.slice(1, 3), phoneRuled[0]!, ...phoneRuled.slice(3)] }).join(" ")).toContain("on a page everybody sees");
  });

  it("keeps a rule on a single question of a form that is not split", () => {
    const flat: FormDefinition = { key: "flat", title: "Flat", fields: form.fields.slice(0, 7).map(({ page: _p, ...f }) => f) };
    expect(checkForm(flat)).toMatchObject({ ok: true });
    expect(hiddenFieldKeys(flat, { problem: "a smell" }).has("gas")).toBe(false);
    expect(hiddenFieldKeys(flat, { problem: "noise" }).has("gas")).toBe(true);
  });
});
