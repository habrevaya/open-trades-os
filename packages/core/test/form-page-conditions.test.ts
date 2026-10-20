import { describe, it, expect } from "vitest";
import {
  checkForm, checkSubmission, checkPage, shownPages, hiddenFieldKeys, confirmationProblems,
  firstNameScope, firstNameFallbackProblem, nameFieldOf, DEFAULT_FIRST_NAME_FALLBACK,
  type FormDefinition, type FormField,
} from "../src/marketing/index.js";

/**
 * A PAGE SHOWN ONLY FOR SOME ANSWERS, AND A FIRST NAME OF ITS OWN
 *
 * A page can wait for an earlier pick one or pick several answer. What it
 * asks is not asked of anybody who was not sent there: nothing on it is
 * required and anything sent for it is dropped. And `{{ firstName }}` is the
 * first word of the name answer, with the company's own words when the lead
 * gave no name.
 */

const field = (key: string, type: FormField["type"], extra: Partial<FormField> = {}): FormField =>
  ({ key, label: key[0]!.toUpperCase() + key.slice(1), type, required: false, ...extra });

const WORK = [
  { value: "boiler", label: "Boiler" }, { value: "leak", label: "A leak" }, { value: "other", label: "Something else" },
];

const form: FormDefinition = {
  key: "work",
  title: "What do you need",
  pages: [
    { title: "About you" },
    { title: "What is wrong" },
    { title: "The boiler", showWhen: { field: "work", oneOf: ["boiler"] } },
    { title: "The leak", showWhen: { field: "work", oneOf: ["leak", "other"] } },
  ],
  fields: [
    field("name", "text", { required: true, page: 0 }),
    field("phone", "phone", { required: true, page: 0 }),
    field("work", "choice", { required: true, page: 1, options: WORK }),
    field("age", "number", { required: true, page: 2 }),
    field("where", "text", { required: true, page: 3 }),
    field("website", "honeypot"),
  ],
};

describe("a page shown only for some answers", () => {
  it("is a coherent form", () => {
    expect(checkForm(form).ok).toBe(true);
  });

  it("is shown only when the earlier answer is one of its values", () => {
    expect(shownPages(form, { work: "boiler" })).toEqual([true, true, true, false]);
    expect(shownPages(form, { work: "leak" })).toEqual([true, true, false, true]);
    expect(shownPages(form, { work: "other" })).toEqual([true, true, false, true]);
    expect(shownPages(form, {})).toEqual([true, true, false, false]);
    expect(shownPages(form, { work: "nonsense" })).toEqual([true, true, false, false]);
  });

  it("is shown for any one of several picked options", () => {
    const several: FormDefinition = {
      ...form,
      fields: form.fields.map((f) => (f.key === "work" ? { ...f, type: "multi_choice" as const } : f)),
    };
    expect(shownPages(several, { work: ["leak", "boiler"] })).toEqual([true, true, true, true]);
    expect(shownPages(several, { work: [] })).toEqual([true, true, false, false]);
  });

  it("waits for a page that is itself shown: a hidden page's answer opens nothing", () => {
    const chain: FormDefinition = {
      key: "chain", title: "Chain",
      pages: [
        { title: "One" }, { title: "Two", showWhen: { field: "a", oneOf: ["yes"] } },
        { title: "Three", showWhen: { field: "b", oneOf: ["yes"] } },
      ],
      fields: [
        field("phone", "phone", { required: true, page: 0 }),
        field("a", "choice", { page: 0, options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] }),
        field("b", "choice", { page: 1, options: [{ value: "yes", label: "Yes" }] }),
        field("c", "text", { page: 2 }),
      ],
    };
    expect(checkForm(chain).ok).toBe(true);
    expect(shownPages(chain, { a: "no", b: "yes" })).toEqual([true, false, false]);
    expect(shownPages(chain, { a: "yes", b: "yes" })).toEqual([true, true, true]);
  });

  it("never requires what a page nobody was sent to asks, and drops what was sent for it", () => {
    const leak = checkSubmission(form, { values: { name: "Ada Lovelace", phone: "5125550134", work: "leak", where: "kitchen", age: 12 } });
    expect(leak).toEqual({ ok: true, values: { name: "Ada Lovelace", phone: "5125550134", work: "leak", where: "kitchen" } });

    /** The boiler page is required for a boiler, and not mentioned for a leak. */
    const missing = checkSubmission(form, { values: { name: "Ada", phone: "5125550134", work: "boiler" } });
    expect(missing.ok).toBe(false);
    if (!missing.ok && missing.reason === "invalid") expect(missing.refusals.map((r) => r.field)).toEqual(["age"]);
    expect(checkSubmission(form, { values: { name: "Ada", phone: "5125550134", work: "boiler", age: 9 } }))
      .toEqual({ ok: true, values: { name: "Ada", phone: "5125550134", work: "boiler", age: 9 } });
  });

  it("does not check a page nobody is sent to when Next is pressed", () => {
    expect(checkPage(form, 2, { work: "leak" })).toEqual([]);
    expect(checkPage(form, 2, { work: "boiler" }).map((r) => r.field)).toEqual(["age"]);
  });

  it("names the keys on the pages not shown", () => {
    expect([...hiddenFieldKeys(form, { work: "boiler" })]).toEqual(["where"]);
    expect([...hiddenFieldKeys(form, { work: "leak" })]).toEqual(["age"]);
  });

  it("is refused when the rule makes no sense, in words", () => {
    const problems = (showWhen: unknown, pageIndex = 2) => {
      const pages = form.pages!.map((p, i) => (i === pageIndex ? { ...p, showWhen } : p)) as FormDefinition["pages"];
      const verdict = checkForm({ ...form, pages });
      return verdict.ok ? [] : verdict.problems;
    };
    expect(problems({ field: "nothing", oneOf: ["x"] }).join(" ")).toContain(`has no such question`);
    expect(problems({ field: "age", oneOf: ["x"] }).join(" ")).toContain("not on an earlier page");
    expect(problems({ field: "name", oneOf: ["x"] }).join(" ")).toContain("not a pick one or pick several question");
    expect(problems({ field: "work", oneOf: [] }).join(" ")).toContain("shown for no answer at all");
    expect(problems({ field: "work", oneOf: ["furnace"] }).join(" ")).toContain(`"furnace", which "work" does not offer`);
    expect(problems({ field: "work", oneOf: ["boiler"] }, 0).join(" ")).toContain("Page 1 is always shown");
  });

  it("needs a way to ring back on a page everybody sees", () => {
    const verdict = checkForm({
      ...form,
      fields: form.fields.map((f) => (f.key === "phone" ? { ...f, page: 2 } : f)),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problems.join(" ")).toContain("on a page everybody sees");
  });
});

