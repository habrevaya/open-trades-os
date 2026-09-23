import { describe, it, expect } from "vitest";
import * as inv from "../src/inventory/index.js";
import { money, toString as m, sum, zero } from "../src/money/index.js";

/**
 * PURCHASING, VENDORS AND INVENTORY
 *
 * Three quantities, not one. A stock level derived from an append only
 * history, never edited. Money allocated and never divided.
 *
 * The fixtures below deliberately do not divide evenly. A costing test where
 * every receipt splits cleanly across its units proves nothing at all: it
 * passes just as happily against an implementation that divides and rounds,
 * which is the exact bug the allocation machinery exists to prevent.
 */

const usd = (v: string) => money(v, "USD");
const q = inv.quantity;
const qs = inv.quantityToString;

const WAREHOUSE = "WAREHOUSE";
const VAN = "VAN-4";
const COMP = "COMP-410";

/** 9am on the given January day, so ordering is readable in a failure message. */
const at = (day: number, minute = 0) => new Date(Date.UTC(2026, 0, day, 9, minute));

type Extra = Omit<Partial<inv.Movement>, "id" | "sequence" | "occurredAt" | "kind" | "quantity">;

function mv(
  id: string,
  sequence: number,
  occurredAt: Date,
  kind: inv.MovementKind,
  quantity: string,
  extra: Extra = {},
): inv.Movement {
  return {
    id,
    sequence,
    occurredAt,
    itemId: COMP,
    locationId: WAREHOUSE,
    kind,
    quantity: q(quantity),
    ...extra,
  };
}

const stamp = (id: string, sequence: number, occurredAt: Date): inv.MovementStamp => ({ id, sequence, occurredAt });

const level = (onHand: string, committed = "0", locationId = WAREHOUSE): inv.StockLevel => ({
  itemId: COMP,
  locationId,
  onHand: q(onHand),
  committed: q(committed),
});

/** Every decision returns a union. Tests that expect success should say so loudly. */
function expectOk<T extends { ok: true }>(result: T | inv.InventoryRefusal): T {
  if (!result.ok) throw new Error(`Expected success, got: ${inv.explainRefusal(result)}`);
  return result;
}

function expectRefusal(result: { ok: true } | inv.InventoryRefusal): inv.InventoryRefusal {
  if (result.ok) throw new Error("Expected a refusal and got a success");
  return result;
}

// ---------------------------------------------------------------------------

describe("quantities are not floats either", () => {
  it("adds a hundred tenths of a pound to exactly ten pounds", () => {
    let total = inv.ZERO_QUANTITY;
    for (let i = 0; i < 100; i++) total += q("0.1");
    expect(qs(total)).toBe("10.0000");
  });

  it("refuses a JS number, which is how a float gets into a cycle count", () => {
    // @ts-expect-error deliberately passing a number
    expect(() => q(2.75)).toThrow();
  });

  it("refuses precision it cannot hold rather than silently truncating", () => {
    expect(() => q("1.00001")).toThrow(/precision/);
  });

  it("shows a parts list a number a person would write", () => {
    // Nobody writes "3.0000 compressors" on a parts list.
    expect(inv.quantityLabel(q("3"))).toBe("3");
    expect(inv.quantityLabel(q("12.5"))).toBe("12.5");
    expect(inv.quantityLabel(q("0"))).toBe("0");
  });
});

describe("the three quantities", () => {
  it("never stores available anywhere something could write to it", () => {
    /**
     * The constraint the whole module is built around. The moment available
     * is a field, some path updates on hand without updating it, and the
     * system starts reporting stock it does not have. So: it is not a key on
     * a level, and it cannot be, because there is nowhere to put it.
     */
    const levels = inv.deriveLevels([
      mv("r1", 1, at(1), "receipt", "4", { totalCost: usd("400.00") }),
      mv("c1", 2, at(2), "commit", "3", { jobId: "J-1" }),
    ]);
    const only = levels[0]!;

    expect(Object.keys(only).sort()).toEqual(["committed", "itemId", "locationId", "onHand"]);
    expect("available" in only).toBe(false);
    expect(qs(inv.available(only))).toBe("1.0000");
  });

  it("recomputes available from the history, so it cannot go stale", () => {
    // The same on hand, two different answers, because a reservation happened
    // and nothing had to remember to update a second number.
    const received = [mv("r1", 1, at(1), "receipt", "4", { totalCost: usd("400.00") })];
    const before = inv.deriveLevel(received, COMP, WAREHOUSE);
    const after = inv.deriveLevel([...received, mv("c1", 2, at(2), "commit", "3", { jobId: "J-1" })], COMP, WAREHOUSE);

    expect(qs(before.onHand)).toBe(qs(after.onHand));
    expect(qs(inv.available(before))).toBe("4.0000");
    expect(qs(inv.available(after))).toBe("1.0000");
  });

  it("answers where the part is, not whether the company has one", () => {
    /**
     * "One in stock" is not a useful sentence once a van is a location. One
     * at the warehouse forty minutes away does nothing for the technician in
     * the crawlspace, and flattening the answer to a single number is what
     * sends them to a property without the part.
     */
    const levels = inv.deriveLevels([
      mv("r1", 1, at(1), "receipt", "1", { totalCost: usd("100.00") }),
      mv("r2", 2, at(1), "receipt", "3", { locationId: VAN, totalCost: usd("300.00") }),
    ]);
    expect(qs(inv.totalAvailable(levels, COMP))).toBe("4.0000");
    expect(inv.locationsWithAvailable(levels, COMP).map((l) => l.locationId)).toEqual([VAN, WAREHOUSE]);
    expect(inv.locationsWithAvailable(levels, COMP, q("2")).map((l) => l.locationId)).toEqual([VAN]);
  });
});

