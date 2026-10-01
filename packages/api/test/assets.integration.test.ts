import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { type Actor, assets as core, time } from "@opentradesos/core";
import * as assets from "../src/services/assets";
import * as crews from "../src/services/crews";
import { assetRoutes } from "../src/contracts/assets";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * FLEET, TOOLS AND COMPANY ASSETS
 *
 * `packages/core/src/assets/index.ts` has always known what to do about a
 * company's own kit and has never had anywhere to keep it. The properties
 * this file is about, in the order they cost money:
 *
 *   CUSTODY IS A HISTORY AND TWO PEOPLE CANNOT HOLD ONE THING. The overlap is
 *   refused loudly with both assignments named, because the fix is two
 *   seconds today and a thirty thousand dollar argument the week somebody
 *   resigns.
 *
 *   A METER DOES NOT RUN BACKWARDS AND DOES NOT JUMP. A technician typing
 *   48122 for 4812 pushes the next service out by a century, and after that
 *   every honest reading is refused for the wrong reason.
 *
 *   A PROJECTION SAYS IT IS A PROJECTION. An asset nobody has read for six
 *   weeks gets a sentence, not a date.
 *
 *   AN EXPIRED CALIBRATION REACHES BACKWARDS into reports already invoiced,
 *   and is the only one of the four that does.
 *
 *   A CREW CARRYING A GROUNDED CHIPPER IS AS STUCK AS A CREW WITH NO CHIPPER,
 *   and before the register existed that was invisible.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("assets:org");
const USER = fixtureId("assets:user");

let raw: postgres.Sql;
const db = () => testDb(url!);

const ctxFor = (role: Actor["roles"][number]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: [role] as Actor["roles"] }, db: db(),
});
const owner = () => ctxFor("owner");
/**
 * THE TWO ROLES THAT CAN TELL THE THREE PERMISSIONS APART.
 *
 * A test that used a role holding none of them would prove only that some
 * permission is checked, and would pass just as happily if every function
 * here were guarded by the same one. These two are preset roles, not invented
 * actors, and the splits are already in `core/src/access/roles.ts`:
 *
 *   dispatcher  asset:read.                   NOT write, NOT checkout.
 *   technician  asset:read and asset:checkout. NOT write.
 *
 * So dispatcher separates read from both of the others, and technician
 * separates checkout from write. Every pair is distinguished by a role that
 * genuinely holds one side of it.
 */
const dispatcher = () => ctxFor("dispatcher");
const tech = () => ctxFor("technician");

/** Today in the company's zone, which is what the service uses when asked for none. */
const TODAY = time.dateIn(new Date(), "America/Chicago");
const daysAgo = (n: number): string => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const daysAhead = (n: number): string => daysAgo(-n);

let technicianId = "";
let otherTechnicianId = "";
let locationId = "";
let jobId = "";
let customerId = "";
let propertyId = "";

async function technicianRow(key: string, name: string, active = true): Promise<string> {
  const userId = fixtureId(`assets:tech:${key}`);
  await raw`insert into public."user" (id, email) values (${userId}, ${`assets-${key}@test.local`})
            on conflict (id) do nothing`;
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name, active)
    values (${ORG}, ${m!.id}, ${name}, ${active}) returning id`;
  return t!.id;
}

async function fixtures(): Promise<void> {
  technicianId = await technicianRow("ana", "Ana");
  otherTechnicianId = await technicianRow("ben", "Ben");

  const [loc] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name) values (${ORG}, 'The yard') returning id`;
  locationId = loc!.id;

  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name)
    values (${ORG}, 'residential', 'Asset Customer') returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '4 Yard Road', 'Austin', 'TX', '78701') returning id`;
  propertyId = property!.id;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, 1, ${customerId}, ${propertyId}, 'scheduled', 'Take the tree down')
    returning id`;
  jobId = job!.id;
}

/** A chipper: a powered tool, metered in hours, that a tree crew needs. */
const chipper = (over: Partial<assets.AssetInput> = {}) => assets.registerAsset(owner(), {
  kind: "powered_tool", label: "Chipper 2", requirementCode: "chipper",
  identifier: "CH-002", ...over,
});
/** A van: miles, and the only kind that can be legally forbidden the yard. */
const van = (over: Partial<assets.AssetInput> = {}) => assets.registerAsset(owner(), {
  kind: "vehicle", label: "Van 14", identifier: "VIN14", ...over,
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Asset Co", slug: "asset-co" });
  await fixtures();
});

/* ===================================================== the vocabulary agrees */

describe("the register's vocabulary", () => {
  /**
   * The same argument `vocabulary.test.ts` makes about party roles. The kinds
   * exist twice by necessity: once as a Postgres enum, because the column has
   * to be constrained, and once in core, because the meaning lives there and
   * the database cannot hold it. A kind in one and not the other is a screen
   * offering an option every save rejects, or a raw value rendered beside a
   * label that does not exist. Neither is a type error.
   */
  it("is the same six kinds in core and in the database", async () => {
    const { schema } = await import("@opentradesos/db");
    expect([...core.ASSET_KINDS].sort()).toEqual([...schema.assetKind.enumValues].sort());
  });

  it("is the same meter units, compliance kinds and cost kinds", async () => {
    const { schema } = await import("@opentradesos/db");
    expect(Object.keys(core.METER_UNITS).sort())
      .toEqual([...schema.assetMeterUnit.enumValues].sort());
    expect(Object.keys(core.COMPLIANCE).sort())
      .toEqual([...schema.assetComplianceKind.enumValues].sort());
    expect([...core.ASSET_COST_KINDS].sort())
      .toEqual([...schema.assetCostKind.enumValues].sort());
  });
});

/* ============================================================== permissions */

run("who may do what", () => {
  it("lets a dispatcher read the register", async () => {
    await chipper();
    const { assets: rows } = await assets.listAssets(dispatcher(), {});
    expect(rows.map((r) => r.label)).toEqual(["Chipper 2"]);
  });

  it("refuses a dispatcher the register itself: reading is not writing", async () => {
    /**
     * The dispatcher preset holds `asset:read` and not `asset:write`, so this
     * separates the two. A role holding neither could not tell them apart and
     * would pass with both guards set to the same string.
     */
    await expect(chipperAs(dispatcher())).rejects.toThrow(/asset:write/);
  });

  it("refuses a dispatcher the custody of anything: reading is not checking out", async () => {
    const asset = await chipper();
    await expect(assets.checkOut(dispatcher(), {
      assetId: asset.id, custodianKind: "technician", custodianId: technicianId,
    })).rejects.toThrow(/asset:checkout/);
  });

  it("lets a technician check a tool out, holding checkout and not write", async () => {
    const asset = await chipper();
    const row = await assets.checkOut(tech(), {
      assetId: asset.id, custodianKind: "technician", custodianId: technicianId,
    });
    expect(row.custodianId).toBe(technicianId);
  });

  it("refuses a technician the register: checking out is not managing the fleet", async () => {
    /**
     * The technician preset holds `asset:checkout` and `asset:read` and NOT
     * `asset:write`. This is the pair the catalogue's third name exists for:
     * somebody who can take the core drill and cannot add a van to the fleet
     * or move an inspection date.
     */
    await expect(chipperAs(tech())).rejects.toThrow(/asset:write/);
    const asset = await chipper();
    await expect(assets.recordReading(tech(), { assetId: asset.id, value: 10 }))
      .rejects.toThrow(/asset:write/);
    await expect(assets.setObligation(tech(), {
      assetId: asset.id, kind: "inspection", expiresOn: daysAhead(30),
    })).rejects.toThrow(/asset:write/);
  });
});

