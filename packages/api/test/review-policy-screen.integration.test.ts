import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, reviews as rv, type Actor } from "@opentradesos/core";
import * as reviews from "../src/services/reviews";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { getReviewPolicy } from "../src/contracts/reviews";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE REVIEW POLICY, READ BACK FOR ITS SCREEN
 *
 * The policy was write only: `PUT /v1/reviews/policy` and nothing to read it
 * with, so a screen could not show what was set. It is read now, null until
 * somebody sets one; a field left out is stored as the starting point the
 * screen shows; and a time zone the runtime does not know is refused when it
 * is saved, not on the first deadline worked out from it.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("review-policy-screen:org");
const USER = fixtureId("review-policy-screen:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[], grants: string[] = []): ServiceContext => ({
  actor: {
    userId: USER, organizationId: ORG, roles: roles as Actor["roles"],
    ...(grants.length > 0 ? { grants: grants as NonNullable<Actor["grants"]> } : {}),
  },
  db: db(),
});
const owner = () => as(["owner"]);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Policy Screen Co", slug: "review-policy-screen-co" });
});
afterAll(async () => { if (raw) await raw.end(); });

run("the review policy, for its screen", () => {
  it("is null until set, then reads back what was stored, with the starting point for what was left out", async () => {
    expect(await reviews.currentPolicy(owner())).toBeNull();
    await reviews.setPolicy(owner(), { timeZone: "America/Chicago", customerCooldownDays: 60, businessDays: [1, 2, 3, 4, 5, 6] });

    const policy = await reviews.currentPolicy(owner());
    const start = reviews.POLICY_STARTING_POINT;
    expect(policy).toMatchObject({
      timeZone: "America/Chicago", customerCooldownDays: 60, businessDays: [1, 2, 3, 4, 5, 6],
      delayMinutes: start.delayMinutes, maxJobAgeDays: start.maxJobAgeDays, earliestHour: start.earliestHour,
      latestHour: start.latestHour, openHour: start.openHour, closeHour: start.closeHour, halfLifeDays: start.halfLifeDays,
      requirePaid: start.requirePaid,
    });
    expect(policy!.bands).toEqual(rv.DEFAULT_RESPONSE_BANDS);
    expect(() => getReviewPolicy.output.parse({ policy })).not.toThrow();
  });

  it("keeps the reminder and its words when the policy is saved again", async () => {
    await reviews.setReminders(owner(), {
      afterDays: 7,
      wording: {
        sms: "Hi {{ customer.name }}: {{ review.url }}",
        emailSubject: "From {{ organization.name }}",
        emailBody: "Hi {{ customer.name }}, {{ review.url }}",
      },
    });
    await reviews.setPolicy(owner(), { timeZone: "America/Chicago", customerCooldownDays: 30 });
    const view = await reviews.reminders(owner());
    expect(view.afterDays).toBe(7);
    expect(view.wording).toMatchObject({ sms: "Hi {{ customer.name }}: {{ review.url }}", custom: true });
  });

  it("refuses a time zone the runtime does not know, and bands that leave a rating out", async () => {
    await expect(reviews.setPolicy(owner(), { timeZone: "America/Springfield" }))
      .rejects.toThrow('"America/Springfield" is not a time zone.');
    await expect(reviews.setPolicy(owner(), {
      timeZone: "America/Chicago",
      bands: [{ upToRating: 3, withinHours: 4, businessHoursOnly: true, priority: 1, reason: "Low ones fast." }],
    })).rejects.toBeInstanceOf(ConflictError);
  });

  it("is read with settings:read and set with settings:write", async () => {
    await expect(reviews.currentPolicy(as([], ["review:respond"]))).rejects.toBeInstanceOf(PermissionError);
    expect(await reviews.currentPolicy(as([], ["settings:read"]))).not.toBeNull();
    await expect(reviews.setPolicy(as([], ["settings:read"]), { timeZone: "America/Chicago" }))
      .rejects.toBeInstanceOf(PermissionError);
  });
});