describe("reserving stock, which is what stops two vans being sent for one compressor", () => {
  it("refuses a commitment that exceeds what is on hand, with the shortfall", () => {
    const decision = inv.planCommitment({
      level: level("1"),
      quantity: q("2"),
      jobId: "J-9",
      stamp: stamp("c1", 1, at(2)),
    });
    const refusal = expectRefusal(decision);
    expect(refusal.reason).toBe("insufficient_available");
    if (refusal.reason !== "insufficient_available") throw new Error("narrowing");
    expect(qs(refusal.shortfall)).toBe("1.0000");
    expect(qs(refusal.availableNow)).toBe("1.0000");
  });

  it("refuses against available and not against on hand, which is the entire point", () => {
    /**
     * Four on the shelf and three already promised to Thursday's installs.
     * A system that checks on hand says yes to the fourth job and the second
     * technician finds out at the property.
     */
    const decision = inv.planCommitment({
      level: level("4", "3"),
      quantity: q("2"),
      jobId: "J-9",
      stamp: stamp("c1", 1, at(2)),
    });
    const refusal = expectRefusal(decision);
    expect(refusal.reason).toBe("insufficient_available");
    expect(inv.explainRefusal(refusal)).toContain("already reserved");
  });

  it("allows a commitment that fits and changes nothing about on hand", () => {
    const decision = expectOk(
      inv.planCommitment({ level: level("4", "3"), quantity: q("1"), jobId: "J-9", stamp: stamp("c1", 5, at(2)) }),
    );
    expect(decision.movements).toHaveLength(1);
    expect(decision.movements[0]!.kind).toBe("commit");
    const effect = inv.effectOf("commit", q("1"));
    expect(qs(effect.onHand)).toBe("0.0000");
    expect(qs(effect.committed)).toBe("1.0000");
  });

  it("never lets a reservation go negative and report stock that is not there", () => {
    /**
     * Issuing a part nobody reserved drives committed below zero, and a
     * negative reservation makes available read HIGHER than on hand. That is
     * a dispatcher being told there is stock that does not exist, so
     * committed is clamped and on hand is not.
     */
    const levels = inv.deriveLevels([
      mv("r1", 1, at(1), "receipt", "5", { totalCost: usd("500.00") }),
      mv("i1", 2, at(2), "issue", "2", { jobId: "J-1" }),
    ]);
    const only = levels[0]!;
    expect(qs(only.committed)).toBe("0.0000");
    expect(qs(inv.available(only))).toBe("3.0000");
  });

  it("lets on hand go negative, because a broken history is information", () => {
    // Hiding it at zero destroys the only signal that a receipt was never
    // entered, and then the numbers look fine and are not.
    const levels = inv.deriveLevels([mv("i1", 1, at(2), "issue", "2", { jobId: "J-1" })]);
    expect(qs(levels[0]!.onHand)).toBe("-2.0000");
  });
});

describe("a transfer is two movements that must both happen or neither", () => {
  it("returns both halves together, sharing one transfer id", () => {
    /**
     * Returned as one array so there is no shape of the result that lets a
     * caller write the out leg and not the in leg. One leg written alone is
     * three capacitors that exist in no location at all, or that exist twice.
     */
    const decision = expectOk(
      inv.planTransfer({
        from: level("5"),
        toLocationId: VAN,
        quantity: q("3"),
        transferId: "T-1",
        out: stamp("t1a", 1, at(3)),
        in: stamp("t1b", 2, at(3)),
      }),
    );
    expect(decision.movements.map((mo) => mo.kind)).toEqual(["transfer_out", "transfer_in"]);
    expect(decision.movements.map((mo) => mo.transferId)).toEqual(["T-1", "T-1"]);
    expect(decision.movements.map((mo) => mo.locationId)).toEqual([WAREHOUSE, VAN]);
  });

  it("refuses a transfer that would leave the source location negative", () => {
    const refusal = expectRefusal(
      inv.planTransfer({
        from: level("2"),
        toLocationId: VAN,
        quantity: q("3"),
        transferId: "T-1",
        out: stamp("t1a", 1, at(3)),
        in: stamp("t1b", 2, at(3)),
      }),
    );
    expect(refusal.reason).toBe("insufficient_on_hand");
    if (refusal.reason !== "insufficient_on_hand") throw new Error("narrowing");
    expect(qs(refusal.shortfall)).toBe("1.0000");
  });

  it("refuses a transfer that would strip the shelf of a reserved part", () => {
    // Three on the shelf, two reserved for Thursday. Moving two to a van
    // leaves Thursday short and the transfer is not obviously to blame.
    const refusal = expectRefusal(
      inv.planTransfer({
        from: level("3", "2"),
        toLocationId: VAN,
        quantity: q("2"),
        transferId: "T-1",
        out: stamp("t1a", 1, at(3)),
        in: stamp("t1b", 2, at(3)),
      }),
    );
    expect(refusal.reason).toBe("would_strand_commitment");
    expect(inv.explainRefusal(refusal)).toContain("Release a reservation");
  });

  it("refuses a transfer to the location it is already in", () => {
    const refusal = expectRefusal(
      inv.planTransfer({
        from: level("3"),
        toLocationId: WAREHOUSE,
        quantity: q("1"),
        transferId: "T-1",
        out: stamp("t1a", 1, at(3)),
        in: stamp("t1b", 2, at(3)),
      }),
    );
    expect(refusal.reason).toBe("same_location");
  });

  it("refuses to cost a history where only one half of a transfer was written", () => {
    /**
     * Stock left the warehouse and arrived nowhere. The total still looks
     * plausible, which is why this has to be refused rather than tolerated.
     */
    const run = inv.costMovements({
      movements: [
        mv("r1", 1, at(1), "receipt", "5", { totalCost: usd("500.00") }),
        mv("t1a", 2, at(3), "transfer_out", "3", { transferId: "T-1" }),
      ],
      method: "fifo",
    });
    const refusal = expectRefusal(run);
    expect(refusal.reason).toBe("unpaired_transfer");
    expect(inv.explainRefusal(refusal)).toContain("arrived");
  });

  it("carries the cost with the parts instead of revaluing them on arrival", () => {
    /**
     * Otherwise a company manufactures or destroys inventory value by
     * shuffling parts between its own vans.
     */
    const run = expectOk(
      inv.costMovements({
        movements: [
          mv("r1", 1, at(1), "receipt", "3", { totalCost: usd("100.00") }),
          mv("t1a", 2, at(3), "transfer_out", "1", { transferId: "T-1" }),
          mv("t1b", 3, at(3), "transfer_in", "1", { locationId: VAN, transferId: "T-1" }),
        ],
        method: "fifo",
      }),
    );
    expect(m(run.value)).toBe("100.0000");
    const onVan = run.layers.find((l) => l.locationId === VAN)!;
    expect(m(onVan.cost)).toBe("33.3333");
  });
});

