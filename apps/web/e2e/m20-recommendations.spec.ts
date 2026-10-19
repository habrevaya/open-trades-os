import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";

/**
 * A FACEBOOK RECOMMENDATION IS NOT STARS (M20)
 *
 * The reviews screen shows the star average over star reviews only, the share
 * who recommend beside it, and a recommendation in the queue as a yes or a no
 * rather than a row of stars. The Graph API reading and the averages are pinned
 * against the database in the integration tests; this is what a person sees.
 */
test("the reviews screen shows the share who recommend apart from the star average, and a recommendation as a yes or a no", async ({ owner }) => {
  const tag = `reco-${run}`;
  const policy = await owner.request.put("/api/v1/reviews/policy", { data: { timeZone: "America/Chicago" } });
  expect(policy.ok(), await policy.text()).toBe(true);

  const post = async (data: Record<string, unknown>) => {
    const made = await owner.request.post("/api/v1/reviews", { data: { postedAt: new Date().toISOString(), ...data } });
    expect(made.ok(), await made.text()).toBe(true);
    return (await made.json()) as { kind: string; rating: number | null; recommends: boolean | null; recoveryOwed: boolean };
  };
  const db = createClient();
  try {
    expect(await post({ platform: "google", externalId: `${tag}-g1`, rating: 5, authorName: `Gina ${run}`, body: "Quick and tidy." }))
      .toMatchObject({ kind: "stars", rating: 5, recommends: null });
    expect(await post({ platform: "facebook", externalId: `${tag}-f1`, recommends: true, authorName: `Yara ${run}`, body: "Recommends you on Facebook." }))
      .toMatchObject({ kind: "recommendation", rating: null, recommends: true, recoveryOwed: false });
    expect(await post({ platform: "facebook", externalId: `${tag}-f2`, recommends: false, authorName: `Nate ${run}`, body: `Never showed up ${run}` }))
      .toMatchObject({ kind: "recommendation", rating: null, recommends: false, recoveryOwed: true });
    // Both at once is refused in words.
    const both = await owner.request.post("/api/v1/reviews", { data: { platform: "facebook", rating: 5, recommends: true, postedAt: new Date().toISOString() } });
    expect(both.ok()).toBe(false);
    expect(await both.text()).toContain("has no rating");

    const figures = (await (await owner.request.get("/api/v1/reviews/rating")).json()) as {
      count: number; mean: number;
      recommendations: { count: number; recommend: number; doNot: number; share: number };
    };
    expect(figures.recommendations.count).toBeGreaterThanOrEqual(2);

    await owner.goto("/reviews");
    const recs = owner.getByLabel("Recommendations");
    await expect(recs).toContainText(`Recommend you, of ${figures.recommendations.count}`);
    await expect(recs).toContainText(`${Math.round(figures.recommendations.share * 100)}%`);
    await expect(recs).toContainText(`${figures.recommendations.recommend} said yes and ${figures.recommendations.doNot} said no.`);
    await expect(recs).toContainText("never added to the star average");
    // The star average is over the star reviews alone.
    await expect(owner.getByLabel("Star ratings")).toContainText(`Average of ${figures.count}`);
    await expect(owner.getByLabel("Star ratings")).toContainText(figures.mean.toFixed(2));

    // In the queue a recommendation is a yes or a no, not stars, and a no owes a call.
    const refused = owner.getByRole("listitem").filter({ hasText: `Never showed up ${run}` });
    await expect(refused).toContainText("Does not recommend you");
    await expect(refused).toContainText("Call owed");
    await expect(refused).not.toContainText("★");
    const thanked = owner.getByRole("listitem").filter({ hasText: `Yara ${run}` });
    await expect(thanked).toContainText("Recommends you");
    await expect(thanked).not.toContainText("☆");
    await expect(owner.getByRole("listitem").filter({ hasText: `Gina ${run}` })).toContainText("★★★★★");
  } finally {
    await db.execute(sql`delete from public.review where external_id like ${`${tag}-%`}`);
    await db.$close();
  }
});
