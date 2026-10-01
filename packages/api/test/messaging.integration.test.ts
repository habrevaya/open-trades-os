import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as templates from "../src/services/message-templates";
import * as registration from "../src/services/messaging-registration";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * THE WORDS, AND PERMISSION TO SEND THEM
 *
 * `message_template`, `messaging_brand` and `messaging_campaign` have been in
 * the schema since the first migration and nothing had ever written a row.
 *
 * Templates matter because the wording of every message this product sends
 * was a string literal in a service: the arrival notice built by a function
 * no operator could reach. A company's texts are its voice to somebody in
 * their driveway, and a product where changing that voice needs a developer
 * is one where it never changes.
 *
 * Registration matters because in the United States a business cannot send
 * application-to-person SMS until a carrier has approved the use case, and
 * unregistered traffic is filtered silently rather than refused loudly. The
 * texts stop arriving and nobody is told.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("msg18:org");
const USER = fixtureId("msg18:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Wording Co", slug: "wording-co" });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Wording Co", slug: "wording-co" });
});

run("what a template has to be", () => {
  it("refuses a body using a placeholder it does not declare", async () => {
    /**
     * THE EXPENSIVE ONE. The renderer resolves an unknown path to an empty
     * string, which is right at send time and lethal at definition time: a
     * typo like {{ custmer.name }} does not fail, it sends "Hi ," to a
     * customer and nothing anywhere reports it. This is the only moment
     * somebody who can fix it is looking.
     */
    await expect(templates.define(owner(), {
      code: "arrival_notice", name: "On the way", channel: "sms",
      body: "Hi {{ custmer.name }}, we are on the way.",
      variables: ["customer.name"],
    })).rejects.toThrow(/custmer\.name.*does not declare|does not declare.*custmer/is);
  });

  it("declares the placeholders for you when you do not", async () => {
    const made = await templates.define(owner(), {
      code: "arrival_notice", name: "On the way", channel: "sms",
      body: "{{ company }}: your technician is {{ eta }}.",
    });
    expect(made.variables).toEqual(["company", "eta"]);
  });

  it("allows a declared variable the body does not use yet", async () => {
    /** An operator mid-edit has one, and fighting them over it helps nobody. */
    const made = await templates.define(owner(), {
      code: "reminder", name: "Reminder", channel: "sms",
      body: "See you {{ when }}.", variables: ["when", "technician"],
    });
    expect(made.variables).toContain("technician");
  });

  it("refuses an email template with no subject, and a text with one", async () => {
    /**
     * Two directions of the same mistake. An email arriving with an empty
     * subject is the strongest spam signal a sender can produce; a subject on
     * a text is a field nobody will ever see and the operator who typed it
     * will believe it went out.
     */
    await expect(templates.define(owner(), {
      code: "receipt", name: "Receipt", channel: "email", body: "Thanks.",
    })).rejects.toThrow(/subject/i);

    await expect(templates.define(owner(), {
      code: "note", name: "Note", channel: "sms", subject: "Hello", body: "Thanks.",
    })).rejects.toThrow(/no subject line/i);
  });

  it("refuses a second template under one code", async () => {
    await templates.define(owner(), { code: "arrival_notice", name: "A", channel: "sms", body: "x" });
    await expect(templates.define(owner(), {
      code: "arrival_notice", name: "B", channel: "sms", body: "y",
    })).rejects.toThrow(/already a template/i);
  });

  it("refuses a rename of the code, because services name it by that string", async () => {
    const made = await templates.define(owner(), {
      code: "arrival_notice", name: "A", channel: "sms", body: "x",
    });
    await expect(templates.update(owner(), { id: made.id, code: "arrival" }))
      .rejects.toThrow(/cannot be changed/i);
  });

  it("validates an edited body against the variables already stored", async () => {
    /**
     * A patch that changes the body and leaves `variables` alone has to be
     * checked against what is stored, or every edit that adds a placeholder
     * passes because the patch declared nothing to contradict it.
     */
    const made = await templates.define(owner(), {
      code: "arrival_notice", name: "A", channel: "sms",
      body: "Hi {{ company }}.",
    });
    const after = await templates.update(owner(), {
      id: made.id, body: "Hi {{ company }}, eta {{ eta }}.",
    });
    expect(after.variables).toEqual(["company", "eta"]);
  });

  it("refuses a definition from a role that can read settings and not change them", async () => {
    /**
     * `office_manager` RATHER THAN `technician`, and the difference is the
     * whole value of the test.
     *
     * A technician holds neither settings permission, so they are refused
     * whichever of the two this is guarded by: the first version of this
     * passed just as happily against a `settings:read` guard, which would
     * have let every office manager in the company rewrite what customers are
     * told. The role that holds exactly one of the pair is the only one that
     * can tell them apart.
     */
    await expect(templates.define(as(["office_manager"]), {
      code: "arrival_notice", name: "A", channel: "sms", body: "x",
    })).rejects.toThrow();

    /** And the same role can still read them, or this proved only that it is locked out. */
    await expect(templates.list(as(["office_manager"]))).resolves.toEqual([]);
  });
});