describe("costing: money is allocated, never divided", () => {
  it("recovers the exact receipt cost when a price does not divide across its units", () => {
    /**
     * THE TEST THIS MODULE EXISTS FOR. Three condensate pumps for 100.00.
     * There is no unit cost: 33.33 three times is 99.99 and 33.3333 three
     * times is 99.9999. Either way a fraction is stranded in the inventory
     * account attached to zero units of a part, on every receipt that does
     * not divide, forever, and eventually inventory and the general ledger
     * disagree by an amount nobody can explain.
     */
    const run = expectOk(
      inv.costMovements({
        movements: [
          mv("r1", 1, at(1), "receipt", "3", { totalCost: usd("100.00") }),
          mv("i1", 2, at(2), "issue", "1", { jobId: "J-1" }),
          mv("i2", 3, at(3), "issue", "1", { jobId: "J-2" }),
          mv("i3", 4, at(4), "issue", "1", { jobId: "J-3" }),
        ],
        method: "fifo",
      }),
    );

    expect(run.issues.map((i) => m(i.cost))).toEqual(["33.3333", "33.3334", "33.3333"]);
    // The property that matters: the three issues sum to what was paid.
    expect(m(sum(run.issues.map((i) => i.cost)))).toBe("100.0000");
    // And the layer is gone, with nothing left behind in it.
    expect(run.layers).toHaveLength(0);
    expect(m(run.value)).toBe("0.0000");
  });

  it("leaves the layer holding exactly what is left after a partial take", () => {
    // What was paid, minus what left, to the ten-thousandth. Not approximately.
    const run = expectOk(
      inv.costMovements({
        movements: [
          mv("r1", 1, at(1), "receipt", "3", { totalCost: usd("100.00") }),
          mv("i1", 2, at(2), "issue", "1", { jobId: "J-1" }),
        ],
        method: "fifo",
      }),
    );
    expect(m(run.issues[0]!.cost)).toBe("33.3333");
    expect(m(run.layers[0]!.cost)).toBe("66.6667");
    expect(m(sum([run.issues[0]!.cost, run.layers[0]!.cost]))).toBe("100.0000");
  });

  it("costs an issue that spans two receipts at different prices", () => {
    /**
     * Two at 25.00 bought in March, three at 40.00 bought in June after the
     * price moved. FIFO takes the old cheap layer first and then reaches into
     * the new one, which is the whole behaviour: 2 at 25 plus 2 at 40.
     */
    const movements = [
      mv("r1", 1, at(1), "receipt", "2", { totalCost: usd("50.00") }),
      mv("r2", 2, at(2), "receipt", "3", { totalCost: usd("120.00") }),
      mv("i1", 3, at(3), "issue", "4", { jobId: "J-1" }),
    ];
    const run = expectOk(inv.costMovements({ movements, method: "fifo" }));

    expect(m(run.issues[0]!.cost)).toBe("130.0000");
    expect(run.layers).toHaveLength(1);
    expect(qs(run.layers[0]!.quantity)).toBe("1.0000");
    expect(m(run.layers[0]!.cost)).toBe("40.0000");
    expect(m(run.value)).toBe("40.0000");
  });

  it("gives a different and also defensible answer under average cost", () => {
    // The same five parts and the same four issued. FIFO says 130, average
    // says 136, and neither is wrong. What matters is that the company was
    // told which lie it picked.
    const movements = [
      mv("r1", 1, at(1), "receipt", "2", { totalCost: usd("50.00") }),
      mv("r2", 2, at(2), "receipt", "3", { totalCost: usd("120.00") }),
      mv("i1", 3, at(3), "issue", "4", { jobId: "J-1" }),
    ];
    const run = expectOk(inv.costMovements({ movements, method: "average" }));
    expect(m(run.issues[0]!.cost)).toBe("136.0000");
    expect(m(run.value)).toBe("34.0000");
  });

  it("reconciles under average cost when the pool does not divide either", () => {
    // Three at 100.00 and two at 55.55 is 155.55 across five, which is
    // 31.11 exactly. So make it awkward: issue two, then three.
    const movements = [
      mv("r1", 1, at(1), "receipt", "3", { totalCost: usd("100.00") }),
      mv("r2", 2, at(2), "receipt", "2", { totalCost: usd("55.57") }),
      mv("i1", 3, at(3), "issue", "2", { jobId: "J-1" }),
      mv("i2", 4, at(4), "issue", "3", { jobId: "J-2" }),
    ];
    const run = expectOk(inv.costMovements({ movements, method: "average" }));
    expect(m(sum(run.issues.map((i) => i.cost)))).toBe("155.5700");
    expect(m(run.value)).toBe("0.0000");
    // Not an even split, which is the point of the fixture.
    expect(run.issues.map((i) => m(i.cost))).toEqual(["62.2280", "93.3420"]);
  });

  it("every partial take in any order still sums back to what was paid", () => {
    // The invariant, exercised rather than asserted once. Seven parts for
    // 1000.01, taken out in lumps that do not divide by anything.
    for (const method of ["fifo", "average"] as const) {
      const run = expectOk(
        inv.costMovements({
          movements: [
            mv("r1", 1, at(1), "receipt", "7", { totalCost: usd("1000.01") }),
            mv("i1", 2, at(2), "issue", "2", { jobId: "J-1" }),
            mv("i2", 3, at(3), "issue", "1", { jobId: "J-2" }),
            mv("i3", 4, at(4), "issue", "3", { jobId: "J-3" }),
            mv("i4", 5, at(5), "issue", "1", { jobId: "J-4" }),
          ],
          method,
        }),
      );
      expect(m(sum(run.issues.map((i) => i.cost))), method).toBe("1000.0100");
    }
  });

  it("refuses to cost stock that was never received rather than pricing it at zero", () => {
    /**
     * A job costed at zero for a part that was not free is worse than no
     * costing at all, because somebody prices against the margin it shows.
     */
    const run = inv.costMovements({
      movements: [
        mv("r1", 1, at(1), "receipt", "1", { totalCost: usd("100.00") }),
        mv("i1", 2, at(2), "issue", "3", { jobId: "J-1" }),
      ],
      method: "fifo",
    });
    const refusal = expectRefusal(run);
    expect(refusal.reason).toBe("insufficient_layers");
    if (refusal.reason !== "insufficient_layers") throw new Error("narrowing");
    expect(qs(refusal.costable)).toBe("1.0000");
    expect(inv.explainRefusal(refusal)).toContain("out of order or a receipt is missing");
  });

  it("refuses stock that arrives with no cost on it", () => {
    // Free inventory makes every job that uses it look more profitable than
    // it was, and that margin is a number somebody prices against.
    const run = inv.costMovements({
      movements: [mv("a1", 1, at(1), "adjustment_in", "2", { reasonCode: "cycle_count" })],
      method: "fifo",
    });
    const refusal = expectRefusal(run);
    expect(refusal.reason).toBe("missing_cost");
    expect(inv.explainRefusal(refusal)).toContain("values itself at zero");
  });

  it("keeps the approximate unit cost out of the arithmetic", () => {
    // Fine on a screen next to a part, so a buyer can see today's quote is
    // out of line. Never fed back into a cost, because it is a division.
    const run = expectOk(
      inv.costMovements({
        movements: [mv("r1", 1, at(1), "receipt", "3", { totalCost: usd("100.00") })],
        method: "fifo",
      }),
    );
    expect(m(inv.approximateUnitCost(run.layers[0]!))).toBe("33.3333");
    // And three of those is not what was paid, which is why it is display only.
    expect(m(sum([usd("33.3333"), usd("33.3333"), usd("33.3333")]))).not.toBe("100.0000");
  });

  it("attributes material cost to the job that consumed it", () => {
    const run = expectOk(
      inv.costMovements({
        movements: [
          mv("r1", 1, at(1), "receipt", "3", { totalCost: usd("100.00") }),
          mv("i1", 2, at(2), "issue", "1", { jobId: "J-1" }),
          mv("i2", 3, at(3), "issue", "2", { jobId: "J-2" }),
        ],
        method: "fifo",
      }),
    );
    const byJob = inv.cogsByJob(run.issues);
    expect(m(byJob.get("J-1") ?? zero())).toBe("33.3333");
    expect(m(byJob.get("J-2") ?? zero())).toBe("66.6667");
  });

  it("describes what each costing method is wrong about, because the screen has to say", () => {
    for (const method of Object.keys(inv.COSTING_METHODS) as inv.CostingMethod[]) {
      const note = inv.COSTING_METHODS[method];
      expect(note.label.length, method).toBeGreaterThan(0);
      expect(note.howItWorks.length, method).toBeGreaterThan(40);
      expect(note.whatItIsWrongAbout.length, method).toBeGreaterThan(80);
    }
  });
});