const chipperAs = (ctx: ServiceContext) => assets.registerAsset(ctx, {
  kind: "powered_tool", label: "Chipper 9", requirementCode: "chipper",
});

/* ============================================================== the register */

run("putting something on the register", () => {
  it("needs a label", async () => {
    await expect(chipper({ label: "   " })).rejects.toThrow(/needs a label/);
  });

  it("takes the meter from the kind when none is given", async () => {
    expect((await chipper()).meterUnit).toBe("hours");
    expect((await van()).meterUnit).toBe("miles");
  });

  it("refuses a meter on a kind that has none", async () => {
    /**
     * A trailer has no engine and a thermal imager has no odometer. A reading
     * against either is a reading taken from some other machine, and this is
     * the only moment it can be stopped.
     */
    await expect(assets.registerAsset(owner(), {
      kind: "trailer", label: "Chip trailer", meterUnit: "hours",
    })).rejects.toThrow(/has no meter/);
  });

  it("takes a trailer with no meter at all", async () => {
    const trailer = await assets.registerAsset(owner(), { kind: "trailer", label: "Chip trailer" });
    expect(trailer.meterUnit).toBeNull();
  });

  it("refuses a quantity on a kind tracked one unit at a time", async () => {
    /**
     * Twenty core drills are twenty records, because any one of them can be
     * the one that does not come back and a count of twenty cannot say which.
     */
    await expect(chipper({ quantity: 3 })).rejects.toThrow(/tracked one unit at a time/);
  });

  it("takes a quantity on a kind that is counted rather than serialised", async () => {
    const box = await assets.registerAsset(owner(), {
      kind: "hand_tool", label: "Screwdrivers", quantity: 40,
    });
    expect(box.quantity).toBe(40);
  });

  it("refuses a quantity of none", async () => {
    await expect(assets.registerAsset(owner(), {
      kind: "hand_tool", label: "Screwdrivers", quantity: 0,
    })).rejects.toThrow(/quantity of none/);
  });

  it("refuses a daily ceiling on something with no meter", async () => {
    await expect(assets.registerAsset(owner(), {
      kind: "trailer", label: "Chip trailer", meterMaxPerDay: 10,
    })).rejects.toThrow(/needs a meter/);
  });

  it("refuses a daily ceiling of zero, which refuses every real reading", async () => {
    await expect(chipper({ meterMaxPerDay: 0 })).rejects.toThrow(/ceiling of zero/);
  });

  it("refuses two rows for one serial number", async () => {
    await chipper();
    await expect(chipper({ label: "Chipper 2 again" }))
      .rejects.toThrow(/company_asset_identifier_idx|duplicate key/);
  });
});

run("correcting the register", () => {
  it("needs a label to still be a label", async () => {
    const asset = await chipper();
    await expect(assets.updateAsset(owner(), { id: asset.id, label: "  " }))
      .rejects.toThrow(/needs a label/);
  });

  it("refuses a daily ceiling added to something with no meter", async () => {
    const trailer = await assets.registerAsset(owner(), { kind: "trailer", label: "Chip trailer" });
    await expect(assets.updateAsset(owner(), { id: trailer.id, meterMaxPerDay: 20 }))
      .rejects.toThrow(/has none/);
  });

  it("changes the requirement code a crew matches on", async () => {
    const asset = await chipper({ requirementCode: null });
    const after = await assets.updateAsset(owner(), { id: asset.id, requirementCode: " chipper " });
    expect(after.requirementCode).toBe("chipper");
  });
});

run("retiring something", () => {
  it("refuses while somebody still has it", async () => {
    /**
     * THE MODULE'S OWN REASON FOR EXISTING, as a guard. Retiring an asset
     * that is open in a technician's custody takes it off every list while it
     * is still in their truck, which is precisely how thirty thousand dollars
     * of tools stops being anybody's problem.
     */
    const asset = await chipper();
    await assets.checkOut(owner(), {
      assetId: asset.id, custodianKind: "technician", custodianId: technicianId,
    });
    await expect(assets.retireAsset(owner(), { id: asset.id }))
      .rejects.toThrow(/still out with technician/);
  });

  it("allows it once it is back", async () => {
    const asset = await chipper();
    await assets.checkOut(owner(), {
      assetId: asset.id, custodianKind: "technician", custodianId: technicianId, on: daysAgo(5),
    });
    await assets.checkIn(owner(), { assetId: asset.id, on: daysAgo(1) });
    const retired = await assets.retireAsset(owner(), { id: asset.id, retiredOn: TODAY });
    expect(retired.retiredOn).toBe(TODAY);
  });

  it("refuses to retire the same thing twice", async () => {
    const asset = await chipper();
    await assets.retireAsset(owner(), { id: asset.id });
    await expect(assets.retireAsset(owner(), { id: asset.id }))
      .rejects.toThrow(/already retired/);
  });

  it("keeps the row, and its readings, because the history outlives the van", async () => {
    const asset = await van();
    await assets.recordReading(owner(), { assetId: asset.id, value: 84_000, takenOn: daysAgo(3) });
    await assets.retireAsset(owner(), { id: asset.id });

    const listed = await assets.listAssets(owner(), { includeRetired: true });
    expect(listed.assets.find((a) => a.id === asset.id)?.retired).toBe(true);
    const back = await assets.readings(owner(), { assetId: asset.id });
    expect(back.readings).toHaveLength(1);
  });

  it("leaves a retired asset off the register by default", async () => {
    const asset = await chipper();
    await assets.retireAsset(owner(), { id: asset.id });
    expect((await assets.listAssets(owner(), {})).assets).toEqual([]);
  });
});

/* ================================================================== custody */

