import { describe, it, expect } from "vitest";
import {
  checkForm, checkSubmission, checkPage, pagesOf, firstPageWith,
  confirmationProblems, confirmationScope, confirmationValue, MAX_FORM_PAGES,
  type FormDefinition, type FormField,
} from "../src/marketing/index.js";
import { FORM_UPLOADS, FORM_UPLOAD_MAX_BASE64, checkFormUpload, planFormUpload } from "../src/files/index.js";

/**
 * A LEAD FORM IN PAGES, WITH FILES, AND A CONFIRMATION THAT SAYS THEIR NAME
 *
 * The rules a hosted form is held to before anything is stored: how a form is
 * split into pages, what one page refuses before the person moves on, what a
 * stranger may send with it, and what a confirmation may repeat of what they
 * typed into a text that goes to whatever number they typed.
 */

const field = (key: string, type: FormField["type"], extra: Partial<FormField> = {}): FormField =>
  ({ key, label: key[0]!.toUpperCase() + key.slice(1), type, required: false, ...extra });

const paged: FormDefinition = {
  key: "boiler",
  title: "Boiler trouble",
  pages: [{ title: "About you" }, { title: "The boiler" }],
  fields: [
    field("name", "text", { required: true, page: 0 }),
    field("phone", "phone", { required: true, page: 0 }),
    field("system", "choice", { page: 1, required: true, options: [{ value: "combi", label: "Combi boiler" }] }),
    field("photos", "file", { page: 1 }),
    field("website", "honeypot"),
  ],
};

describe("a form in pages", () => {
  it("is coherent when every page has a question and the pages come in order", () => {
    expect(checkForm(paged)).toEqual({ ok: true, form: paged });
    expect(pagesOf(paged)).toEqual([
      { title: "About you", keys: ["name", "phone"] },
      { title: "The boiler", keys: ["system", "photos"] },
    ]);
  });

  it("is one page with no heading when it is not split", () => {
    const flat: FormDefinition = { ...paged, pages: undefined, fields: paged.fields.map((f) => ({ ...f, page: undefined })) };
    expect(checkForm(flat).ok).toBe(true);
    expect(pagesOf(flat)).toEqual([{ title: null, keys: ["name", "phone", "system", "photos"] }]);
  });

  it("refuses a question on a page the form does not have", () => {
    const verdict = checkForm({ ...paged, pages: undefined });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problems.join(" ")).toContain(`"system" is on page 2, and this form has only one page.`);
  });

  it("refuses a page that comes back after a later one started, an empty page and a page with no heading", () => {
    const verdict = checkForm({
      ...paged,
      pages: [{ title: "About you" }, { title: " " }, { title: "Empty" }],
      fields: [
        field("name", "text", { required: true, page: 1 }),
        field("phone", "phone", { required: true, page: 0 }),
      ],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      const said = verdict.problems.join(" ");
      expect(said).toContain(`"phone" is on page 1 after a question on page 2`);
      expect(said).toContain("Page 2 has no heading");
      expect(said).toContain("Page 3 has no questions on it.");
    }
  });

  it("refuses more pages than a lead form should have", () => {
    const pages = Array.from({ length: MAX_FORM_PAGES + 1 }, (_, i) => ({ title: `Page ${i + 1}` }));
    const fields = pages.map((_, i) => field(i === 0 ? "phone" : `q${i}`, i === 0 ? "phone" : "text", { page: i, required: i === 0 }));
    const verdict = checkForm({ key: "long", title: "Long", pages, fields });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problems.join(" ")).toContain(`at most ${MAX_FORM_PAGES} pages`);
  });

  it("checks one page's questions only, in the words the whole check uses", () => {
    expect(checkPage(paged, 0, { name: "Ada" })).toEqual([
      { field: "phone", reason: "required", message: "Phone is needed." },
    ]);
    expect(checkPage(paged, 0, { name: "Ada", phone: "(512) 555-0134" })).toEqual([]);
    const second = checkPage(paged, 1, {});
    expect(second.map((r) => r.field)).toEqual(["system"]);
    const whole = checkSubmission(paged, { values: { name: "Ada" } });
    expect(whole.ok).toBe(false);
    if (!whole.ok && whole.reason === "invalid") {
      expect(whole.refusals.find((r) => r.field === "phone")?.message).toBe(checkPage(paged, 0, { name: "Ada" })[0]!.message);
    }
  });

  it("names the first page holding a refused question, so the page can go back to it", () => {
    expect(firstPageWith(paged, ["system"])).toBe(1);
    expect(firstPageWith(paged, ["system", "phone"])).toBe(0);
    expect(firstPageWith(paged, ["nothing"])).toBeNull();
  });
});