describe("movements arriving out of order", () => {
  it("derives the same levels however the list is handed over", () => {
    /**
     * A level is a fold over a history, and a fold that depends on the order
     * rows came back from the database is not an answer.
     */
    const movements = [
      mv("r1", 1, at(1), "receipt", "5", { totalCost: usd("500.00") }),
      mv("c1", 2, at(2), "commit", "2", { jobId: "J-1" }),
      mv("i1", 3, at(3), "issue", "2", { jobId: "J-1" }),
    ];
    const forwards = inv.deriveLevel(movements, COMP, WAREHOUSE);
    const backwards = inv.deriveLevel([...movements].reverse(), COMP, WAREHOUSE);
    const shuffled = inv.deriveLevel([movements[2]!, movements[0]!, movements[1]!], COMP, WAREHOUSE);

    for (const derived of [backwards, shuffled]) {
      expect(qs(derived.onHand)).toBe(qs(forwards.onHand));
      expect(qs(derived.committed)).toBe(qs(forwards.committed));
    }
    expect(qs(forwards.onHand)).toBe("3.0000");
    expect(qs(forwards.committed)).toBe("0.0000");
  });

  it("puts a backdated receipt where it happened, not where it was typed", () => {
    /**
     * A delivery entered on Thursday for parts that arrived on Monday gets a
     * LATER sequence and an EARLIER date. FIFO has to consume Monday's cheap
     * layer first or it charges the wrong physical part to the job.
     */
    const movements = [
      mv("r-june", 1, at(10), "receipt", "2", { totalCost: usd("80.00") }),
      mv("r-march", 9, at(1), "receipt", "2", { totalCost: usd("50.00") }),
      mv("i1", 10, at(20), "issue", "2", { jobId: "J-1" }),
    ];
    const run = expectOk(inv.costMovements({ movements, method: "fifo" }));
    // March, at 25 each, not June at 40 each.
    expect(m(run.issues[0]!.cost)).toBe("50.0000");
    expect(m(run.value)).toBe("80.0000");
  });

  it("refuses to cost an issue that happened before anything was received", () => {
    /**
     * Not the same as a receipt entered late. Here the issue genuinely
     * precedes every receipt, so the history is broken and no cost exists.
     * Producing one anyway is the nonsense number this refuses to invent.
     */
    const run = inv.costMovements({
      movements: [
        mv("i1", 1, at(1), "issue", "1", { jobId: "J-1" }),
        mv("r1", 2, at(5), "receipt", "3", { totalCost: usd("100.00") }),
      ],
      method: "fifo",
    });
    const refusal = expectRefusal(run);
    expect(refusal.reason).toBe("insufficient_layers");
    if (refusal.reason !== "insufficient_layers") throw new Error("narrowing");
    expect(refusal.movementId).toBe("i1");
    expect(qs(refusal.costable)).toBe("0.0000");
  });

  it("breaks a same-instant tie by sequence, so a transfer costs the same every run", () => {
    // Both halves of a transfer land in the same millisecond. Without a tie
    // break the answer depends on row order, which is to say there is none.
    const movements = [
      mv("r1", 1, at(1), "receipt", "2", { totalCost: usd("100.00") }),
      mv("t-in", 3, at(2), "transfer_in", "1", { locationId: VAN, transferId: "T-1" }),
      mv("t-out", 2, at(2), "transfer_out", "1", { transferId: "T-1" }),
    ];
    const first = expectOk(inv.costMovements({ movements, method: "fifo" }));
    const second = expectOk(inv.costMovements({ movements: [...movements].reverse(), method: "fifo" }));
    expect(m(first.value)).toBe("100.0000");
    expect(m(second.value)).toBe(m(first.value));
  });
});