run("who has the core drill", () => {
  it("refuses a second custodian while the first still has it", async () => {
    /**
     * THE DEFECT THE WHOLE CUSTODY DESIGN EXISTS FOR. Somebody hands the core
     * drill on at a site and mentions it to the office, and nobody closes the
     * first assignment. With a mutable holder column the second write silently
     * wins and the first custodian is forgotten.
     */
    const asset = await chipper();
    await assets.checkOut(owner(), {
      assetId: asset.id, custodianKind: "technician", custodianId: technicianId, on: daysAgo(10),
    });
    await expect(assets.checkOut(owner(), {
      assetId: asset.id, custodianKind: "technician", custodianId: otherTechnicianId, on: daysAgo(2),
    })).rejects.toThrow(/One thing cannot be in two places/);
  });

  it("refuses a backdated check out landing inside somebody else's period", async () => {
    const asset = await chipper();
    await assets.checkOut(owner(), {
      assetId: asset.id, custodianKind: "technician", custodianId: technicianId, on: daysAgo(10),
    });
    await assets.checkIn(owner(), { assetId: asset.id, on: daysAgo(4) });
    await expect(assets.checkOut(owner(), {
      assetId: asset.id, custodianKind: "technician", custodianId: otherTechnicianId, on: daysAgo(6),
    })).rejects.toThrow(/One thing cannot be in two places/);
  });

  it("takes a clean handover on the same day, because the period is half open", async () => {
    const asset = await chipper();
    await assets.checkOut(owner(), {
      assetId: asset.id, custodianKind: "technician", custodianId: technicianId, on: daysAgo(10),
    });
    await assets.checkIn(owner(), { assetId: asset.id, on: daysAgo(4) });
    await assets.checkOut(owner(), {
      assetId: asset.id, custodianKind: "technician", custodianId: otherTechnicianId, on: daysAgo(4),
    });

    /** Exactly one person on the day of the handover, and it is the new one. */
    const at = await assets.custodyOf(owner(), { assetId: asset.id, on: daysAgo(4) });
    expect(at.heldBy?.custodianId).toBe(otherTechnicianId);
    const before = await assets.custodyOf(owner(), { assetId: asset.id, on: daysAgo(5) });
    expect(before.heldBy?.custodianId).toBe(technicianId);
  });

  it("refuses a check in with nothing out", async () => {
    const asset = await chipper();
    await expect(assets.checkIn(owner(), { assetId: asset.id }))
      .rejects.toThrow(/nothing to check in/);
  });

  it("refuses a check in dated before the check out", async () => {
    const asset = await chipper();
    await assets.checkOut(owner(), {
      assetId: asset.id, custodianKind: "technician", custodianId: technicianId, on: daysAgo(3),
    });
    await expect(assets.checkIn(owner(), { assetId: asset.id, on: daysAgo(9) }))
      .rejects.toThrow(/which is backwards/);
  });

  it("refuses handing something to a custodian who does not exist here", async () => {
    const asset = await chipper();
    await expect(assets.checkOut(owner(), {
      assetId: asset.id, custodianKind: "technician", custodianId: fixtureId("assets:nobody"),
    })).rejects.toThrow(/not an active technician/);
  });

  it("refuses a technician id recorded as a place", async () => {
    /**
     * `custodian_id` is polymorphic so Postgres cannot check it. Without this,
     * a technician id under custodian_kind 'location' is a perfectly valid
     * row, the register says the chipper is at a yard that is actually a
     * person, and nothing ever disagrees.
     */
    const asset = await chipper();
    await expect(assets.checkOut(owner(), {
      assetId: asset.id, custodianKind: "location", custodianId: technicianId,
    })).rejects.toThrow(/not a location/);
  });

  it("refuses a technician who has left", async () => {
    const gone = await technicianRow("gone", "Departed", false);
    const asset = await chipper();
    await expect(assets.checkOut(owner(), {
      assetId: asset.id, custodianKind: "technician", custodianId: gone,
    })).rejects.toThrow(/not an active technician/);
  });

  it("puts a trailer at a place rather than in somebody's pocket", async () => {
    const trailer = await assets.registerAsset(owner(), { kind: "trailer", label: "Chip trailer" });
    await assets.checkOut(owner(), {
      assetId: trailer.id, custodianKind: "location", custodianId: locationId,
    });
    const at = await assets.custodyOf(owner(), { assetId: trailer.id });
    expect(at.heldBy).toEqual({
      custodianKind: "location", custodianId: locationId, since: TODAY,
    });
  });

  it("puts a machine on a job", async () => {
    const asset = await chipper();
    await assets.checkOut(owner(), {
      assetId: asset.id, custodianKind: "job", custodianId: jobId,
    });
    expect((await assets.custodyOf(owner(), { assetId: asset.id })).heldBy?.custodianId).toBe(jobId);
  });

  it("refuses a job that is not in this company", async () => {
    const asset = await chipper();
    await expect(assets.checkOut(owner(), {
      assetId: asset.id, custodianKind: "job", custodianId: fixtureId("assets:nojob"),
    })).rejects.toThrow(/not a job/);
  });

  it("refuses something retired", async () => {
    const asset = await chipper();
    await assets.retireAsset(owner(), { id: asset.id });
    await expect(assets.checkOut(owner(), {
      assetId: asset.id, custodianKind: "technician", custodianId: technicianId,
    })).rejects.toThrow(/does not have it to hand out/);
  });

  it("says nobody has it, and where it was last seen, rather than going blank", async () => {
    const asset = await chipper();
    await assets.checkOut(owner(), {
      assetId: asset.id, custodianKind: "technician", custodianId: technicianId, on: daysAgo(9),
    });
    await assets.checkIn(owner(), { assetId: asset.id, on: daysAgo(2) });
    const at = await assets.custodyOf(owner(), { assetId: asset.id });
    expect(at.held).toBe(false);
    expect(at.explanation).toContain("last with technician");
  });
});

run("handing something straight on", () => {
  it("closes the old period and opens the new one on the same day", async () => {
    const asset = await chipper();
    await assets.checkOut(owner(), {
      assetId: asset.id, custodianKind: "technician", custodianId: technicianId, on: daysAgo(10),
    });
    const result = await assets.handOver(owner(), {
      assetId: asset.id, custodianKind: "technician", custodianId: otherTechnicianId, on: daysAgo(3),
    });
    expect(result.on).toBe(daysAgo(3));

    const view = await assets.custodyOf(owner(), { assetId: asset.id, on: daysAgo(3) });
    expect(view.heldBy?.custodianId).toBe(otherTechnicianId);
    expect(view.history).toHaveLength(2);
    expect(view.history[0]?.until).toBe(daysAgo(3));
  });

  it("refuses a handover when nobody has it", async () => {
    const asset = await chipper();
    await expect(assets.handOver(owner(), {
      assetId: asset.id, custodianKind: "technician", custodianId: technicianId,
    })).rejects.toThrow(/nobody to hand it over from/);
  });

  it("refuses a handover to the person who already has it", async () => {
    /**
     * It closes a period and opens an identical one, which reads on the
     * record as a transfer that never happened and makes the history longer
     * without making it truer.
     */
    const asset = await chipper();
    await assets.checkOut(owner(), {
      assetId: asset.id, custodianKind: "technician", custodianId: technicianId,
    });
    await expect(assets.handOver(owner(), {
      assetId: asset.id, custodianKind: "technician", custodianId: technicianId,
    })).rejects.toThrow(/already with technician/);
  });

  it("refuses a handover dated before the period it is closing", async () => {
    const asset = await chipper();
    await assets.checkOut(owner(), {
      assetId: asset.id, custodianKind: "technician", custodianId: technicianId, on: daysAgo(2),
    });
    await expect(assets.handOver(owner(), {
      assetId: asset.id, custodianKind: "technician", custodianId: otherTechnicianId, on: daysAgo(8),
    })).rejects.toThrow(/backwards|two places/);
  });
});

