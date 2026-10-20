import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as forms from "../src/services/forms";
import * as files from "../src/services/files";
import { seedOrg, testDb, fixtureId } from "./helpers";
import type { ServiceContext } from "../src/services/context";

/**
 * A HOSTED FORM THAT SKIPS PAGES BY ANSWER, AND SAYS A FIRST NAME
 *
 * A page can wait for an earlier pick one answer. The submit check holds the
 * rule as the hosted page does: a page the answers do not lead to is not asked,
 * so nothing on it is required, what was sent for it is dropped before it is
 * stored (answers and files alike), and it cannot be the only way to ring the
 * person back. And `{{ firstName }}` is the first word of the name answer, with
 * the company's own words, else "there", for a lead who gave no name.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("form-page-rules:org");
const USER = fixtureId("form-page-rules:user");
const SLUG = "form-page-rules-co";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const meta = () => ({ ip: `10.91.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const FIELDS = [
  { key: "name", label: "Your name", type: "text" as const, required: false, page: 0 },
  { key: "phone", label: "Mobile number", type: "phone" as const, required: true, page: 0 },
  {
    key: "work", label: "What do you need", type: "choice" as const, required: true, page: 1,
    options: [{ value: "boiler", label: "A boiler" }, { value: "leak", label: "A leak" }],
  },
  { key: "age", label: "How old is the boiler", type: "number" as const, required: true, page: 2 },
  { key: "boiler_photos", label: "Photos of the boiler", type: "file" as const, required: false, page: 2 },
  { key: "where", label: "Where is the leak", type: "text" as const, required: true, page: 3 },
  { key: "website", label: "Leave this empty", type: "honeypot" as const, required: false },
];
const PAGES = [
  { title: "About you" },
  { title: "What is wrong" },
  { title: "The boiler", showWhen: { field: "work", oneOf: ["boiler"] } },
  { title: "The leak", showWhen: { field: "work", oneOf: ["leak"] } },
];

const post = (values: Record<string, unknown>, filesSent: Parameters<typeof forms.submit>[1]["files"] = undefined) =>
  forms.submit(db(), { organizationSlug: SLUG, formSlug: "rules", values, files: filesSent }, meta());

const stored = async (submissionId: string) =>
  (await raw<{ raw: Record<string, unknown>; clean: Record<string, unknown> | null; state: string }[]>`
    select raw, clean, state from public.form_submission where id = ${submissionId}`)[0]!;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Page Rules Co", slug: SLUG });
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
            values (${ORG}, '+15125558000', 'main', true)`;
  await forms.save(owner(), {
    slug: "rules", title: "What do you need", source: "organic_search", fields: FIELDS, pages: PAGES,
    settings: {
      thankYou: "Thanks, {{ firstName }}. We will ring about {{ work }}.",
      confirmationText: "Hi {{ firstName }}, Page Rules Co here. We ring soon.",
      firstNameFallback: "neighbour",
    },
  });
});

afterAll(async () => { if (raw) await raw.end(); });

run("a page shown only for some answers", () => {
  it("serves the rule to the hosted page and the builder", async () => {
    const definition = await forms.definitionOf(owner(), "rules");
    expect(definition.pages).toEqual(PAGES);
    expect(definition.settings.firstNameFallback).toBe("neighbour");
    const hosted = await forms.hosted(db(), { key: definition.publicKey! });
    expect(hosted.pages).toEqual(PAGES);
  });

  it("does not require the page a person was not sent to, and drops what was typed on it", async () => {
    const leak = await post({ name: "Ada Lovelace", phone: "5125558101", work: "leak", where: "under the sink", age: 14 });
    expect(leak.accepted).toBe(true);
    const row = await stored(leak.submissionId);
    expect(row.clean).toEqual({ name: "Ada Lovelace", phone: "5125558101", work: "leak", where: "under the sink" });
    /** The stale answer from the boiler page is not kept even as what arrived. */
    expect(row.raw["age"]).toBeUndefined();
    const [task] = await raw<{ body: string }[]>`
      select body from public.task where organization_id = ${ORG} and entity_id = ${leak.customerId!} order by created_at desc limit 1`;
    expect(task!.body).not.toContain("How old is the boiler");
  });

  it("requires the page a person was sent to", async () => {
    const missing = await post({ name: "Ada", phone: "5125558102", work: "boiler" });
    expect(missing.accepted).toBe(false);
    expect(missing.refusals.map((r) => r.field)).toEqual(["age"]);
    expect((await stored(missing.submissionId)).state).toBe("rejected");
    const ok = await post({ name: "Ada", phone: "5125558103", work: "boiler", age: 11 });
    expect(ok.accepted).toBe(true);
  });

  it("asks nothing of a person whose answer leads to no page", async () => {
    const neither = await post({ name: "Ada", phone: "5125558104", work: "furnace" });
    expect(neither.accepted).toBe(false);
    expect(neither.refusals.map((r) => r.field)).toEqual(["work"]);
  });

  it("reads a file picked for a page nobody was sent to as nothing: not refused, not counted, not kept", async () => {
    const before = Number((await raw<{ n: string }[]>`select count(*) as n from public.stored_file where organization_id = ${ORG}`)[0]!.n);
    const leak = await post(
      { name: "Grace", phone: "5125558105", work: "leak", where: "kitchen" },
      [{ field: "boiler_photos", fileName: "boiler.png", contentType: "image/png", bytes: PNG.toString("base64") }],
    );
    expect(leak.accepted).toBe(true);
    const after = Number((await raw<{ n: string }[]>`select count(*) as n from public.stored_file where organization_id = ${ORG}`)[0]!.n);
    expect(after).toBe(before);
    expect(await files.attachmentsFor(owner(), { entityType: "customer", entityId: leak.customerId! })).toEqual([]);

    const boiler = await post(
      { name: "Grace", phone: "5125558106", work: "boiler", age: 3 },
      [{ field: "boiler_photos", fileName: "boiler.png", contentType: "image/png", bytes: PNG.toString("base64") }],
    );
    expect(boiler.accepted).toBe(true);
    expect((await files.attachmentsFor(owner(), { entityType: "customer", entityId: boiler.customerId! })).map((f) => f.kind))
      .toEqual(["form_file"]);
  });

  it("refuses a rule that makes no sense, or a phone that only a conditional page asks for", async () => {
    await expect(forms.save(owner(), {
      slug: "bad-rule", title: "Bad", fields: FIELDS,
      pages: PAGES.map((p, i) => (i === 2 ? { ...p, showWhen: { field: "where", oneOf: ["x"] } } : p)),
    })).rejects.toThrow(/which is not on an earlier page/);
    await expect(forms.save(owner(), {
      slug: "bad-rule", title: "Bad", fields: FIELDS,
      pages: PAGES.map((p, i) => (i === 2 ? { ...p, showWhen: { field: "work", oneOf: ["furnace"] } } : p)),
    })).rejects.toThrow(/"furnace", which "work" does not offer/);
    await expect(forms.save(owner(), {
      slug: "bad-rule", title: "Bad",
      fields: FIELDS.map((f) => (f.key === "phone" ? { ...f, page: 2 } : f)).sort((a, b) => (a.page ?? 0) - (b.page ?? 0)),
      pages: PAGES,
    })).rejects.toThrow(/on a page everybody sees/);
  });

  it("drops the rule when a form is saved on one page", async () => {
    await forms.save(owner(), {
      slug: "one-page", title: "One", fields: FIELDS.filter((f) => f.page === 0),
      pages: [{ title: "Only", showWhen: { field: "work", oneOf: ["leak"] } }],
    });
    const flat = await forms.definitionOf(owner(), "one-page");
    expect(flat.pages).toEqual([]);
  });
});