describe("cycle counts", () => {
  it("writes no movement at all when the count matches", () => {
    // A history full of zero adjustments is a history nobody reads.
    const decision = expectOk(
      inv.reconcileCount({
        level: level("4"),
        counted: q("4"),
        stamp: stamp("a1", 1, at(5)),
        reasonCode: "cycle_count",
      }),
    );
    expect(decision.movements).toEqual([]);
  });

  it("records a shortfall as an adjustment out with a reason on it", () => {
    const decision = expectOk(
      inv.reconcileCount({
        level: level("4"),
        counted: q("2"),
        stamp: stamp("a1", 1, at(5)),
        reasonCode: "shrinkage",
      }),
    );
    expect(decision.movements[0]!.kind).toBe("adjustment_out");
    expect(qs(decision.movements[0]!.quantity)).toBe("2.0000");
    expect(decision.movements[0]!.reasonCode).toBe("shrinkage");
  });

  it("refuses to add found stock without saying what it cost", () => {
    const refusal = expectRefusal(
      inv.reconcileCount({
        level: level("2"),
        counted: q("4"),
        stamp: stamp("a1", 1, at(5)),
        reasonCode: "cycle_count",
      }),
    );
    expect(refusal.reason).toBe("missing_cost");
  });
});

describe("what to buy", () => {
  const policy: inv.ReorderPolicy = {
    itemId: COMP,
    locationId: WAREHOUSE,
    reorderPoint: q("2"),
    reorderQuantity: q("4"),
  };

  it("suggests an order when there is nothing on the shelf and nothing coming", () => {
    const [suggestion] = inv.suggestReorders({
      policies: [policy],
      levels: [level("0")],
      onOrder: [],
      now: at(10),
    });
    expect(qs(suggestion!.suggested)).toBe("6.0000");
    expect(suggestion!.why).toContain("nothing on order");
  });

  it("does not suggest buying something that is already on order", () => {
    /**
     * THE TWELVE BLOWER MOTORS. A system that compares stock on hand against
     * the reorder point suggests the same order every night until the parts
     * arrive, somebody places it every night, and twelve days later twelve of
     * them turn up and the money is gone until they sell, which for a slow
     * part is never.
     *
     * The fix is one word: position. Available PLUS what is already on order.
     */
    const suggestions = inv.suggestReorders({
      policies: [policy],
      levels: [level("0")],
      onOrder: [{ itemId: COMP, locationId: WAREHOUSE, quantity: q("5"), purchaseOrderId: "PO-1" }],
      now: at(10),
    });
    expect(suggestions).toEqual([]);
  });

  it("still suggests when what is on order is not enough to clear the point", () => {
    // One available, one coming, the point is two. Position is exactly at the
    // point, and at the point you buy.
    const [suggestion] = inv.suggestReorders({
      policies: [policy],
      levels: [level("1")],
      onOrder: [{ itemId: COMP, locationId: WAREHOUSE, quantity: q("1"), purchaseOrderId: "PO-1" }],
      now: at(10),
    });
    expect(qs(suggestion!.position)).toBe("2.0000");
    expect(qs(suggestion!.suggested)).toBe("4.0000");
    expect(suggestion!.why).toContain("already on order");
  });

  it("counts reserved stock as gone, because it is", () => {
    // Three on the shelf and three promised to Thursday is zero available.
    const [suggestion] = inv.suggestReorders({
      policies: [policy],
      levels: [level("3", "3")],
      onOrder: [],
      now: at(10),
    });
    expect(qs(suggestion!.availableNow)).toBe("0.0000");
    expect(qs(suggestion!.suggested)).toBe("6.0000");
  });

  it("tops up to a maximum when one is set instead of buying a fixed lot", () => {
    const [suggestion] = inv.suggestReorders({
      policies: [{ ...policy, maximumQuantity: q("10") }],
      levels: [level("1")],
      onOrder: [],
      now: at(10),
    });
    expect(qs(suggestion!.suggested)).toBe("9.0000");
  });

  it("never suggests less than one economic order, whatever the arithmetic says", () => {
    // A vendor minimum and a delivery charge make a two unit order cost more
    // than a five unit one, and a system that suggests dribbles gets ignored.
    const [suggestion] = inv.suggestReorders({
      policies: [{ ...policy, maximumQuantity: q("3") }],
      levels: [level("2")],
      onOrder: [],
      now: at(10),
    });
    expect(qs(suggestion!.suggested)).toBe("4.0000");
  });

  it("flags a late purchase order instead of quietly buying more", () => {
    // The right action is a phone call to the vendor, which is never the
    // action an automatic reorder takes.
    const [suggestion] = inv.suggestReorders({
      policies: [policy],
      levels: [level("0")],
      onOrder: [
        { itemId: COMP, locationId: WAREHOUSE, quantity: q("1"), purchaseOrderId: "PO-1", expectedAt: at(3) },
      ],
      now: at(12),
    });
    expect(suggestion!.overdue.map((l) => l.purchaseOrderId)).toEqual(["PO-1"]);
  });

  it("keeps the policy per location, because a van and a warehouse are different questions", () => {
    const suggestions = inv.suggestReorders({
      policies: [policy, { ...policy, locationId: VAN, reorderPoint: q("1"), reorderQuantity: q("2") }],
      levels: [level("6"), level("0", "0", VAN)],
      onOrder: [],
      now: at(10),
    });
    expect(suggestions.map((s) => s.locationId)).toEqual([VAN]);
  });
});