run("what is in the departing technician's truck", () => {
  it("lists everything one person is holding today", async () => {
    const drill = await chipper();
    const imager = await assets.registerAsset(owner(), {
      kind: "instrument", label: "FLIR E8", identifier: "FL-1",
    });
    const trailer = await assets.registerAsset(owner(), { kind: "trailer", label: "Chip trailer" });

    for (const asset of [drill, imager]) {
      await assets.checkOut(owner(), {
        assetId: asset.id, custodianKind: "technician", custodianId: technicianId, on: daysAgo(6),
      });
    }
    await assets.checkOut(owner(), {
      assetId: trailer.id, custodianKind: "location", custodianId: locationId, on: daysAgo(6),
    });

    const answer = await assets.heldBy(owner(), {
      custodianKind: "technician", custodianId: technicianId,
    });
    expect(answer.assets.map((a) => a.label).sort()).toEqual(["Chipper 2", "FLIR E8"]);
    expect(answer.assets[0]?.since).toBe(daysAgo(6));
    expect(answer.unreadable).toEqual([]);
  });

  it("leaves out what has already come back", async () => {
    const asset = await chipper();
    await assets.checkOut(owner(), {
      assetId: asset.id, custodianKind: "technician", custodianId: technicianId, on: daysAgo(6),
    });
    await assets.checkIn(owner(), { assetId: asset.id, on: daysAgo(1) });
    const answer = await assets.heldBy(owner(), {
      custodianKind: "technician", custodianId: technicianId,
    });
    expect(answer.assets).toEqual([]);
  });

  it("reports an asset whose history is broken rather than dropping it", async () => {
    /**
     * A broken record is exactly the one most likely to be missing. Written
     * straight to the table, because every path through the service refuses
     * to create this state, which is the point.
     */
    const asset = await chipper();
    await raw`insert into public.asset_custody
      (organization_id, asset_id, custodian_kind, custodian_id, held_from)
      values (${ORG}, ${asset.id}, 'technician', ${technicianId}, ${daysAgo(9)}),
             (${ORG}, ${asset.id}, 'technician', ${otherTechnicianId}, ${daysAgo(4)})`;

    const answer = await assets.heldBy(owner(), {
      custodianKind: "technician", custodianId: technicianId,
    });
    expect(answer.assets).toEqual([]);
    expect(answer.unreadable[0]?.explanation).toContain("One thing cannot be in two places");
  });

  it("does not blank the whole register for one broken history", async () => {
    const broken = await chipper();
    await van();
    await raw`insert into public.asset_custody
      (organization_id, asset_id, custodian_kind, custodian_id, held_from)
      values (${ORG}, ${broken.id}, 'technician', ${technicianId}, ${daysAgo(9)}),
             (${ORG}, ${broken.id}, 'technician', ${otherTechnicianId}, ${daysAgo(4)})`;

    const listed = await assets.listAssets(owner(), {});
    expect(listed.assets).toHaveLength(2);
    expect(listed.assets.find((a) => a.id === broken.id)?.heldBy).toBeNull();
    await expect(assets.custodyOf(owner(), { assetId: broken.id }))
      .rejects.toThrow(/One thing cannot be in two places/);
  });
});

/* ================================================================= readings */

run("what the meter said", () => {
  it("refuses a reading against something with no meter", async () => {
    const trailer = await assets.registerAsset(owner(), { kind: "trailer", label: "Chip trailer" });
    await expect(assets.recordReading(owner(), { assetId: trailer.id, value: 12 }))
      .rejects.toThrow(/has no meter/);
  });

  it("takes readings in order and reports the units since the last one", async () => {
    const asset = await chipper();
    await assets.recordReading(owner(), { assetId: asset.id, value: 400, takenOn: daysAgo(40) });
    const second = await assets.recordReading(owner(), {
      assetId: asset.id, value: 460, takenOn: daysAgo(20),
    });
    expect(second.unitsSincePrevious).toBe(60);
  });

  it("refuses a meter running backwards, and says how to record a replacement", async () => {
    const asset = await chipper();
    await assets.recordReading(owner(), { assetId: asset.id, value: 4812, takenOn: daysAgo(30) });
    await expect(assets.recordReading(owner(), {
      assetId: asset.id, value: 91, takenOn: daysAgo(29),
    })).rejects.toThrow(/A meter does not run backwards/);
  });

  it("takes a declared replacement and keeps the hours already run", async () => {
    /**
     * The gauge fails, is swapped, and the new one starts at zero. The
     * machine still has 4,812 hours on it. Inferring the reset from a
     * decrease throws all of them away: the 250 hour service quietly
     * restarts and the cost per hour halves overnight for no reason anybody
     * can find.
     */
    const asset = await chipper();
    await assets.recordReading(owner(), { assetId: asset.id, value: 4812, takenOn: daysAgo(40) });
    const swapped = await assets.recordReading(owner(), {
      assetId: asset.id, value: 36, takenOn: daysAgo(20),
      reset: { previousFinalValue: 4830, reason: "Gauge failed, replaced at the dealer" },
    });
    /** 18 on the old meter before it went, plus 36 on the new one since. */
    expect(swapped.unitsSincePrevious).toBe(54);
  });

  it("refuses a replacement that rewinds the old meter", async () => {
    const asset = await chipper();
    await assets.recordReading(owner(), { assetId: asset.id, value: 4812, takenOn: daysAgo(40) });
    await expect(assets.recordReading(owner(), {
      assetId: asset.id, value: 10, takenOn: daysAgo(20),
      reset: { previousFinalValue: 4000, reason: "Gauge failed" },
    })).rejects.toThrow(/old meter cannot have run backwards/);
  });

  it("refuses a replacement with no reason", async () => {
    const asset = await chipper();
    await assets.recordReading(owner(), { assetId: asset.id, value: 4812, takenOn: daysAgo(40) });
    await expect(assets.recordReading(owner(), {
      assetId: asset.id, value: 36, takenOn: daysAgo(20),
      reset: { previousFinalValue: 4830, reason: "  " },
    })).rejects.toThrow(/needs a reason/);
  });

  it("refuses a mistyped digit before it poisons every later reading", async () => {
    /**
     * 48122 for 4812 on a machine servicing every 250 hours pushes the next
     * service out by more than a century, and from that point every honest
     * reading looks like it goes backwards and is refused for the wrong
     * reason. The keyboard is the only cheap moment.
     */
    const asset = await chipper();
    await assets.recordReading(owner(), { assetId: asset.id, value: 4812, takenOn: daysAgo(30) });
    await expect(assets.recordReading(owner(), {
      assetId: asset.id, value: 48_122, takenOn: daysAgo(29),
    })).rejects.toThrow(/against a ceiling of 24/);
  });

  it("lets a machine that genuinely runs harder declare its own ceiling", async () => {
    /**
     * Not a loophole: core takes a `maxPerDay` override because a generator
     * on a storm job really does run around the clock, and with nowhere to
     * say so its honest readings are refused every day until people stop
     * entering them. A van is held to the same default as before.
     */
    const asset = await assets.registerAsset(owner(), {
      kind: "equipment", label: "Storm generator", identifier: "GEN-1", meterMaxPerDay: 48,
    });
    await assets.recordReading(owner(), { assetId: asset.id, value: 100, takenOn: daysAgo(10) });
    const pushed = await assets.recordReading(owner(), {
      assetId: asset.id, value: 460, takenOn: daysAgo(0),
    });
    expect(pushed.unitsSincePrevious).toBe(360);
  });

  it("holds an ordinary machine to the hours in a day", async () => {
    const asset = await chipper();
    await assets.recordReading(owner(), { assetId: asset.id, value: 100, takenOn: daysAgo(10) });
    await expect(assets.recordReading(owner(), { assetId: asset.id, value: 460, takenOn: daysAgo(0) }))
      .rejects.toThrow(/against a ceiling of 24/);
  });

  it("refuses a reading dated after today", async () => {
    const asset = await chipper();
    await expect(assets.recordReading(owner(), {
      assetId: asset.id, value: 10, takenOn: daysAhead(2),
    })).rejects.toThrow(/Check the date on the device/);
  });

  it("refuses a reading that arrives out of order", async () => {
    const asset = await chipper();
    await assets.recordReading(owner(), { assetId: asset.id, value: 400, takenOn: daysAgo(10) });
    await expect(assets.recordReading(owner(), {
      assetId: asset.id, value: 380, takenOn: daysAgo(20),
    })).rejects.toThrow(/Readings are accepted in order/);
  });

  it("refuses a fraction, because a fraction here later divides money", async () => {
    const asset = await chipper();
    await expect(assets.recordReading(owner(), { assetId: asset.id, value: 12.5 }))
      .rejects.toThrow(/Readings are whole units/);
  });

  it("reports usage bounded by the readings, not by the window asked for", async () => {
    const asset = await van();
    await assets.recordReading(owner(), { assetId: asset.id, value: 80_000, takenOn: daysAgo(40) });
    await assets.recordReading(owner(), { assetId: asset.id, value: 81_000, takenOn: daysAgo(10) });
    const back = await assets.readings(owner(), {
      assetId: asset.id, from: daysAgo(90), to: TODAY,
    });
    expect(back.usage?.units).toBe(1000);
    expect(back.usage?.observedDays).toBe(30);
  });

  it("refuses usage from one reading rather than calling it zero", async () => {
    const asset = await van();
    await assets.recordReading(owner(), { assetId: asset.id, value: 80_000, takenOn: daysAgo(10) });
    const back = await assets.readings(owner(), {
      assetId: asset.id, from: daysAgo(90), to: TODAY,
    });
    expect(back.usage?.ok).toBe(false);
    expect(back.usage?.explanation).toContain("one reading is not usage");
  });
});

