import { describe, it, expect } from "vitest";
import { authorization as auth, money as m } from "../src/index";

/**
 * THE CEILING
 *
 * A facilities network authorises five hundred dollars, the technician finds
 * more wrong, the office invoices nine hundred, and the network pays five
 * hundred and disputes the rest. The four hundred is not a receivable, it is
 * a write-off, and nobody notices until the aging report has a column of
 * them.
 */
const usd = (v: string) => m.money(v, "USD");
const granted = (over: Partial<auth.Authorization> = {}): auth.Authorization => ({
  state: "granted", amount: usd("500.00"), consumed: usd("0.00"), ...over,
});

describe("billing under a ceiling", () => {
  it("allows what fits", () => {
    const decision = auth.decide(granted(), usd("400.00"));
    expect(decision.ok).toBe(true);
    expect(decision.ok && m.toString(decision.remaining!)).toBe("100.0000");
  });

  it("allows exactly the ceiling", () => {
    // Off by one here is a refusal on the most common invoice there is: the
    // one for exactly what was authorised.
    expect(auth.decide(granted(), usd("500.00")).ok).toBe(true);
  });

  it("refuses a cent over", () => {
    expect(auth.decide(granted(), usd("500.01")).ok).toBe(false);
  });

  it("counts what is already billed", () => {
    // A second invoice on the same job is where this is usually got wrong:
    // each one fits on its own and together they do not.
    const decision = auth.decide(granted({ consumed: usd("300.00") }), usd("300.00"));
    expect(decision.ok).toBe(false);
    expect(!decision.ok && m.toString(decision.over!)).toBe("100.0000");
  });

  it("says what to do instead of saying no", () => {
    /**
     * Whoever is invoicing did not ask for the authorisation and cannot see
     * it. A refusal that does not name the ceiling, what is already billed
     * and what would fit is a refusal somebody overrides by turning the
     * feature off.
     */
    const decision = auth.decide(granted({ consumed: usd("300.00") }), usd("400.00"));
    expect(!decision.ok && decision.detail).toContain("500.0000");
    expect(!decision.ok && decision.detail).toContain("300.0000");
    expect(!decision.ok && decision.detail).toContain("200.0000");
    expect(!decision.ok && decision.detail).toMatch(/supplement/);
  });
});

describe("what is not a ceiling", () => {
  it("allows anything when there is no authorisation at all", () => {
    /**
     * This is a ceiling, not a permission system. A residential job has
     * nobody to authorise it, and refusing everything without one would make
     * the ordinary case impossible.
     */
    expect(auth.decide(null, usd("9000.00")).ok).toBe(true);
  });

  it("allows anything when the authorisation states no limit", () => {
    // "Approved, bill what it costs" is a real answer a client gives, and
    // treating a null ceiling as zero would refuse every one of them.
    const decision = auth.decide(granted({ amount: null }), usd("9000.00"));
    expect(decision.ok).toBe(true);
    expect(decision.ok && decision.remaining).toBeNull();
  });
});

describe("an authorisation that is not a yes", () => {
  it("refuses one nobody has granted yet", () => {
    expect(auth.decide(granted({ state: "requested" }), usd("100.00")))
      .toMatchObject({ ok: false, reason: "not_granted" });
  });

  it("says plainly when it was denied", () => {
    const decision = auth.decide(granted({ state: "denied" }), usd("100.00"));
    expect(!decision.ok && decision.detail).toBe("This work was not authorised.");
  });

  it("refuses one that has expired", () => {
    // An authorisation with a date on it is a client saying "this week".
    const decision = auth.decide(
      granted({ expiresAt: new Date("2026-01-01T00:00:00Z") }),
      usd("100.00"),
      new Date("2026-02-01T00:00:00Z"),
    );
    expect(decision).toMatchObject({ ok: false, reason: "expired" });
  });

  it("allows one that has not expired yet", () => {
    expect(auth.decide(
      granted({ expiresAt: new Date("2026-03-01T00:00:00Z") }),
      usd("100.00"),
      new Date("2026-02-01T00:00:00Z"),
    ).ok).toBe(true);
  });
});

describe("recording that we went over", () => {
  it("marks an authorisation exceeded rather than refusing silently", () => {
    /**
     * Some networks allow the overage and chase it afterwards. Recording it
     * is what makes "how often do we go over, and with whom" a question with
     * an answer.
     */
    expect(auth.stateAfter(granted(), usd("600.00"))).toBe("exceeded");
    expect(auth.stateAfter(granted(), usd("400.00"))).toBe("granted");
    expect(auth.stateAfter(granted({ amount: null }), usd("9000.00"))).toBe("granted");
  });

  it("reports what is left", () => {
    expect(m.toString(auth.remaining(granted({ consumed: usd("125.50") }))!)).toBe("374.5000");
    expect(auth.remaining(granted({ amount: null }))).toBeNull();
  });
});