describe("purchase order state", () => {
  const line = (over: Partial<inv.PurchaseOrderLine> = {}): inv.PurchaseOrderLine => ({
    id: "L-1",
    itemId: COMP,
    locationId: WAREHOUSE,
    quantityOrdered: q("5"),
    quantityReceived: inv.ZERO_QUANTITY,
    unitPrice: usd("40.00"),
    ...over,
  });

  const po = (over: Partial<inv.PurchaseOrder> = {}): inv.PurchaseOrder => ({
    id: "PO-1",
    vendorId: "V-1",
    status: "submitted",
    lines: [line()],
    ...over,
  });

  it("names and explains every status, because a badge has to say something", () => {
    for (const status of Object.keys(inv.PURCHASE_ORDER_STATUS) as inv.PurchaseOrderStatus[]) {
      expect(inv.PURCHASE_ORDER_STATUS[status].label.length, status).toBeGreaterThan(0);
      expect(inv.PURCHASE_ORDER_STATUS[status].meaning.length, status).toBeGreaterThan(20);
    }
  });

  it("lets a vendor who never acknowledges anything still deliver", () => {
    // Forcing an acknowledgement step makes the receiving clerk click a lie
    // before they can do their job.
    expect(inv.canTransition("submitted", "received")).toBe(true);
    expect(inv.canTransition("draft", "submitted")).toBe(true);
  });

  it("refuses to reopen a received purchase order", () => {
    // Parts going back are a return to vendor with a credit. Reopening would
    // rewrite history and the matched vendor bill would stop matching.
    const refusal = expectRefusal(inv.transitionPurchaseOrder(po({ status: "received" }), "submitted", at(9)));
    expect(refusal.reason).toBe("illegal_transition");
    expect(inv.explainRefusal(refusal)).toContain("Received");
  });

  it("refuses to receive against a draft nobody has sent", () => {
    const refusal = expectRefusal(
      inv.receivePurchaseOrder({
        purchaseOrder: po({ status: "draft" }),
        receipts: [{ lineId: "L-1", quantity: q("3"), movement: stamp("r1", 1, at(6)) }],
        now: at(6),
      }),
    );
    expect(refusal.reason).toBe("not_receivable");
    expect(inv.explainRefusal(refusal)).toContain("Submit it first");
  });

  it("takes a partial receipt and then the rest", () => {
    /**
     * Three of five arrive. Get this wrong in one direction and the stock is
     * double counted. Get it wrong in the other and nobody chases the vendor
     * for two pumps that were paid for and never came, because no report
     * anywhere says so.
     */
    const first = expectOk(
      inv.receivePurchaseOrder({
        purchaseOrder: po(),
        receipts: [{ lineId: "L-1", quantity: q("3"), movement: stamp("r1", 1, at(6)) }],
        now: at(6),
      }),
    );

    expect(first.purchaseOrder.status).toBe("partially_received");
    expect(qs(first.purchaseOrder.lines[0]!.quantityReceived)).toBe("3.0000");
    expect(qs(inv.outstandingOf(first.purchaseOrder.lines[0]!))).toBe("2.0000");
    expect(m(first.movements[0]!.totalCost!)).toBe("120.0000");
    expect(m(inv.outstandingValue(first.purchaseOrder))).toBe("80.0000");

    // Two still owed, so the reorder engine must leave them alone.
    expect(inv.onOrderFrom([first.purchaseOrder]).map((l) => qs(l.quantity))).toEqual(["2.0000"]);

    const second = expectOk(
      inv.receivePurchaseOrder({
        purchaseOrder: first.purchaseOrder,
        receipts: [{ lineId: "L-1", quantity: q("2"), movement: stamp("r2", 2, at(9)) }],
        now: at(9),
      }),
    );

    expect(second.purchaseOrder.status).toBe("received");
    expect(qs(inv.outstandingOf(second.purchaseOrder.lines[0]!))).toBe("0.0000");
    expect(second.purchaseOrder.closedAt).toEqual(at(9));

    // And now it counts for nothing, or the engine sees five on order forever.
    expect(inv.onOrderFrom([second.purchaseOrder])).toEqual([]);

    // Five received in two deliveries, and five in stock at what they cost.
    const levels = inv.deriveLevels([...first.movements, ...second.movements]);
    expect(qs(levels[0]!.onHand)).toBe("5.0000");
    const run = expectOk(inv.costMovements({ movements: [...first.movements, ...second.movements], method: "fifo" }));
    expect(m(run.value)).toBe("200.0000");
  });

  it("refuses an over receipt instead of quietly creating stock nobody has a bill for", () => {
    const refusal = expectRefusal(
      inv.receivePurchaseOrder({
        purchaseOrder: po(),
        receipts: [{ lineId: "L-1", quantity: q("6"), movement: stamp("r1", 1, at(6)) }],
        now: at(6),
      }),
    );
    expect(refusal.reason).toBe("over_receipt");
    expect(inv.explainRefusal(refusal)).toContain("amended");
  });

  it("catches an over receipt split across two lines of the same delivery", () => {
    // Three and three against an order for five. Checking each receipt line
    // against the purchase order line alone would let this through.
    const refusal = expectRefusal(
      inv.receivePurchaseOrder({
        purchaseOrder: po(),
        receipts: [
          { lineId: "L-1", quantity: q("3"), movement: stamp("r1", 1, at(6)) },
          { lineId: "L-1", quantity: q("3"), movement: stamp("r2", 2, at(6)) },
        ],
        now: at(6),
      }),
    );
    expect(refusal.reason).toBe("over_receipt");
  });

  it("refuses to receive a line that was never ordered", () => {
    const refusal = expectRefusal(
      inv.receivePurchaseOrder({
        purchaseOrder: po(),
        receipts: [{ lineId: "L-9", quantity: q("1"), movement: stamp("r1", 1, at(6)) }],
        now: at(6),
      }),
    );
    expect(refusal.reason).toBe("unknown_line");
  });

  it("does not count a draft as stock that is coming", () => {
    /**
     * A purchase order sitting in somebody's drafts is not stock arriving.
     * Counting it means the reorder engine goes quiet about a part nobody
     * ever actually ordered.
     */
    expect(inv.onOrderFrom([po({ status: "draft" })])).toEqual([]);
    expect(inv.onOrderFrom([po({ status: "cancelled" })])).toEqual([]);
    expect(inv.onOrderFrom([po({ status: "acknowledged" })]).map((l) => qs(l.quantity))).toEqual(["5.0000"]);
  });

  it("closes the remainder when a short shipment is cancelled, leaving what arrived in stock", () => {
    // The vendor discontinued the part. The three that came stay received and
    // stay in stock; the two that will never come stop being on order.
    const partial = expectOk(
      inv.receivePurchaseOrder({
        purchaseOrder: po(),
        receipts: [{ lineId: "L-1", quantity: q("3"), movement: stamp("r1", 1, at(6)) }],
        now: at(6),
      }),
    );
    const cancelled = expectOk(inv.transitionPurchaseOrder(partial.purchaseOrder, "cancelled", at(11)));
    expect(qs(cancelled.purchaseOrder.lines[0]!.quantityReceived)).toBe("3.0000");
    expect(inv.onOrderFrom([cancelled.purchaseOrder])).toEqual([]);
  });
});