/* ============================================================== maintenance */

run("what is due", () => {
  const withReadings = async (values: [number, number][]) => {
    const asset = await assets.registerAsset(owner(), {
      kind: "equipment", label: "Boom lift", identifier: "BL-1",
    });
    for (const [daysBack, value] of values) {
      await assets.recordReading(owner(), { assetId: asset.id, value, takenOn: daysAgo(daysBack) });
    }
    return asset;
  };

  it("refuses a meter interval on something with no meter", async () => {
    const trailer = await assets.registerAsset(owner(), { kind: "trailer", label: "Chip trailer" });
    await expect(assets.setPlan(owner(), {
      assetId: trailer.id, label: "250 hour service", basis: "meter", everyUnits: 250,
    })).rejects.toThrow(/has no meter/);
  });

  it("refuses a meter interval with no number of units", async () => {
    const asset = await chipper();
    await expect(assets.setPlan(owner(), {
      assetId: asset.id, label: "250 hour service", basis: "meter",
    })).rejects.toThrow(/nothing to count down/);
  });

  it("refuses a time interval with no schedule to produce a date from", async () => {
    const asset = await chipper();
    await expect(assets.setPlan(owner(), {
      assetId: asset.id, label: "Annual service", basis: "time",
    })).rejects.toThrow(/needs a recurrence model and a date/);
  });

  it("refuses a rule that would generate nothing at all", async () => {
    /**
     * A schedule that generates nothing looks identical on every screen to
     * one whose work is simply not due yet, forever.
     */
    const asset = await chipper();
    await expect(assets.setPlan(owner(), {
      assetId: asset.id, label: "Annual service", basis: "time",
      model: "rule", startsOn: daysAgo(400),
    })).rejects.toThrow(/generates nothing/);
  });

  it("refuses work counted from completion with no number of days", async () => {
    const asset = await chipper();
    await expect(assets.setPlan(owner(), {
      assetId: asset.id, label: "Service", basis: "time",
      model: "anchored_to_completion", startsOn: daysAgo(400),
    })).rejects.toThrow(/needs to know how many days/);
  });

  it("refuses a month that is not a month", async () => {
    const asset = await chipper();
    await expect(assets.setPlan(owner(), {
      assetId: asset.id, label: "Pre season service", basis: "time",
      model: "rule", startsOn: daysAgo(400), anchorMonths: [13],
    })).rejects.toThrow(/is not a month/);
  });

  it("refuses a schedule that ends before it starts", async () => {
    const asset = await chipper();
    await expect(assets.setPlan(owner(), {
      assetId: asset.id, label: "Service", basis: "time",
      model: "rule", startsOn: daysAgo(10), endsOn: daysAgo(40), intervalDays: 90,
    })).rejects.toThrow(/ends before it starts/);
  });

  it("refuses a task with no label to appear under", async () => {
    const asset = await chipper();
    await expect(assets.setPlan(owner(), {
      assetId: asset.id, label: "  ", basis: "meter", everyUnits: 250,
    })).rejects.toThrow(/needs a label/);
  });

  it("says a time interval is overdue rather than quietly offering the next one", async () => {
    /**
     * Asked from the last service rather than from today. Asking from today
     * returns the NEXT occurrence and hides an overdue service completely,
     * which is the most expensive way to be wrong here: the screen is calm
     * and the compressor is not.
     */
    const asset = await van();
    await assets.setPlan(owner(), {
      assetId: asset.id, label: "Annual inspection", basis: "time",
      model: "rule", startsOn: daysAgo(400), intervalDays: 180,
      lastServicedOn: daysAgo(370),
    });
    const board = await assets.maintenanceDue(owner(), { now: TODAY });
    const line = board.due[0]!;
    expect(line.status.basis).toBe("time");
    if (line.status.basis === "time" && line.status.state === "scheduled") {
      expect(line.status.overdue).toBe(true);
      expect(line.status.daysUntilDue).toBeLessThan(0);
    } else {
      throw new Error("expected a scheduled time status");
    }
  });

  it("says due now from the meter, and calls it a fact rather than a projection", async () => {
    const asset = await withReadings([[60, 1000], [30, 1200], [1, 1300]]);
    await assets.setPlan(owner(), {
      assetId: asset.id, label: "250 hour service", basis: "meter", everyUnits: 250,
      lastServicedOn: daysAgo(60),
    });
    const line = (await assets.maintenanceDue(owner(), { now: TODAY })).due[0]!;
    expect(line.status.state).toBe("due_now");
    if (line.status.state === "due_now") {
      expect(line.status.usedSinceService).toBe(300);
      expect(line.status.explanation).toContain("not a projection");
    }
  });

  it("projects a date and says how much to believe it", async () => {
    /**
     * Six readings spanning ninety days, which is what core calls "good". The
     * span is measured inside the rate window and the window is ninety days
     * back from the LATEST reading, so a seventh reading older than that adds
     * nothing: a rate averaged over the whole life of a machine tells you
     * about last year.
     */
    const asset = await withReadings([
      [92, 1000], [75, 1040], [55, 1080], [35, 1120], [20, 1160], [2, 1196],
    ]);
    await assets.setPlan(owner(), {
      assetId: asset.id, label: "250 hour service", basis: "meter", everyUnits: 250,
      lastServicedOn: daysAgo(92),
    });
    const line = (await assets.maintenanceDue(owner(), { now: TODAY })).due[0]!;
    expect(line.status.state).toBe("projected");
    if (line.status.state === "projected") {
      expect(line.status.confidence).toBe("good");
      expect(line.status.caveat).toContain("A projection, not a schedule");
      expect(line.status.dueOn > TODAY).toBe(true);
    }
  });

  it("refuses to project from readings nobody has taken for months", async () => {
    /**
     * An asset with no readings for months is not an asset with a known rate
     * of use. "Service due 14 March" reads identically whether it came from
     * telematics yesterday or from a technician in April, and only one is
     * worth acting on.
     */
    const asset = await withReadings([[200, 1000], [180, 1040], [120, 1100]]);
    await assets.setPlan(owner(), {
      assetId: asset.id, label: "250 hour service", basis: "meter", everyUnits: 250,
      lastServicedOn: daysAgo(200),
    });
    const line = (await assets.maintenanceDue(owner(), { now: TODAY })).due[0]!;
    expect(line.status.state).toBe("cannot_project");
    if (line.status.state === "cannot_project") {
      expect(line.status.reason).toBe("stale_readings");
    }
  });

  it("says nothing can be said when there are no readings at all", async () => {
    const asset = await assets.registerAsset(owner(), {
      kind: "equipment", label: "Boom lift", identifier: "BL-1",
    });
    await assets.setPlan(owner(), {
      assetId: asset.id, label: "250 hour service", basis: "meter", everyUnits: 250,
    });
    const line = (await assets.maintenanceDue(owner(), { now: TODAY })).due[0]!;
    if (line.status.state === "cannot_project") {
      expect(line.status.reason).toBe("no_readings");
    } else {
      throw new Error("expected cannot_project");
    }
  });

  it("leaves a retired asset's services off the worklist", async () => {
    /**
     * Nothing is going to happen to a sold van, and a worklist that keeps
     * offering it trains people to ignore the worklist.
     */
    const asset = await van();
    await assets.setPlan(owner(), {
      assetId: asset.id, label: "Annual inspection", basis: "time",
      model: "rule", startsOn: daysAgo(400), intervalDays: 180,
    });
    expect((await assets.maintenanceDue(owner(), { now: TODAY })).due).toHaveLength(1);
    await assets.retireAsset(owner(), { id: asset.id });
    expect((await assets.maintenanceDue(owner(), { now: TODAY })).due).toEqual([]);
  });

  it("refuses a completion dated in the future", async () => {
    const asset = await chipper();
    const plan = await assets.setPlan(owner(), {
      assetId: asset.id, label: "250 hour service", basis: "meter", everyUnits: 250,
    });
    await expect(assets.recordService(owner(), { planId: plan.id, servicedOn: daysAhead(3) }))
      .rejects.toThrow(/after today/);
  });

  it("refuses a backdated completion", async () => {
    /**
     * Both bases count from this date, so moving it backwards pulls a service
     * that has already happened back into the future and discards everything
     * counted since.
     */
    const asset = await chipper();
    const plan = await assets.setPlan(owner(), {
      assetId: asset.id, label: "250 hour service", basis: "meter", everyUnits: 250,
      lastServicedOn: daysAgo(10),
    });
    await expect(assets.recordService(owner(), { planId: plan.id, servicedOn: daysAgo(40) }))
      .rejects.toThrow(/Moving it backwards/);
  });

  it("records the day it was actually done", async () => {
    const asset = await chipper();
    const plan = await assets.setPlan(owner(), {
      assetId: asset.id, label: "250 hour service", basis: "meter", everyUnits: 250,
    });
    const after = await assets.recordService(owner(), { planId: plan.id, servicedOn: daysAgo(2) });
    expect(after.lastServicedOn).toBe(daysAgo(2));
  });
});