run("rendering one", () => {
  it("fills the placeholders and reports what it had nothing for", async () => {
    await templates.define(owner(), {
      code: "arrival_notice", name: "A", channel: "sms",
      body: "{{ company }}: your technician is {{ eta }}. {{ trackingUrl }}",
    });

    const rendered = await templates.preview(owner(), {
      code: "arrival_notice", scope: { company: "Ace Plumbing", eta: "about 20 minutes away" },
    });

    expect(rendered.body).toContain("Ace Plumbing");
    expect(rendered.body).toContain("about 20 minutes away");
    /** Reported rather than refused. The caller decides. */
    expect(rendered.missing).toEqual(["trackingUrl"]);
  });

  it("answers nothing for a company that has not written one", async () => {
    /**
     * The fallback is what makes this safe to add. Every company already
     * using this product has no templates, every caller has its own built in
     * wording, and nothing about their Tuesday changes.
     */
    const found = await templates.renderWithin(db(), ORG, "arrival_notice", {});
    expect(found).toBeNull();
  });

  it("answers nothing for one that has been turned off", async () => {
    const made = await templates.define(owner(), {
      code: "arrival_notice", name: "A", channel: "sms", body: "x",
    });
    await templates.update(owner(), { id: made.id, active: false });
    expect(await templates.renderWithin(db(), ORG, "arrival_notice", {})).toBeNull();
  });

  it("answers nothing for one that has been removed, even left active", async () => {
    /**
     * TWO SEPARATE FILTERS, AND THIS IS WHAT TELLS THEM APART.
     *
     * `remove` sets both `deleted_at` and `active: false`, so a test that
     * went through it proved only that one of the two filters works and
     * could not say which. Dropping the `deleted_at` filter from the lookup
     * changed nothing and no test noticed, which is the vacuous guard this
     * codebase treats as worse than none.
     *
     * The row is deleted behind the service with `active` left true, which
     * is reachable by a teardown, a migration, or any future delete path that
     * forgets the second column. The point of a soft delete is that it holds
     * whether or not somebody remembered the flag beside it.
     */
    const made = await templates.define(owner(), {
      code: "arrival_notice", name: "A", channel: "sms", body: "x",
    });
    await raw`
      update public.message_template set deleted_at = now()
      where id = ${made.id} and organization_id = ${ORG}`;

    expect(await templates.renderWithin(db(), ORG, "arrival_notice", {})).toBeNull();
  });
});