describe("landed cost", () => {
  it("spreads freight by value and reconciles to the cent", () => {
    /**
     * A company that books freight to an expense account believes its parts
     * cost less than they did, and prices off that belief. Fifty dollars on a
     * four hundred dollar order is twelve percent, which is most of a trade's
     * net margin.
     */
    const shares = inv.allocateLandedCost(usd("50.00"), [
      { lineId: "L-1", value: usd("400.00") },
      { lineId: "L-2", value: usd("37.50") },
    ]);
    expect(shares.map((s) => m(s.share))).toEqual(["45.7200", "4.2800"]);
    expect(m(sum(shares.map((s) => s.share)))).toBe("50.0000");
  });

  it("falls back to an even split when every line has no value", () => {
    // A warranty replacement shipment. The freight is still real and has to
    // land somewhere rather than throw.
    const shares = inv.allocateLandedCost(usd("30.01"), [
      { lineId: "L-1", value: usd("0") },
      { lineId: "L-2", value: usd("0") },
    ]);
    expect(m(sum(shares.map((s) => s.share)))).toBe("30.0100");
  });
});

describe("every movement kind and every refusal can be shown to a person", () => {
  it("describes what each kind does to each quantity", () => {
    for (const kind of inv.MOVEMENT_KINDS) {
      const effect = inv.MOVEMENT_EFFECTS[kind];
      expect(effect.label.length, kind).toBeGreaterThan(0);
      expect(effect.description.length, kind).toBeGreaterThan(25);
      expect([-1, 0, 1], kind).toContain(effect.onHand);
    }
  });

  it("gives every refusal a sentence with the numbers in it", () => {
    const refusals: inv.InventoryRefusal[] = [
      { ok: false, reason: "not_positive", detail: "A reservation needs a quantity greater than zero." },
      { ok: false, reason: "insufficient_available", itemId: COMP, locationId: WAREHOUSE, requested: q("3"), availableNow: q("1"), shortfall: q("2") },
      { ok: false, reason: "insufficient_on_hand", itemId: COMP, locationId: WAREHOUSE, requested: q("3"), onHand: q("1"), shortfall: q("2") },
      { ok: false, reason: "would_strand_commitment", itemId: COMP, locationId: WAREHOUSE, requested: q("2"), onHand: q("3"), committed: q("2") },
      { ok: false, reason: "same_location", locationId: WAREHOUSE },
      { ok: false, reason: "missing_cost", itemId: COMP, locationId: WAREHOUSE, kind: "adjustment_in" },
      { ok: false, reason: "insufficient_layers", itemId: COMP, locationId: WAREHOUSE, requested: q("3"), costable: q("1"), movementId: "i1" },
      { ok: false, reason: "currency_mismatch", itemId: COMP, expected: "USD", found: "CAD" },
      { ok: false, reason: "unpaired_transfer", transferId: "T-1", half: "out" },
      { ok: false, reason: "unpaired_transfer", transferId: "T-1", half: "in" },
      { ok: false, reason: "transfer_quantity_mismatch", transferId: "T-1", sent: q("3"), arrived: q("2") },
      { ok: false, reason: "illegal_transition", from: "received", to: "submitted" },
      { ok: false, reason: "not_receivable", purchaseOrderId: "PO-1", status: "draft" },
      { ok: false, reason: "unknown_line", purchaseOrderId: "PO-1", lineId: "L-9" },
      { ok: false, reason: "over_receipt", lineId: "L-1", ordered: q("5"), alreadyReceived: q("0"), attempted: q("6") },
    ];

    for (const refusal of refusals) {
      const text = inv.explainRefusal(refusal);
      expect(text.length, refusal.reason).toBeGreaterThan(30);
      // Never a raw storage quantity in front of a person.
      expect(text, refusal.reason).not.toContain(".0000");
    }
  });
});

/**
 * A RESERVATION BELONGS TO A JOB
 *
 * The first version of this module held `committed` as one number per item
 * per location. Every test above passed against it, because every one of them
 * had a single job in it, which is the fixture mistake this file warns about
 * at the top and then made anyway.
 *
 * The bug only appears when the shop is busy, which is the only time it
 * matters: two jobs reserve the last compressor, one technician collects
 * theirs, the single counter drops, and the other job's reservation is now
 * held against an empty shelf. Nobody finds out until a second technician
 * arrives at a property.
 */
describe("a reservation belongs to a job", () => {
  const twoJobsOneCompressor = () => [
    mv("r1", 1, at(1), "receipt", "2", { totalCost: usd("240.00") }),
    mv("c1", 2, at(2), "commit", "1", { jobId: "J-1" }),
    mv("c2", 3, at(3), "commit", "1", { jobId: "J-2" }),
  ];

  it("holds one reservation per job rather than one counter", () => {
    const open = inv.deriveCommitments(twoJobsOneCompressor());
    expect(open.map((c) => [c.jobId, qs(c.quantity)]).sort())
      .toEqual([["J-1", "1.0000"], ["J-2", "1.0000"]]);
  });

  it("still reports the total as the sum of the parts", () => {
    // One place a reservation exists, so the total and the parts cannot
    // disagree. It is derived from them rather than counted separately.
    const level = inv.deriveLevel(twoJobsOneCompressor(), COMP, WAREHOUSE);
    expect(qs(level.committed)).toBe("2.0000");
    expect(qs(inv.available(level))).toBe("0.0000");
  });

  it("discharges the reservation of the job the stock was issued for", () => {
    const history = [
      ...twoJobsOneCompressor(),
      mv("i1", 4, at(4), "issue", "1", { jobId: "J-1" }),
    ];

    // J-1 took theirs and holds nothing. J-2 still holds theirs.
    expect(qs(inv.commitmentFor(history, COMP, WAREHOUSE, "J-1"))).toBe("0.0000");
    expect(qs(inv.commitmentFor(history, COMP, WAREHOUSE, "J-2"))).toBe("1.0000");
  });

  it("never lets one job's issue eat another job's reservation", () => {
    /**
     * THE TEST THIS SECTION EXISTS FOR. J-1 takes two, which is more than
     * they reserved. Against a single counter, the extra one silently came
     * out of J-2's reservation and J-2 was left holding nothing with no
     * record of why.
     */
    const history = [
      ...twoJobsOneCompressor(),
      mv("i1", 4, at(4), "issue", "2", { jobId: "J-1" }),
    ];

    expect(qs(inv.commitmentFor(history, COMP, WAREHOUSE, "J-2"))).toBe("1.0000");
    expect(qs(inv.deriveLevel(history, COMP, WAREHOUSE).committed)).toBe("1.0000");
  });

  it("does not discharge anybody's reservation for a shop consumable", () => {
    // An issue with no job is a part coming off the shelf for nobody in
    // particular. It reduces on hand and reserves nothing, which is right:
    // nobody had reserved it.
    const history = [
      ...twoJobsOneCompressor(),
      mv("i1", 4, at(4), "issue", "1"),
    ];

    expect(qs(inv.deriveLevel(history, COMP, WAREHOUSE).committed)).toBe("2.0000");
    expect(qs(inv.deriveLevel(history, COMP, WAREHOUSE).onHand)).toBe("1.0000");
  });

  it("forgets a reservation that has been released in full", () => {
    const history = [
      ...twoJobsOneCompressor(),
      mv("rel", 4, at(4), "release", "1", { jobId: "J-2" }),
    ];
    expect(inv.deriveCommitments(history).map((c) => c.jobId)).toEqual(["J-1"]);
  });

  it("never lets a release take a job below nothing", () => {
    // A duplicated release event, which is what a retried write looks like.
    const history = [
      ...twoJobsOneCompressor(),
      mv("rel", 4, at(4), "release", "1", { jobId: "J-2" }),
      mv("rel2", 5, at(5), "release", "1", { jobId: "J-2" }),
    ];
    expect(qs(inv.commitmentFor(history, COMP, WAREHOUSE, "J-2"))).toBe("0.0000");
    expect(qs(inv.deriveLevel(history, COMP, WAREHOUSE).committed)).toBe("1.0000");
  });
});