/* =============================================================== compliance */

run("what expires when", () => {
  it("orders by when action is needed, not by when the date falls", async () => {
    /**
     * A calibration needing six weeks of notice and expiring in fifty days is
     * more urgent than a registration needing thirty and expiring in forty. A
     * list sorted by expiry puts them the other way round and the instrument
     * goes out of certificate while the screen looks calm.
     */
    const imager = await assets.registerAsset(owner(), {
      kind: "instrument", label: "FLIR E8", identifier: "FL-1",
    });
    const vanRow = await van();
    await assets.setObligation(owner(), {
      assetId: imager.id, kind: "calibration", expiresOn: daysAhead(50),
    });
    await assets.setObligation(owner(), {
      assetId: vanRow.id, kind: "registration", expiresOn: daysAhead(40),
    });

    const outlook = await assets.complianceOutlook(owner(), { now: TODAY });
    expect(outlook.alerts.map((a) => a.kind)).toEqual(["calibration", "registration"]);
  });

  it("pulls a deadline backwards off a weekend and never forwards", async () => {
    /**
     * Every date here is a deadline and the counties, inspection stations and
     * calibration labs that clear them are shut at the weekend. Rolling a
     * renewal forward to Monday is renewing it after it expired: the van is
     * off the road on Monday morning either way.
     */
    const vanRow = await van();
    /** A Sunday, found rather than hard coded so the suite does not expire. */
    let expires = daysAhead(60);
    while (new Date(`${expires}T00:00:00Z`).getUTCDay() !== 0) {
      expires = new Date(new Date(`${expires}T00:00:00Z`).getTime() + 86_400_000)
        .toISOString().slice(0, 10);
    }
    await assets.setObligation(owner(), {
      assetId: vanRow.id, kind: "registration", expiresOn: expires,
    });

    const alert = (await assets.complianceOutlook(owner(), { now: TODAY })).alerts[0]!;
    expect(alert.movedOffAWeekend).toBe(true);
    expect(alert.lastUsableDay < expires).toBe(true);
    expect(new Date(`${alert.lastUsableDay}T00:00:00Z`).getUTCDay()).toBe(5);
  });

  it("says an expired calibration puts past reports in question", async () => {
    /**
     * THE EXPENSIVE CASE NOBODY THINKS ABOUT. The other three expiries stop
     * something happening tomorrow. This one reaches backwards: the
     * instrument has been drifting and there is no way to know from when, so
     * every report it produced since the last good certificate is open to
     * challenge, and those are the ones that went to insurers.
     */
    const imager = await assets.registerAsset(owner(), {
      kind: "instrument", label: "FLIR E8", identifier: "FL-1",
    });
    await assets.setObligation(owner(), {
      assetId: imager.id, kind: "calibration",
      expiresOn: daysAgo(30), lastCertifiedOn: daysAgo(395),
    });

    const alert = (await assets.complianceOutlook(owner(), { now: TODAY })).alerts[0]!;
    expect(alert.status).toBe("expired");
    expect(alert.workAtRiskSince).toBe(daysAgo(395));
    expect(alert.groundsTheAsset).toBe(false);
    expect(alert.explanation).toContain("open to challenge");
  });

  it("does not claim past work is at risk for the three that only look forward", async () => {
    const vanRow = await van();
    await assets.setObligation(owner(), {
      assetId: vanRow.id, kind: "inspection", expiresOn: daysAgo(10),
    });
    const alert = (await assets.complianceOutlook(owner(), { now: TODAY })).alerts[0]!;
    expect(alert.workAtRiskSince).toBeNull();
    expect(alert.groundsTheAsset).toBe(true);
    expect(alert.explanation).toContain("cannot be used until this is cleared");
  });

  it("refuses a certified date on an obligation that does not certify past work", async () => {
    const vanRow = await van();
    await expect(assets.setObligation(owner(), {
      assetId: vanRow.id, kind: "registration",
      expiresOn: daysAhead(30), lastCertifiedOn: daysAgo(300),
    })).rejects.toThrow(/does not certify past work/);
  });

  it("refuses a certificate issued after it expires", async () => {
    const imager = await assets.registerAsset(owner(), {
      kind: "instrument", label: "FLIR E8", identifier: "FL-1",
    });
    await expect(assets.setObligation(owner(), {
      assetId: imager.id, kind: "calibration",
      expiresOn: daysAhead(10), lastCertifiedOn: daysAhead(40),
    })).rejects.toThrow(/which is backwards/);
  });

  it("renews in place rather than leaving two rows that disagree", async () => {
    const vanRow = await van();
    await assets.setObligation(owner(), {
      assetId: vanRow.id, kind: "registration", expiresOn: daysAgo(5),
    });
    await assets.setObligation(owner(), {
      assetId: vanRow.id, kind: "registration", expiresOn: daysAhead(360), reference: "PLATE-1",
    });
    const outlook = await assets.complianceOutlook(owner(), { now: TODAY });
    const registrations = outlook.alerts.filter((a) => a.kind === "registration");
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.status).not.toBe("expired");
  });

  it("names the obligation a van has no record of at all", async () => {
    /**
     * A van with an EXPIRED inspection is loud. A van with NO inspection
     * record is silent, and it is the same van in the same yard with the same
     * problem. An outlook built only from the rows that exist cannot say so.
     */
    const vanRow = await van();
    await assets.setObligation(owner(), {
      assetId: vanRow.id, kind: "registration", expiresOn: daysAhead(300),
    });
    const outlook = await assets.complianceOutlook(owner(), { now: TODAY });
    expect(outlook.missing.map((m) => m.kind).sort()).toEqual(["inspection", "insurance"]);
    expect(outlook.missing[0]?.explanation).toContain("Van 14");
  });

  it("asks nothing of a kind core says carries no obligations", async () => {
    await chipper();
    const outlook = await assets.complianceOutlook(owner(), { now: TODAY });
    expect(outlook.missing).toEqual([]);
  });
});