run("who the carriers think you are", () => {
  async function brand() {
    return registration.registerBrand(owner(), {
      legalName: "Ace Plumbing LLC", displayName: "Ace Plumbing", taxIdLast4: "1234",
    });
  }

  async function campaign(brandId: string, purpose: "transactional" | "marketing" = "transactional") {
    return registration.registerCampaign(owner(), {
      brandId, purpose, useCase: "Appointment reminders",
      optInDescription: "Customers tick a box on the booking form.",
      sampleMessages: ["Ace Plumbing: your technician is on the way."],
    });
  }

  it("refuses more than four digits of a tax id", async () => {
    /**
     * A full EIN here would be in every backup and every support export, to
     * answer a question nothing in this product asks. The carrier already has
     * it, because the operator gave it to them directly.
     */
    await expect(registration.registerBrand(owner(), {
      legalName: "Ace", displayName: "Ace", taxIdLast4: "123456789",
    })).rejects.toThrow(/last four/i);
  });

  it("refuses a campaign with no opt in language or no samples", async () => {
    const made = await brand();
    await expect(registration.registerCampaign(owner(), {
      brandId: made.id, purpose: "transactional", useCase: "Reminders",
      optInDescription: "", sampleMessages: ["x"],
    })).rejects.toThrow(/opt in language/i);

    await expect(registration.registerCampaign(owner(), {
      brandId: made.id, purpose: "transactional", useCase: "Reminders",
      optInDescription: "A box on the form.", sampleMessages: [],
    })).rejects.toThrow(/sample message/i);
  });

  it("refuses two campaigns for one purpose on one brand", async () => {
    const made = await brand();
    await campaign(made.id);
    await expect(campaign(made.id)).rejects.toThrow(/already has a transactional/i);
  });

  it("refuses a status move the registration cannot make", async () => {
    /**
     * A status that can go anywhere is one nobody can reason about: an
     * approved campaign dropping back to not_started because a settings
     * screen posted a default would stop a company's texts with no record of
     * a rejection anywhere.
     */
    const made = await brand();
    await expect(registration.setBrandStatus(owner(), { id: made.id, status: "approved" }))
      .rejects.toThrow(/cannot go from "not_started" to "approved"/i);
  });

  it("refuses a rejection with no reason from the carrier", async () => {
    const made = await brand();
    await registration.setBrandStatus(owner(), { id: made.id, status: "submitted" });
    await expect(registration.setBrandStatus(owner(), { id: made.id, status: "rejected" }))
      .rejects.toThrow(/what the carrier said/i);
  });
});

run("the gate, and why it stays shut until you open it", () => {
  it("says nothing at all for a company that tracks no registration", async () => {
    /**
     * THE OUTAGE THIS AVOIDS. Every company already using this sends texts
     * today with nothing in these tables. A hard check would stop all of
     * their messaging at once, for a registration they may well hold in their
     * carrier's portal and simply never have written down here. That is an
     * outage caused by a record keeping feature.
     */
    expect(await registration.purposeBlocked(db(), ORG, "transactional")).toBeNull();
    expect(await registration.purposeBlocked(db(), ORG, "marketing")).toBeNull();
  });

  it("blocks a purpose with no campaign once a brand is recorded", async () => {
    /** Recording a brand is the act of opting in to being told. */
    await registration.registerBrand(owner(), { legalName: "Ace LLC", displayName: "Ace" });

    const blocked = await registration.purposeBlocked(db(), ORG, "marketing");
    expect(blocked).toMatch(/no marketing campaign is registered/i);
  });

  it("lets an approved purpose through and names the carrier's reason otherwise", async () => {
    const made = await registration.registerBrand(owner(), {
      legalName: "Ace LLC", displayName: "Ace",
    });
    const camp = await registration.registerCampaign(owner(), {
      brandId: made.id, purpose: "transactional", useCase: "Reminders",
      optInDescription: "A box on the booking form.",
      sampleMessages: ["Your technician is on the way."],
    });

    await registration.setCampaignStatus(owner(), { id: camp.id, status: "submitted" });
    expect(await registration.purposeBlocked(db(), ORG, "transactional")).toMatch(/submitted/);

    await registration.setCampaignStatus(owner(), { id: camp.id, status: "approved" });
    expect(await registration.purposeBlocked(db(), ORG, "transactional")).toBeNull();

    await registration.setCampaignStatus(owner(), {
      id: camp.id, status: "suspended", reason: "Traffic did not match the samples",
    });
    expect(await registration.purposeBlocked(db(), ORG, "transactional"))
      .toMatch(/did not match the samples/i);
  });
});