/**
 * ISSUING A PART, WHICH HAD NO TESTS AT ALL
 *
 * `planIssue` decides whether a technician standing at a shelf is allowed to
 * take what is in their hand, and until now nothing in this file called it.
 * That is how its rule stayed wrong: it checked on hand, so the first job to
 * reach the shelf could consume a part reserved for a different one, and the
 * second job found out at a property.
 */
describe("taking a part off the shelf for a job", () => {
  const commitment = (jobId: string, quantity: string, locationId = WAREHOUSE): inv.Commitment => ({
    itemId: COMP, locationId, jobId, quantity: q(quantity),
  });

  it("lets a job consume the part reserved for it", () => {
    /**
     * The case that makes "check against available" wrong. One compressor on
     * the shelf, reserved for this job. Available is zero. Refusing here
     * tells a technician the shelf is empty while they are holding the part,
     * and what they learn from that is to stop recording issues.
     */
    const decision = inv.planIssue({
      level: level("1", "1"),
      quantity: q("1"),
      jobId: "job-a",
      stamp: stamp("i1", 10, at(5)),
      commitments: [commitment("job-a", "1")],
    });

    const ok = expectOk(decision);
    expect(ok.movements).toHaveLength(1);
    expect(ok.movements[0]!.kind).toBe("issue");
    expect(ok.movements[0]!.jobId).toBe("job-a");
  });

  it("refuses to let one job eat another job's reservation", () => {
    /**
     * The case that makes "check against on hand" wrong, and the failure this
     * whole per-job commitment design exists for. One compressor, spoken for
     * by job A. Job B is not entitled to it, and nothing downstream would
     * detect the theft: the level still folds correctly, job A's reservation
     * simply stands against an empty shelf.
     */
    const decision = inv.planIssue({
      level: level("1", "1"),
      quantity: q("1"),
      jobId: "job-b",
      stamp: stamp("i2", 11, at(5)),
      commitments: [commitment("job-a", "1")],
    });

    const refusal = expectRefusal(decision);
    expect(refusal.reason).toBe("insufficient_available");
    expect(inv.explainRefusal(refusal)).toContain("1");
  });

  it("leaves a job the balance after everybody else's reservations", () => {
    // Five on the shelf, two held for another job, one for this one. This job
    // may take three: its own reservation is not a ceiling on it.
    const decision = inv.planIssue({
      level: level("5", "3"),
      quantity: q("3"),
      jobId: "job-a",
      stamp: stamp("i3", 12, at(5)),
      commitments: [commitment("job-a", "1"), commitment("job-b", "2")],
    });

    expectOk(decision);

    const tooMany = inv.planIssue({
      level: level("5", "3"),
      quantity: q("4"),
      jobId: "job-a",
      stamp: stamp("i4", 13, at(5)),
      commitments: [commitment("job-a", "1"), commitment("job-b", "2")],
    });
    expect(expectRefusal(tooMany).reason).toBe("insufficient_available");
  });

  it("ignores a reservation held at another location", () => {
    /**
     * A part reserved off the van does not stop the warehouse issuing one.
     * Without the location comparison, stocking a second van would refuse
     * because of a reservation on the first.
     */
    const decision = inv.planIssue({
      level: level("1", "0"),
      quantity: q("1"),
      jobId: "job-b",
      stamp: stamp("i5", 14, at(5)),
      commitments: [commitment("job-a", "1", VAN)],
    });

    expectOk(decision);
  });

  it("never reports a shortfall bigger than the shelf", () => {
    /**
     * Over committed stock is a real state: two jobs reserve against a
     * delivery that arrives short. Without the clamp the arithmetic goes
     * negative and the refusal asks a technician to find four compressors
     * when there were never more than two.
     */
    const refusal = expectRefusal(inv.planIssue({
      level: level("2", "4"),
      quantity: q("2"),
      jobId: "job-c",
      stamp: stamp("i6", 15, at(5)),
      commitments: [commitment("job-a", "2"), commitment("job-b", "2")],
    }));

    if (refusal.reason !== "insufficient_available") throw new Error("wrong refusal");
    expect(qs(refusal.availableNow)).toBe("0.0000");
    expect(qs(refusal.shortfall)).toBe("2.0000");
  });

  it("refuses a quantity that is not positive", () => {
    expect(expectRefusal(inv.planIssue({
      level: level("5"),
      quantity: q("0"),
      jobId: "job-a",
      stamp: stamp("i7", 16, at(5)),
      commitments: [],
    })).reason).toBe("not_positive");
  });

  it("refuses more than is on the shelf even with nothing reserved", () => {
    expect(expectRefusal(inv.planIssue({
      level: level("2"),
      quantity: q("3"),
      jobId: "job-a",
      stamp: stamp("i8", 17, at(5)),
      commitments: [],
    })).reason).toBe("insufficient_available");
  });
});