run("a first name merge field", () => {
  it("is the first word of the name answer, on the page and in the text", async () => {
    const said = await post({ name: "Ada Augusta Lovelace", phone: "5125558110", work: "leak", where: "attic" });
    expect(said.thankYou).toBe("Thanks, Ada. We will ring about A leak.");
    const [text] = await raw<{ body: string }[]>`
      select body from public.message where organization_id = ${ORG} and to_address = '+15125558110'`;
    expect(text!.body).toBe("Hi Ada, Page Rules Co here. We ring soon.");
  });

  it("falls back to the company's words for a lead with no name", async () => {
    const said = await post({ phone: "5125558111", work: "leak", where: "attic" });
    expect(said.accepted).toBe(true);
    expect(said.thankYou).toBe("Thanks, neighbour. We will ring about A leak.");
    const [text] = await raw<{ body: string }[]>`
      select body from public.message where organization_id = ${ORG} and to_address = '+15125558111'`;
    expect(text!.body).toBe("Hi neighbour, Page Rules Co here. We ring soon.");
  });

  it("falls back to there when the company set no words", async () => {
    await forms.save(owner(), {
      slug: "plain", title: "Plain", fields: FIELDS.filter((f) => f.page === 0),
      settings: { thankYou: "Thanks {{ firstName }}." },
    });
    const plain = await forms.submit(db(), {
      organizationSlug: SLUG, formSlug: "plain", values: { phone: "5125558112" },
    }, meta());
    expect(plain.thankYou).toBe("Thanks there.");
  });

  it("is not repeated when the first word is a link, in a text or an email", async () => {
    const said = await post({ name: "evil.example Ada", phone: "5125558113", work: "leak", where: "attic" });
    const [text] = await raw<{ body: string }[]>`
      select body from public.message where organization_id = ${ORG} and to_address = '+15125558113'`;
    expect(text!.body).toBe("Hi neighbour, Page Rules Co here. We ring soon.");
    expect(said.accepted).toBe(true);
  });

  it("is refused in words on a form that asks no name, and the fallback is limited", async () => {
    await expect(forms.save(owner(), {
      slug: "nameless", title: "Nameless", fields: FIELDS.filter((f) => f.key === "phone" || f.key === "website"),
      settings: { thankYou: "Thanks {{ firstName }}." },
    })).rejects.toThrow(/first word of their name, and this form has no question for a name/);
    await expect(forms.save(owner(), {
      slug: "plain", title: "Plain", fields: FIELDS.filter((f) => f.page === 0),
      settings: { firstNameFallback: "{{ phone }}" },
    })).rejects.toThrow(/cannot hold braces/);
  });
});
