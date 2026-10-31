import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";

/**
 * GOING BACK TO THE TRADE PACK'S ACCOUNT PAGE, ON THE SCREEN
 *
 * The office gives a block a heading of its own, sees the way back to its trade
 * pack's page, is refused until it ticks that it understands what is replaced,
 * and then has the pack's page again with no heading of its own left.
 */
test("an arranged account page goes back to the trade pack's", async ({ owner }) => {
  const db = createClient();
  const [started] = await db.execute<{ now: string }>(sql`select now()::text as now`);
  const heading = `Our plan ${run}`;

  try {
    const current = (await (await owner.request.get("/api/v1/portal-layout")).json()) as {
      blocks: { kind: string; customTitle: string | null; visible: boolean }[];
    };
    const arranged = current.blocks.map((b) => ({
      kind: b.kind, visible: b.visible, title: b.kind === "next_visit" ? heading : b.customTitle,
    }));
    const saved = await owner.request.put("/api/v1/portal-layout", { data: { blocks: arranged } });
    expect(saved.ok(), await saved.text()).toBe(true);

    await owner.goto("/settings/portal/layout");
    await expect(owner.getByLabel("Heading for Coming up")).toHaveValue(heading);
    const back = owner.getByRole("region", { name: "Go back to your trade pack's page" });
    await expect(back).toContainText("What you arranged is replaced and cannot be brought back from here.");

    // Not without the tick.
    await back.getByRole("button", { name: "Go back to the pack's layout" }).click();
    await expect(back.getByRole("alert")).toContainText("Tick the box to say you want your arrangement replaced");
    expect(((await (await owner.request.get("/api/v1/portal-layout")).json()) as { changed: boolean }).changed).toBe(true);

    await back.getByLabel("Yes, replace what I arranged").check();
    await back.getByRole("button", { name: "Go back to the pack's layout" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Customers see the page your trade pack sets up" })).toBeVisible();

    await owner.reload();
    await expect(owner.getByLabel("Heading for Coming up")).not.toHaveValue(heading);
    await expect(owner.getByRole("region", { name: "Go back to your trade pack's page" })).toHaveCount(0);
    const after = (await (await owner.request.get("/api/v1/portal-layout")).json()) as { changed: boolean; goBackTo: string | null };
    expect(after).toMatchObject({ changed: false, goBackTo: null });
  } finally {
    /** The pack's layout this made, if there was none before, is taken away so other specs start from what they expect. */
    await db.execute(sql`
      delete from public.portal_layout
      where organization_id = (select id from public.organization where slug = 'ridgeline')
        and agreement_plan_id is null and created_at >= ${started!.now}::timestamptz`);
  }
});