/* ===================================================================== cost */

run("what it costs to keep", () => {
  it("keeps a purchase out of the running cost", async () => {
    /**
     * Folding them together makes the month a van was bought look like the
     * most expensive month in its life and every month after it look free,
     * and no comparison between two vans survives that.
     */
    const vanRow = await van();
    await assets.recordCost(owner(), {
      assetId: vanRow.id, kind: "acquisition", amount: "42000.00", incurredOn: daysAgo(100),
    });
    await assets.recordCost(owner(), {
      assetId: vanRow.id, kind: "fuel", amount: "600.00", incurredOn: daysAgo(50),
    });
    const answer = await assets.costOf(owner(), {
      assetId: vanRow.id, from: daysAgo(120), to: TODAY,
    });
    expect(answer.runningTotal).toBe("600.0000");
    expect(answer.acquisition).toBe("42000.0000");
    expect(answer.total).toBe("42600.0000");
  });

  it("refuses a negative cost", async () => {
    const vanRow = await van();
    await expect(assets.recordCost(owner(), {
      assetId: vanRow.id, kind: "repair", amount: "-50.00", incurredOn: daysAgo(10),
    })).rejects.toThrow(/not negative/);
  });

  it("refuses a cost per mile when nothing has been driven", async () => {
    /**
     * Zero reads as "this van is free", so the cheapest asset in the fleet
     * becomes the one nobody is reading the odometer on. That is the exact
     * opposite of the truth and it is the kind of wrong that gets acted on.
     */
    const vanRow = await van();
    await assets.recordCost(owner(), {
      assetId: vanRow.id, kind: "fuel", amount: "600.00", incurredOn: daysAgo(50),
    });
    const answer = await assets.costOf(owner(), {
      assetId: vanRow.id, from: daysAgo(120), to: TODAY,
    });
    expect(answer.perUnit.ok).toBe(false);
    expect(answer.perUnit.explanation).toContain("not two in the window");
  });

  it("divides on an integer unit count and flags a window too short to compare", async () => {
    const vanRow = await van();
    await assets.recordReading(owner(), {
      assetId: vanRow.id, value: 80_000, takenOn: daysAgo(30),
    });
    await assets.recordReading(owner(), {
      assetId: vanRow.id, value: 81_000, takenOn: daysAgo(1),
    });
    await assets.recordCost(owner(), {
      assetId: vanRow.id, kind: "fuel", amount: "500.00", incurredOn: daysAgo(10),
    });

    const answer = await assets.costOf(owner(), {
      assetId: vanRow.id, from: daysAgo(40), to: TODAY,
    });
    expect(answer.perUnit.units).toBe(1000);
    expect(answer.perUnit.perUnit).toBe("0.5000");
    expect(answer.perUnit.reliable).toBe(false);
    expect(answer.perUnit.caveat).toContain("not about the asset");
  });
});

/* ========================================== the register, seen from the crew */

