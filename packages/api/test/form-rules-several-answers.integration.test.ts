import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as forms from "../src/services/forms";
import { saveForm as saveFormRoute } from "../src/contracts/marketing";
import { seedOrg, testDb, fixtureId } from "./helpers";
import type { ServiceContext } from "../src/services/context";

/**
 * M19. A HOSTED FORM WITH RULES OVER SEVERAL ANSWERS
 *
 * A page about an old boiler is shown only when the person picked a boiler
 * AND said it is over fifteen years old. A question about a gas smell is
 * asked when the description mentions a smell OR the work is in the
 * basement, and the serial number is hidden for a system under two years
 * old. The submit check holds every rule as the hosted page does: what the
 * answers hide is not asked, never required, and dropped before the
 * submission is stored. A rule the form could not keep is refused when the
 * form is saved, in words.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("form-rules-several:org");
const USER = fixtureId("form-rules-several:user");
const SLUG = "form-rules-several-co";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
const meta = () => ({ ip: `10.92.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });

const GAS_RULE = {
  action: "show" as const, match: "any" as const,
  conditions: [
    { field: "problem", op: "contains" as const, value: "smell" },
    { field: "rooms", op: "one_of" as const, values: ["basement"] },
  ],
};
const SERIAL_RULE = { action: "hide" as const, match: "all" as const, conditions: [{ field: "age", op: "less_than" as const, value: 2 }] };
const OLD_BOILER = {
  action: "show" as const, match: "all" as const,
  conditions: [{ field: "system", op: "equals" as const, value: "boiler" }, { field: "age", op: "greater_than" as const, value: 15 }],
};

const FIELDS = [
  { key: "name", label: "Your name", type: "text" as const, required: false, page: 0 },
  { key: "phone", label: "Mobile number", type: "phone" as const, required: true, page: 0 },
  {
    key: "system", label: "What needs work", type: "choice" as const, required: true, page: 1,
    options: [{ value: "boiler", label: "Boiler" }, { value: "furnace", label: "Furnace" }],
  },
  { key: "age", label: "How old is it, in years", type: "number" as const, required: true, page: 1 },
  {
    key: "rooms", label: "Where is it", type: "multi_choice" as const, required: false, page: 1,
    options: [{ value: "attic", label: "Attic" }, { value: "basement", label: "Basement" }],
  },
  { key: "problem", label: "What is wrong", type: "long_text" as const, required: false, page: 1 },
  {
    key: "gas", label: "Can you smell gas now", type: "choice" as const, required: true, page: 1, rule: GAS_RULE,
    options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
  },
  { key: "serial", label: "Serial number", type: "text" as const, required: true, page: 1, rule: SERIAL_RULE },
  { key: "flue", label: "What is the flue made of", type: "text" as const, required: true, page: 2 },
  { key: "website", label: "Leave this empty", type: "honeypot" as const, required: false },
];
const PAGES = [{ title: "About you" }, { title: "The system" }, { title: "An old boiler", rule: OLD_BOILER }];

const post = (values: Record<string, unknown>) =>
  forms.submit(db(), { organizationSlug: SLUG, formSlug: "several", values }, meta());

const stored = async (submissionId: string) =>
  (await raw<{ raw: Record<string, unknown>; clean: Record<string, unknown> | null; state: string }[]>`
    select raw, clean, state from public.form_submission where id = ${submissionId}`)[0]!;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Several Answers Co", slug: SLUG });
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
            values (${ORG}, '+15125558300', 'main', true)`;
  await forms.save(owner(), { slug: "several", title: "What needs work", source: "organic_search", fields: FIELDS, pages: PAGES });
});

afterAll(async () => { if (raw) await raw.end(); });

run("rules over several answers", () => {
  it("serves every rule to the builder and the hosted page as it was saved", async () => {
    const definition = await forms.definitionOf(owner(), "several");
    expect(definition.pages).toEqual(PAGES);
    expect(definition.fields.find((f) => f.key === "gas")?.rule).toEqual(GAS_RULE);
    const hosted = await forms.hosted(db(), { key: definition.publicKey! });
    expect(hosted.pages[2]?.rule).toEqual(OLD_BOILER);
    expect(hosted.fields.find((f) => f.key === "serial")?.rule).toEqual(SERIAL_RULE);
  });

  it("takes a rule through the route's own schema, and refuses a malformed one there", () => {
    expect(saveFormRoute.input.safeParse({ slug: "several", title: "x", fields: FIELDS, pages: PAGES }).success).toBe(true);
    const bad = { ...FIELDS[6]!, rule: { ...GAS_RULE, conditions: [{ field: "problem", op: "resembles", value: "x" }] } };
    expect(saveFormRoute.input.safeParse({ slug: "several", title: "x", fields: [...FIELDS.slice(0, 6), bad] }).success).toBe(false);
  });

  it("drops what the answers hide, and never requires it", async () => {
    const furnace = await post({
      name: "Ada", phone: "5125558301", system: "furnace", age: 1, rooms: ["attic"], problem: "It rattles",
      gas: "no", serial: "SN-1", flue: "steel",
    });
    expect(furnace.accepted).toBe(true);
    const row = await stored(furnace.submissionId);
    expect(row.clean).toEqual({ name: "Ada", phone: "5125558301", system: "furnace", age: 1, rooms: ["attic"], problem: "It rattles" });
    expect(row.raw["gas"]).toBeUndefined();
    expect(row.raw["serial"]).toBeUndefined();
    expect(row.raw["flue"]).toBeUndefined();
  });

  it("requires what the answers lead to: all of a page's conditions, any one of a question's", async () => {
    const old = await post({ phone: "5125558302", system: "boiler", age: "20", rooms: ["basement"] });
    expect(old.accepted).toBe(false);
    expect(old.refusals.map((r) => r.field).sort()).toEqual(["flue", "gas", "serial"]);
    expect((await stored(old.submissionId)).state).toBe("rejected");

    const smell = await post({ phone: "5125558303", system: "boiler", age: 9, problem: "A SMELL near the boiler", gas: "yes", serial: "B-9" });
    expect(smell.accepted).toBe(true);
    expect((await stored(smell.submissionId)).clean).toMatchObject({ gas: "yes", serial: "B-9" });
    expect((await stored(smell.submissionId)).clean).not.toHaveProperty("flue");
  });

  it("refuses a rule the form could not keep when it is saved, in words", async () => {
    const waitsLater = FIELDS.map((f) => (f.key === "system"
      ? { ...f, rule: { action: "show" as const, match: "all" as const, conditions: [{ field: "age", op: "greater_than" as const, value: 3 }] } } : f));
    await expect(forms.save(owner(), { slug: "several", title: "x", source: "organic_search", fields: waitsLater, pages: PAGES }))
      .rejects.toThrow(/waits for "How old is it, in years", which is not asked before it/);
    const wrongOp = PAGES.map((p, i) => (i === 2 ? { ...p, rule: { ...OLD_BOILER, conditions: [{ field: "system", op: "greater_than" as const, value: 1 }] } } : p));
    await expect(forms.save(owner(), { slug: "several", title: "x", source: "organic_search", fields: FIELDS, pages: wrongOp }))
      .rejects.toThrow(/does not work for that kind of question/);
    /** The form as it was is still served. */
    expect((await forms.definitionOf(owner(), "several")).pages).toEqual(PAGES);
  });
});