describe("a first name of its own", () => {
  const named: FormDefinition = {
    key: "n", title: "N",
    fields: [field("name", "text", { required: true }), field("phone", "phone", { required: true })],
  };

  it("is the first word of the name answer", () => {
    expect(firstNameScope(named, { name: "Ada Augusta Lovelace", phone: "5125550134" }, "message")).toEqual({ firstName: "Ada" });
    expect(firstNameScope(named, { name: "  Grace   Hopper " }, "page")).toEqual({ firstName: "Grace" });
  });

  it("falls back to the company's words, else to there, when there is no name", () => {
    expect(firstNameScope(named, { phone: "5125550134" }, "message", "neighbour")).toEqual({ firstName: "neighbour" });
    expect(firstNameScope(named, { phone: "5125550134" }, "message")).toEqual({ firstName: DEFAULT_FIRST_NAME_FALLBACK });
    expect(firstNameScope(named, { name: "   " }, "message", "friend")).toEqual({ firstName: "friend" });
  });

  it("leaves out a first word that is a link in a text, as every answer is", () => {
    expect(firstNameScope(named, { name: "evil.example is here" }, "message", "friend")).toEqual({ firstName: "friend" });
    expect(firstNameScope(named, { name: "{{phone}} Ada" }, "message")).toEqual({ firstName: "phone" });
  });

  it("is nothing on a form that asks no name", () => {
    expect(firstNameScope({ key: "x", title: "X", fields: [field("phone", "phone", { required: true })] }, {}, "message")).toEqual({});
  });

  it("finds the name question the way a lead's customer is named", () => {
    expect(nameFieldOf(named)?.key).toBe("name");
    const other: FormDefinition = { key: "o", title: "O", fields: [field("who", "text", { label: "Your full name" })] };
    expect(nameFieldOf(other)?.key).toBe("who");
    expect(nameFieldOf(other, {})).toBeUndefined();
  });

  it("is a name a confirmation may use only when the form asks one", () => {
    expect(confirmationProblems(named, ["Thanks {{ firstName }}."])).toEqual([]);
    const none: FormDefinition = { key: "x", title: "X", fields: [field("phone", "phone", { required: true })] };
    expect(confirmationProblems(none, ["Thanks {{ firstName }}."])[0]).toContain("this form has no question for a name");
  });

  it("limits the words that stand in for a name", () => {
    expect(firstNameFallbackProblem("neighbour")).toBeNull();
    expect(firstNameFallbackProblem("")).toBeNull();
    expect(firstNameFallbackProblem("{{ x }}")).toContain("braces");
    expect(firstNameFallbackProblem("x".repeat(41))).toContain("at most 40");
  });
});