describe("a file field", () => {
  it("takes the names of the files sent, cleaned, and asks plainly when it is required", () => {
    const form: FormDefinition = { ...paged, fields: [...paged.fields.slice(0, 3), field("photos", "file", { page: 1, required: true })] };
    const ok = checkSubmission(form, {
      values: { name: "Ada", phone: "5125550134", system: "combi", photos: ["../../leak\u0000.jpg"] },
    });
    expect(ok).toEqual({ ok: true, values: { name: "Ada", phone: "5125550134", system: "combi", photos: ["leak.jpg"] } });
    const missing = checkSubmission(form, { values: { name: "Ada", phone: "5125550134", system: "combi" } });
    expect(missing.ok).toBe(false);
    if (!missing.ok && missing.reason === "invalid") {
      expect(missing.refusals).toEqual([{ field: "photos", reason: "required", message: "Photos: add a photo or a PDF." }]);
    }
  });

  it("refuses anything but a list of names, and more files than a form takes", () => {
    const one: FormDefinition = { key: "f", title: "F", fields: [field("phone", "phone", { required: true }), field("photos", "file")] };
    const wrong = checkSubmission(one, { values: { phone: "5125550134", photos: "leak.jpg" } });
    expect(!wrong.ok && wrong.reason === "invalid" && wrong.refusals[0]!.reason).toBe("wrong_type");
    const many = checkSubmission(one, {
      values: { phone: "5125550134", photos: Array.from({ length: FORM_UPLOADS.maxFiles + 1 }, (_, i) => `${i}.jpg`) },
    });
    expect(!many.ok && many.reason === "invalid" && many.refusals[0]!.reason).toBe("bad_file");
  });

  it("is refused with rules or options, which mean nothing on files", () => {
    const verdict = checkForm({
      key: "f", title: "F",
      fields: [field("phone", "phone", { required: true }), field("photos", "file", { rules: [{ rule: "max_length", value: 3 }] })],
    });
    expect(verdict.ok).toBe(false);
  });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const none = { filesAlreadyAdded: 0, bytesAlreadyAdded: 0 };

describe("what a stranger may send with a lead form", () => {
  it("refuses a program by its name or its claimed type before the bytes are read", () => {
    expect(planFormUpload({ fileName: "photo.jpg.exe", encodedLength: 10 }).ok).toBe(false);
    expect(planFormUpload({ fileName: "photo.jpg", contentType: "application/x-msdownload", encodedLength: 10 }).ok).toBe(false);
    expect(planFormUpload({ fileName: "leak.svg", encodedLength: 10 }).ok).toBe(false);
    expect(planFormUpload({ fileName: "leak.jpg", contentType: "image/jpeg", encodedLength: 10 })).toEqual({ ok: true });
  });

  it("refuses a file said to be too large before it is decoded", () => {
    expect(planFormUpload({ fileName: "big.jpg", encodedLength: FORM_UPLOAD_MAX_BASE64 + 4 }).ok).toBe(false);
    expect(planFormUpload({ fileName: "fits.jpg", encodedLength: FORM_UPLOAD_MAX_BASE64 }).ok).toBe(true);
  });

  it("keeps a photo or a PDF decided from the bytes, whatever it was called", () => {
    expect(checkFormUpload({ fileName: "leak.jpg", contentType: "image/jpeg", bytes: PNG }, none))
      .toMatchObject({ ok: true, contentType: "image/png", extension: "png" });
    expect(checkFormUpload({ fileName: "quote", bytes: PDF }, none)).toMatchObject({ ok: true, contentType: "application/pdf" });
  });

  it("refuses a program by its bytes, a type that is not a photo or a PDF, and an empty file", () => {
    const exe = checkFormUpload({ fileName: "leak.jpg", contentType: "image/jpeg", bytes: EXE }, none);
    expect(exe).toEqual({ ok: false, reason: "leak.jpg was not sent: it is a program or a script, and those are never kept. Send a photo or a PDF." });
    expect(checkFormUpload({ fileName: "anim.gif", bytes: GIF }, none).ok).toBe(false);
    expect(checkFormUpload({ fileName: "empty.png", bytes: new Uint8Array() }, none).ok).toBe(false);
  });

  it("holds the count and the total for one submission", () => {
    expect(checkFormUpload({ fileName: "six.png", bytes: PNG }, { filesAlreadyAdded: FORM_UPLOADS.maxFiles, bytesAlreadyAdded: 0 }).ok).toBe(false);
    expect(checkFormUpload({ fileName: "over.png", bytes: PNG }, { filesAlreadyAdded: 1, bytesAlreadyAdded: FORM_UPLOADS.maxTotalBytes - 4 }).ok).toBe(false);
    expect(checkFormUpload({ fileName: "under.png", bytes: PNG }, { filesAlreadyAdded: 1, bytesAlreadyAdded: FORM_UPLOADS.maxTotalBytes - 12 }).ok).toBe(true);
  });
});

describe("a confirmation that repeats what they typed", () => {
  const form: FormDefinition = {
    key: "c", title: "C",
    fields: [
      field("name", "text", { required: true }),
      field("phone", "phone", { required: true }),
      field("system", "choice", { options: [{ value: "combi", label: "Combi boiler" }] }),
      field("details", "long_text"),
      field("texts_ok", "consent"),
      field("photos", "file"),
    ],
  };

  it("may name the short answers and nothing else", () => {
    expect(confirmationProblems(form, ["Thanks {{ name }}, about your {{system}} on {{ phone }}."])).toEqual([]);
    const problems = confirmationProblems(form, ["{{ details }}", "{{ nmae }}", "{{ photos }}", undefined]);
    expect(problems).toContain(`"{{ details }}" is a long text field, and a confirmation can repeat only short answers.`);
    expect(problems).toContain(`"{{ nmae }}" is not a question on this form.`);
    expect(problems).toContain(`"{{ photos }}" is a file field, and a confirmation can repeat only short answers.`);
    expect(problems.at(-1)).toBe("It can use {{ name }}, {{ phone }}, {{ system }}.");
  });

  it("says a choice by its label and a phone as it is written", () => {
    expect(confirmationScope(form, { name: "Ada", phone: "5125550134", system: "combi", details: "long words" }, "message"))
      .toEqual({ name: "Ada", phone: "(512) 555-0134", system: "Combi boiler" });
  });

  it("keeps a stranger's words short, on one line and without a link in a text or an email", () => {
    expect(confirmationValue("Ada\nLovelace {{ phone }}", "message")).toBe("Ada Lovelace phone");
    expect(confirmationValue("Your account is locked, visit evil.example now", "message")).toBe("");
    expect(confirmationValue("see https://x.test", "message")).toBe("");
    expect(confirmationValue("www.bad", "message")).toBe("");
    expect(confirmationValue("me@mail.test", "message")).toBe("");
    expect(confirmationValue("x".repeat(100), "message")).toHaveLength(60);
    expect(confirmationValue("<b>Ada</b> evil.example", "page")).toBe("<b>Ada</b> evil.example");
  });
});