run("a crew and the tools it carries", () => {
  const treeCrew = async (kit: string[]) => {
    const crew = await crews.create(owner(), { name: "Tree crew", requiredAssetIds: kit });
    const userId = fixtureId("assets:crewtech");
    await raw`insert into public."user" (id, email) values (${userId}, 'assets-crewtech@test.local')
              on conflict (id) do nothing`;
    const [m] = await raw<{ id: string }[]>`
      insert into public.membership (organization_id, user_id, role)
      values (${ORG}, ${userId}, 'technician') returning id`;
    const [t] = await raw<{ id: string }[]>`
      insert into public.technician (organization_id, membership_id, display_name, active)
      values (${ORG}, ${m!.id}, 'Cara', true) returning id`;
    await crews.setMembers(owner(), { id: crew.id, members: [{ technicianId: t!.id, isLead: true }] });
    return crew;
  };

  const treeJob = async (needs: string[]) => {
    const [type] = await raw<{ id: string }[]>`
      insert into public.job_type (organization_id, name, required_asset_ids, required_skills)
      values (${ORG}, 'Tree removal', ${raw.json(needs as never)}, ${raw.json([] as never)})
      returning id`;
    const [n] = await raw<{ next: number }[]>`
      select coalesce(max(number), 0) + 1 as next from public.job where organization_id = ${ORG}`;
    const [row] = await raw<{ id: string }[]>`
      insert into public.job (organization_id, number, customer_id, property_id, job_type_id,
                              status, summary)
      values (${ORG}, ${n!.next}, ${customerId}, ${propertyId}, ${type!.id}, 'scheduled', 'Tree')
      returning id`;
    return row!.id;
  };

  it("names the machine the company owns rather than the bare code", async () => {
    /**
     * Before the register there was nothing to look the code up in, so the
     * refusal could only repeat the string somebody typed into a job type.
     */
    await chipper();
    const crew = await treeCrew(["bucket-truck"]);
    const job = await treeJob(["chipper"]);

    const verdict = await crews.canTake(owner(), { id: crew.id, jobId: job, on: TODAY });
    expect(verdict.missingEquipment).toEqual(["chipper"]);
    expect(verdict.blockers[0]?.explanation).toContain("Chipper 2 (chipper)");
    expect(verdict.registeredEquipment).toEqual(["chipper"]);
  });

  it("still names a bare code the register has never heard of", async () => {
    const crew = await treeCrew([]);
    const job = await treeJob(["stump-grinder"]);
    const verdict = await crews.canTake(owner(), { id: crew.id, jobId: job, on: TODAY });
    expect(verdict.blockers[0]?.explanation).toContain("stump-grinder");
    expect(verdict.registeredEquipment).toEqual([]);
  });

  it("refuses a crew whose only chipper is grounded by an expired inspection", async () => {
    /**
     * THE ANSWER THAT WAS INVISIBLE BEFORE THIS TABLE EXISTED. The crew
     * carries a chipper and cannot use it, which costs the same day as not
     * carrying one, and `services/crews.ts` could not say so because there
     * was nothing behind the string.
     */
    const machine = await assets.registerAsset(owner(), {
      kind: "equipment", label: "Chipper 2", requirementCode: "chipper", identifier: "CH-002",
    });
    await assets.setObligation(owner(), {
      assetId: machine.id, kind: "inspection", expiresOn: daysAgo(10),
    });
    const crew = await treeCrew(["chipper"]);
    const job = await treeJob(["chipper"]);

    const verdict = await crews.canTake(owner(), { id: crew.id, jobId: job, on: TODAY });
    expect(verdict.canTake).toBe(false);
    expect(verdict.missingEquipment).toEqual([]);
    expect(verdict.blockers.map((b) => b.code)).toContain("equipment_unavailable");
    expect(verdict.unavailableEquipment[0]).toMatchObject({
      code: "chipper", assetId: machine.id, assetLabel: "Chipper 2", reason: "grounded",
    });
  });

  it("clears the crew once a second chipper is on the register", async () => {
    /**
     * The reason this matches a CODE and not a row id. Two chippers carry the
     * same code and either satisfies the requirement, so buying a spare fixes
     * the day rather than needing every job type edited.
     */
    const first = await assets.registerAsset(owner(), {
      kind: "equipment", label: "Chipper 2", requirementCode: "chipper", identifier: "CH-002",
    });
    await assets.setObligation(owner(), {
      assetId: first.id, kind: "inspection", expiresOn: daysAgo(10),
    });
    const crew = await treeCrew(["chipper"]);
    const job = await treeJob(["chipper"]);
    expect((await crews.canTake(owner(), { id: crew.id, jobId: job, on: TODAY })).canTake).toBe(false);

    await assets.registerAsset(owner(), {
      kind: "equipment", label: "Chipper 3", requirementCode: "chipper", identifier: "CH-003",
    });
    expect((await crews.canTake(owner(), { id: crew.id, jobId: job, on: TODAY })).canTake).toBe(true);
  });

  it("refuses a crew whose only chipper has been sold", async () => {
    const machine = await assets.registerAsset(owner(), {
      kind: "equipment", label: "Chipper 2", requirementCode: "chipper", identifier: "CH-002",
    });
    await assets.retireAsset(owner(), { id: machine.id });
    const crew = await treeCrew(["chipper"]);
    const job = await treeJob(["chipper"]);

    const verdict = await crews.canTake(owner(), { id: crew.id, jobId: job, on: TODAY });
    expect(verdict.unavailableEquipment[0]?.reason).toBe("retired");
    /**
     * And the crew is actually REFUSED for it. Asserting only that the
     * register noticed leaves the detection tested and the refusal untested,
     * which passed happily with the blocker deleted.
     */
    expect(verdict.canTake).toBe(false);
    expect(verdict.blockers.map((b) => b.code)).toContain("equipment_unavailable");
  });

  it("does not ground a chipper for an expiry that only looks backwards", async () => {
    /**
     * Core decides which expiries stop an asset being used, and calibration
     * is deliberately not one of them: it invalidates past reports rather
     * than grounding the machine. Grounding on every expiry would stop a
     * crew for a certificate that has nothing to do with today's work.
     */
    const machine = await assets.registerAsset(owner(), {
      kind: "instrument", label: "Moisture meter", requirementCode: "moisture-meter",
      identifier: "MM-1",
    });
    await assets.setObligation(owner(), {
      assetId: machine.id, kind: "calibration",
      expiresOn: daysAgo(10), lastCertifiedOn: daysAgo(400),
    });
    const crew = await treeCrew(["moisture-meter"]);
    const job = await treeJob(["moisture-meter"]);

    const verdict = await crews.canTake(owner(), { id: crew.id, jobId: job, on: TODAY });
    expect(verdict.unavailableEquipment).toEqual([]);
    expect(verdict.canTake).toBe(true);
  });

  it("asks about the day the work is, not about today", async () => {
    /**
     * An inspection that expires on Wednesday does not stop Tuesday's job and
     * does stop Thursday's, the same way the people half is judged on the day
     * of the visit.
     */
    const machine = await assets.registerAsset(owner(), {
      kind: "equipment", label: "Chipper 2", requirementCode: "chipper", identifier: "CH-002",
    });
    await assets.setObligation(owner(), {
      assetId: machine.id, kind: "inspection", expiresOn: daysAgo(10),
    });
    const crew = await treeCrew(["chipper"]);
    const job = await treeJob(["chipper"]);

    const before = await crews.canTake(owner(), { id: crew.id, jobId: job, on: daysAgo(20) });
    expect(before.unavailableEquipment).toEqual([]);
    const after = await crews.canTake(owner(), { id: crew.id, jobId: job, on: daysAgo(5) });
    expect(after.unavailableEquipment).toHaveLength(1);
  });

  it("says nothing about availability for a code nobody has registered", async () => {
    const crew = await treeCrew(["stump-grinder"]);
    const job = await treeJob(["stump-grinder"]);
    const verdict = await crews.canTake(owner(), { id: crew.id, jobId: job, on: TODAY });
    expect(verdict.unavailableEquipment).toEqual([]);
    expect(verdict.registeredEquipment).toEqual([]);
    expect(verdict.canTake).toBe(true);
  });
});

/* ============================================= the published shapes are real */

run("the contract describes what the service returns", () => {
  /**
   * The routes are not in the registry yet, so nothing else in the suite
   * compares these two. Without this, the published output schema and the
   * handler could disagree from the day they are wired, and the symptom
   * would be a client branching on a field that is never there.
   */
  it("validates the register, custody, maintenance and compliance shapes", async () => {
    const asset = await van();
    await assets.checkOut(owner(), {
      assetId: asset.id, custodianKind: "technician", custodianId: technicianId, on: daysAgo(3),
    });
    await assets.recordReading(owner(), { assetId: asset.id, value: 80_000, takenOn: daysAgo(3) });
    await assets.recordReading(owner(), { assetId: asset.id, value: 80_400, takenOn: daysAgo(1) });
    await assets.setObligation(owner(), {
      assetId: asset.id, kind: "registration", expiresOn: daysAhead(100),
    });
    const plan = await assets.setPlan(owner(), {
      assetId: asset.id, label: "Oil change", basis: "meter", everyUnits: 5000,
      lastServicedOn: daysAgo(3),
    });
    await assets.recordCost(owner(), {
      assetId: asset.id, kind: "fuel", amount: "120.00", incurredOn: daysAgo(2),
    });

    assetRoutes.listAssets.output.parse(await assets.handlers.listAssets(owner(), {}));
    assetRoutes.getAssetCustody.output.parse(
      await assets.handlers.getAssetCustody(owner(), { assetId: asset.id }));
    assetRoutes.listAssetsHeldBy.output.parse(
      await assets.handlers.listAssetsHeldBy(owner(), {
        custodianKind: "technician", custodianId: technicianId,
      }));
    assetRoutes.listAssetReadings.output.parse(
      await assets.handlers.listAssetReadings(owner(), {
        assetId: asset.id, from: daysAgo(10), to: TODAY,
      }));
    assetRoutes.getAssetMaintenanceDue.output.parse(
      await assets.handlers.getAssetMaintenanceDue(owner(), { now: TODAY }));
    assetRoutes.getAssetComplianceOutlook.output.parse(
      await assets.handlers.getAssetComplianceOutlook(owner(), { now: TODAY }));
    assetRoutes.getAssetCost.output.parse(
      await assets.handlers.getAssetCost(owner(), {
        assetId: asset.id, from: daysAgo(30), to: TODAY,
      }));
    assetRoutes.recordAssetService.output.parse(
      await assets.handlers.recordAssetService(owner(), { planId: plan.id }));
  });

  it("declares exactly the three permissions the catalogue names", () => {
    const used = new Set(Object.values(assetRoutes).flatMap((r) => r.permissions));
    expect([...used].sort()).toEqual(["asset:checkout", "asset:read", "asset:write"]);
  });

  it("wires a handler for every published route", () => {
    const missing = Object.keys(assetRoutes)
      .filter((name) => !(name in assets.handlers));
    expect(missing, "published with no handler to wire").toEqual([]);
  });
});
