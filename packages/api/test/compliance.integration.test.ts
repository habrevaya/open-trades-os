import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { PermissionError, type Actor, type Permission } from "@opentradesos/core";
import * as compliance from "../src/services/compliance";
import * as obligations from "../src/services/obligations";
import * as files from "../src/services/files";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * DOCUMENTS, REGULATORY SUBMISSIONS AND THE FIGURES THAT MOVE
 *
 * `regulatory_submission` and `regulatory_constant` had never been touched by
 * any code, and `document:write` was in the permission catalogue, on every
 * office role, and asserted nowhere, so an owner who withheld it withheld
 * nothing.
 *
 * THE PROPERTY MOST OF THIS FILE IS ABOUT is that nothing here reaches a
 * conclusion it is not entitled to reach. Everything else is downstream of
 * it: an expiry is a date arriving rather than a state somebody stored, an
 * acknowledgement is proof only if the authority's own reference is on the
 * row, and a figure nobody has republished is reported as out of date rather
 * than quietly used.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("m23:org");
const USER = fixtureId("m23:user");

let raw: postgres.Sql;
const db = () => testDb(url!);

const as = (roles: string[], grants: Permission[] = []): ServiceContext => ({
  actor: {
    userId: USER,
    organizationId: ORG,
    roles: roles as Actor["roles"],
    ...(grants.length > 0 ? { grants } : {}),
  },
  db: db(),
});
const owner = () => as(["owner"]);

/**
 * Actors holding exactly ONE of a pair.
 *
 * A role holding neither cannot tell two permissions apart: every call fails
 * and the test passes whichever permission the service actually asserts, which
 * is the shape of permission test that proves nothing. These hold one each, so
 * swapping the guard in the service makes one of them go red.
 */
const docReader = () => as([], ["document:read"]);
const docWriter = () => as([], ["document:write"]);
const complianceReader = () => as([], ["compliance:read"]);
const complianceWriter = () => as([], ["compliance:write"]);

const DOC = {
  kind: "licence",
  name: "Texas Master Plumber licence",
  reference: "M-41122",
  issuerName: "TSBPE",
  jurisdiction: "TX",
  issuedOn: "2025-01-01",
  expiresOn: "2026-12-31",
  noticeDays: 45,
};

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Rowe Plumbing", slug: "m23-rowe" });
  await raw`update public.organization set primary_trade = 'pest-control', timezone = 'America/Chicago' where id = ${ORG}`;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.attachment where organization_id = ${ORG}`;
  await raw`delete from public.stored_file where organization_id = ${ORG}`;
  await raw`delete from public.obligation where organization_id = ${ORG}`;
  await raw`delete from public.compliance_document where organization_id = ${ORG}`;
  await raw`delete from public.regulatory_submission where organization_id = ${ORG}`;
  await raw`delete from public.regulatory_constant where organization_id = ${ORG}`;
});

/* ----------------------------------------------------------- the register */

run("a document with an expiry somebody has to act on", () => {
  it("files it and puts the renewal in the queue the office already works", async () => {
    const doc = await compliance.register(owner(), DOC);
    expect(doc.name).toBe(DOC.name);
    expect(doc.expiresOn).toBe("2026-12-31");

    /**
     * The point of the whole design. The deadline is an `obligation`, so it
     * appears beside every other approaching deadline rather than on a screen
     * somebody has to remember to open.
     */
    const live = await obligations.open(owner(), { kind: "compliance.document_expiry" });
    expect(live).toHaveLength(1);
    expect(live[0]!.entityType).toBe("compliance_document");
    expect(live[0]!.entityId).toBe(doc.id);
    expect(live[0]!.consequence).toContain("2026-12-31");
  });

  it("makes the deadline the day the renewal must START, not the expiry", async () => {
    const doc = await compliance.register(owner(), DOC);
    const live = await obligations.open(owner(), { kind: "compliance.document_expiry" });

    /**
     * Forty five days of notice on a 31 December expiry means act by 16
     * November, and the obligation is due at the END of that day in the
     * company's zone. A queue that only lit up on 31 December would tell a
     * contractor about a ten week licence renewal on the morning it ran out,
     * which is the failure this module exists to prevent.
     */
    expect(doc.actBy).toBe("2026-11-16");
    expect(live[0]!.dueAt.toISOString()).toBe("2026-11-17T06:00:00.000Z");
    /** And the escalation is the expiry itself, when the consequence lands. */
    expect(live[0]!.escalateAt?.toISOString()).toBe("2026-12-31T06:00:00.000Z");
  });

  it("raises nothing for a document that does not expire", async () => {
    await compliance.register(owner(), {
      kind: "sds",
      name: "Termidor SC safety data sheet",
      issuedOn: "2025-03-01",
    });
    /**
     * A safety data sheet is reissued when the formulation changes rather
     * than on a date. Inventing an expiry would put a false deadline in a
     * real queue every year, and a queue with false deadlines in it is one
     * people learn to dismiss.
     */
    expect(await obligations.open(owner(), {})).toHaveLength(0);
    const [doc] = await compliance.documents(owner(), {});
    expect(doc!.standing).toBe("no_expiry");
  });

  it("refuses a document that would arrive already expired", async () => {
    await expect(compliance.register(owner(), {
      kind: "insurance", name: "General liability",
      issuedOn: "2026-05-01", expiresOn: "2025-05-01",
    })).rejects.toThrow(/typing mistake/i);
  });

  it("refuses a document with no name, which would file as a blank row", async () => {
    await expect(compliance.register(owner(), { ...DOC, name: "   " }))
      .rejects.toThrow(/needs a name/i);
    await expect(compliance.register(owner(), { ...DOC, kind: "  " }))
      .rejects.toThrow(/needs a kind/i);
  });

  it("refuses a negative notice period, which would act after the expiry", async () => {
    await expect(compliance.register(owner(), { ...DOC, noticeDays: -5 }))
      .rejects.toThrow(/cannot be negative/i);
  });

  it("refuses a storage key that names no stored file", async () => {
    await expect(compliance.register(owner(), {
      ...DOC, storageKey: "org/nothing/deadbeef.pdf",
    })).rejects.toThrow(/no stored file under that key/i);
  });

  it("attaches the bytes through the store that already exists", async () => {
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001"
      + "0d0a2db40000000049454e44ae426082", "hex");
    const stored = await db().transaction(async (tx) =>
      files.put(tx as never, ORG, { bytes: png, claimedType: "image/png" }));

    const doc = await compliance.register(owner(), {
      ...DOC, storageKey: stored.file.storageKey,
    });

    const attached = await files.attachmentsFor(owner(), {
      entityType: "compliance_document", entityId: doc.id,
    });
    expect(attached).toHaveLength(1);
    expect(attached[0]!.storageKey).toBe(stored.file.storageKey);

    /** And the reference count the store maintains was incremented, not ignored. */
    const [row] = await raw<{ references: number }[]>`
      select "references" from public.stored_file where storage_key = ${stored.file.storageKey}`;
    expect(row!.references).toBe(1);
  });
});

run("expiry is a date arriving, not a state anybody stored", () => {
  it("reads as expired with no sweep having run", async () => {
    await compliance.register(owner(), { ...DOC, expiresOn: "2026-12-31" });

    /**
     * The row's own `state` column still says `active`, because nothing moves
     * it and nothing should: if expiry were stored, a sweep that is not
     * deployed, or died three weeks ago, would leave every document reading
     * current and the screen would say everything is in date. A monitoring
     * surface whose failure mode is a clean bill of health is worse than none.
     */
    const [stateRow] = await raw<{ state: string }[]>`
      select state from public.compliance_document where organization_id = ${ORG}`;
    expect(stateRow!.state).toBe("active");

    const [view] = await compliance.documents(owner(), { asOf: "2027-02-10" });
    expect(view!.standing).toBe("expired");
    expect(view!.daysUntilExpiry).toBe(-41);
    expect(view!.statement).toContain("expired on 2026-12-31");
  });

  it("moves to act_now on the day the operator's own notice period says to start", async () => {
    await compliance.register(owner(), DOC);

    const [before] = await compliance.documents(owner(), { asOf: "2026-11-15" });
    expect(before!.standing).toBe("upcoming");

    const [on] = await compliance.documents(owner(), { asOf: "2026-11-16" });
    expect(on!.standing).toBe("act_now");
  });

  it("sorts the ones with no expiry last rather than first", async () => {
    await compliance.register(owner(), { kind: "sds", name: "No expiry" });
    await compliance.register(owner(), { ...DOC, name: "Expires" });

    const views = await compliance.documents(owner(), {});
    /**
     * Soonest first, and the document that needs no attention at the bottom.
     * `nulls last` is Postgres's own default for an ascending sort and is
     * written out anyway, because the thing that would break this is somebody
     * reversing the order, and a reversed order puts the document with no
     * expiry at the top of the renewal screen.
     */
    expect(views.map((v) => v.name)).toEqual(["Expires", "No expiry"]);
  });
});

run("renewing a document", () => {
  it("writes a new row and keeps the old one", async () => {
    const first = await compliance.register(owner(), DOC);
    const second = await compliance.renew(owner(), {
      id: first.id, kind: DOC.kind, name: DOC.name,
      issuedOn: "2026-12-01", expiresOn: "2028-12-31",
    });

    expect(second.id).not.toBe(first.id);
    expect(second.supersedesId).toBe(first.id);

    /**
     * The old row survives as `superseded`. Editing the expiry in place
     * answers "when does it run out" and destroys "what were you holding in
     * March", which is the question an insurer actually asks.
     */
    const all = await compliance.documents(owner(), { includeReplaced: true });
    expect(all).toHaveLength(2);
    expect(all.find((d) => d.id === first.id)!.state).toBe("superseded");

    /** And the default read shows only what is in force. */
    const live = await compliance.documents(owner(), {});
    expect(live.map((d) => d.id)).toEqual([second.id]);
  });

  it("cancels the old deadline and raises the new one", async () => {
    const first = await compliance.register(owner(), DOC);
    const second = await compliance.renew(owner(), {
      id: first.id, kind: DOC.kind, name: DOC.name, expiresOn: "2028-12-31",
    });

    const live = await obligations.open(owner(), { kind: "compliance.document_expiry" });
    expect(live.map((o) => o.entityId)).toEqual([second.id]);

    /**
     * Cancelled rather than satisfied, which is the distinction
     * `obligations.ts` draws: the deadline stopped being owed because the
     * thing it was attached to was replaced, and a scorecard asking how many
     * deadlines were met must not count it as one that was.
     */
    const [old] = await raw<{ state: string }[]>`
      select state from public.obligation where entity_id = ${first.id}`;
    expect(old!.state).toBe("cancelled");
  });

  it("refuses to renew one that is not the document in force", async () => {
    const first = await compliance.register(owner(), DOC);
    await compliance.renew(owner(), { id: first.id, kind: DOC.kind, name: DOC.name, expiresOn: "2028-12-31" });

    await expect(compliance.renew(owner(), {
      id: first.id, kind: DOC.kind, name: DOC.name, expiresOn: "2030-01-01",
    })).rejects.toThrow(/two live documents/i);
  });
});

run("withdrawing a document", () => {
  it("needs a reason", async () => {
    const doc = await compliance.register(owner(), DOC);
    await expect(compliance.withdraw(owner(), { id: doc.id, reason: "   " }))
      .rejects.toThrow(/reads as a mistake/i);
  });

  it("records the reason and cancels the deadline", async () => {
    const doc = await compliance.register(owner(), DOC);
    const after = await compliance.withdraw(owner(), { id: doc.id, reason: "Revoked by the board" });

    expect(after.state).toBe("withdrawn");
    expect(after.statement).toContain("Revoked by the board");
    expect(await obligations.open(owner(), { kind: "compliance.document_expiry" })).toHaveLength(0);
  });

  it("does not exist for a document in another organization", async () => {
    await expect(compliance.withdraw(owner(), {
      id: fixtureId("m23:not-a-document"), reason: "x",
    })).rejects.toBeInstanceOf(NotFoundError);
  });
});

/* ------------------------------------------- the conclusion it must not reach */

run("the product does not tell anybody they are compliant", () => {
  it("summarises in counts, with no verdict field anywhere in the shape", async () => {
    await compliance.register(owner(), DOC);
    await compliance.register(owner(), { kind: "sds", name: "No expiry" });

    const result = await compliance.summary(owner(), { asOf: "2027-02-10" });

    /**
     * The KEY SET is asserted, not just the values. A boolean, a percentage
     * or a word like "ready" added here would be a claim that the documents
     * a business is required to hold are all present, drawn from a set this
     * register does not know the size of.
     */
    expect(Object.keys(result).sort()).toEqual([
      "actNow", "expired", "expiredAndRequiredForWork", "noExpiry", "upcoming",
    ]);
    for (const value of Object.values(result)) expect(typeof value).toBe("number");
    expect(result.expired).toBe(1);
    expect(result.noExpiry).toBe(1);
  });

  it("says a document lapsed rather than that work is barred", async () => {
    const tech = fixtureId("m23:tech");
    await compliance.register(owner(), {
      ...DOC, subjectType: "technician", subjectId: tech, requiredForWork: true,
    });
    await compliance.register(owner(), {
      kind: "training", name: "Confined space refresher",
      subjectType: "technician", subjectId: tech,
      expiresOn: "2026-12-31", requiredForWork: false,
    });

    const blocked = await compliance.blockedSubjects(owner(), { asOf: "2027-02-10" });
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.subjectId).toBe(tech);

    /**
     * Only the one the OPERATOR flagged. The other certificate is just as
     * expired and is not in this list, because this function reports their
     * declaration back to them rather than deciding what work requires.
     */
    expect(blocked[0]!.documents).toHaveLength(1);
    expect(blocked[0]!.documents[0]!.name).toBe(DOC.name);
    expect(blocked[0]!.documents[0]!.statement)
      .toContain("should not be assigned while it is lapsed");
  });

  it("lists nobody when the lapsed document was not flagged as required", async () => {
    await compliance.register(owner(), { ...DOC, requiredForWork: false });
    expect(await compliance.blockedSubjects(owner(), { asOf: "2027-02-10" })).toEqual([]);
  });

  it("lists nobody while the required document is still in date", async () => {
    /**
     * The other half of the filter. A document flagged as required and not
     * yet expired is not a blocker, and a version that reported every flagged
     * document would empty the list of its meaning within a week.
     */
    await compliance.register(owner(), { ...DOC, requiredForWork: true });
    expect(await compliance.blockedSubjects(owner(), { asOf: "2026-11-20" })).toEqual([]);
  });
});

/**
 * The same rule, checked against the SOURCE rather than against one call.
 *
 * Every assertion above can only see the outputs it happens to ask for. This
 * reads the string literals this module can emit, which is the complete set of
 * sentences it can ever put in front of somebody, and fails if any of them
 * uses the word. A comment explaining why the product does not say it is fine;
 * a string that says it is not.
 */
describe("no sentence this module can emit calls anybody compliant", () => {
  const FILES = [
    join(import.meta.dirname, "../src/services/compliance.ts"),
    join(import.meta.dirname, "../src/contracts/compliance.ts"),
  ];

  const literals = (path: string): string[] => {
    const text = readFileSync(path, "utf8");
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true);
    const out: string[] = [];
    const walk = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
      else if (ts.isTemplateExpression(node)) {
        out.push(node.head.text, ...node.templateSpans.map((s) => s.literal.text));
      }
      ts.forEachChild(node, walk);
    };
    walk(file);
    return out;
  };

  it("reads the module at all", () => {
    /** The vacuous case: a walker that found nothing would pass by finding nothing. */
    const all = FILES.flatMap(literals);
    expect(all.length).toBeGreaterThan(100);
    expect(all.join(" ")).toContain("expired on");
  });

  it("never states the conclusion", () => {
    const offending = FILES.flatMap((path) =>
      literals(path).filter((value) => /\bcompliant\b|\bin compliance\b/i.test(value))
        .map((value) => `${path.split("/").slice(-2).join("/")}: ${value.slice(0, 80)}`));

    /**
     * "You are compliant" is a claim about a set this product holds half of.
     * Fix by saying what the row says instead: a document expired, a filing
     * was acknowledged, a figure is out of date.
     */
    expect(offending, "a string this module can show somebody reaches a legal conclusion")
      .toEqual([]);
  });
});

/* ---------------------------------------------------- regulatory submissions */

run("a regulatory submission", () => {
  it("takes its programme from the trade pack rather than a copy of it", async () => {
    const declared = await compliance.declared(owner());
    /**
     * Read from the pack at the moment it is asked for. A copy in a table
     * would be the stale one: a pack release that corrects an authority's
     * name would correct it for new companies only.
     */
    expect(declared.map((d) => d.kind)).toContain("pesticide.use_report");
    expect(declared.find((d) => d.kind === "pesticide.use_report")!.route).toBe("portal");
  });

  it("takes the authority from the pack and refuses a second copy of it", async () => {
    const opened = await compliance.openSubmission(owner(), {
      kind: "pesticide.use_report",
      periodStart: "2026-01-01", periodEnd: "2026-01-31",
      dueOn: "2026-02-15",
    });
    expect(opened.authorityName).toContain("State pesticide lead agency");
    expect(opened.route).toBe("portal");

    await expect(compliance.openSubmission(owner(), {
      kind: "pesticide.use_report",
      periodStart: "2026-02-01", periodEnd: "2026-02-28",
      dueOn: "2026-03-15",
      authorityName: "Somebody else",
    })).rejects.toThrow(/two places/i);
  });

  it("insists on an authority for a kind no pack declares", async () => {
    await expect(compliance.openSubmission(owner(), {
      kind: "local.diversion_report", dueOn: "2026-03-15",
    })).rejects.toThrow(/has to be named here/i);

    const ok = await compliance.openSubmission(owner(), {
      kind: "local.diversion_report", dueOn: "2026-03-15",
      authorityName: "City of Austin",
    });
    expect(ok.authorityName).toBe("City of Austin");
  });

  it("refuses a reporting period that ends before it starts", async () => {
    await expect(compliance.openSubmission(owner(), {
      kind: "pesticide.use_report",
      periodStart: "2026-03-01", periodEnd: "2026-01-31", dueOn: "2026-04-15",
    })).rejects.toThrow(/ends before it starts/i);
  });

  it("is deduplicated by the period, which is what the period is for", async () => {
    const first = await compliance.openSubmission(owner(), {
      kind: "pesticide.use_report",
      periodStart: "2026-01-01", periodEnd: "2026-01-31", dueOn: "2026-02-15",
    });
    const second = await compliance.openSubmission(owner(), {
      kind: "pesticide.use_report",
      periodStart: "2026-01-01", periodEnd: "2026-01-31", dueOn: "2026-02-15",
    });
    expect(second.id).toBe(first.id);

    const rows = await raw<{ count: string }[]>`
      select count(*)::text from public.regulatory_submission where organization_id = ${ORG}`;
    expect(rows[0]!.count).toBe("1");
  });

  it("is overdue because the date passed, not because a sweep said so", async () => {
    await compliance.openSubmission(owner(), {
      kind: "pesticide.use_report",
      periodStart: "2026-01-01", periodEnd: "2026-01-31", dueOn: "2026-02-15",
    });

    const [row] = await raw<{ state: string }[]>`
      select state from public.regulatory_submission where organization_id = ${ORG}`;
    /** Nothing moved it. The row still says `due`, which is correct. */
    expect(row!.state).toBe("due");

    const late = await compliance.calendar(owner(), { asOf: "2026-03-01" });
    expect(late[0]!.overdue).toBe(true);
    expect(late[0]!.statement).toContain("14 days ago");

    const early = await compliance.calendar(owner(), { asOf: "2026-02-01" });
    expect(early[0]!.overdue).toBe(false);
  });
});

run("what the authority said is the record", () => {
  const open = () => compliance.openSubmission(owner(), {
    kind: "pesticide.use_report",
    periodStart: "2026-01-01", periodEnd: "2026-01-31", dueOn: "2026-02-15",
  });

  it("refuses an acknowledgement with no reference from the authority", async () => {
    const s = await open();
    await compliance.advance(owner(), {
      id: s.id, to: "submitted", payload: { applications: 12 },
    });

    /**
     * The single rule that makes this table's retention claim true. An
     * acknowledged row with no confirmation number is somebody having clicked
     * a button, and three years of those is a history that falls apart the
     * first time it is tested.
     */
    await expect(compliance.advance(owner(), { id: s.id, to: "acknowledged" }))
      .rejects.toThrow(/needs the reference/i);

    const ok = await compliance.advance(owner(), {
      id: s.id, to: "acknowledged", reference: "TXP-2026-00881",
    });
    expect(ok.acknowledgementReference).toBe("TXP-2026-00881");
    expect(ok.statement).toContain("TXP-2026-00881");
  });

  it("refuses to file without keeping what was filed", async () => {
    const s = await open();
    await expect(compliance.advance(owner(), { id: s.id, to: "submitted" }))
      .rejects.toThrow(/cannot be produced for an authority later/i);
  });

  it("will not rewrite a filing an authority already acknowledged", async () => {
    const s = await open();
    await compliance.advance(owner(), { id: s.id, to: "submitted", payload: { applications: 12 } });
    await compliance.advance(owner(), { id: s.id, to: "acknowledged", reference: "TXP-1" });

    await expect(compliance.advance(owner(), { id: s.id, to: "rejected", reason: "actually no" }))
      .rejects.toThrow(/already acknowledged/i);
  });

  it("refuses to make resubmission a state on the rejected filing", async () => {
    const s = await open();
    await expect(compliance.advance(owner(), { id: s.id, to: "resubmitted" as never }))
      .rejects.toThrow(/new filing that supersedes/i);
  });

  it("needs a reason to reject and to waive", async () => {
    const s = await open();
    await expect(compliance.advance(owner(), { id: s.id, to: "rejected" }))
      .rejects.toThrow(/needs a reason/i);
    await expect(compliance.advance(owner(), { id: s.id, to: "waived" }))
      .rejects.toThrow(/needs a reason/i);
  });

  it("resubmits as a new filing that points back at the rejected one", async () => {
    const s = await open();
    await compliance.advance(owner(), { id: s.id, to: "submitted", payload: { applications: 12 } });
    await compliance.advance(owner(), {
      id: s.id, to: "rejected", reason: "Applicator licence number missing on four records",
    });

    const again = await compliance.resubmit(owner(), { id: s.id, dueOn: "2026-03-15" });
    expect(again.supersedesId).toBe(s.id);
    expect(again.state).toBe("due");

    /**
     * The rejected filing survives, with what the authority said on it. An in
     * place reopen would destroy the one sentence a contractor needs when the
     * same question comes back in two years.
     */
    const all = await compliance.calendar(owner(), { includeSettled: true });
    const original = all.find((r) => r.id === s.id)!;
    expect(original.state).toBe("resubmitted");
    expect(original.rejectionReason).toContain("Applicator licence number missing");
  });

  it("will not resubmit something that was not rejected", async () => {
    const s = await open();
    await expect(compliance.resubmit(owner(), { id: s.id }))
      .rejects.toThrow(/Only a rejected filing/i);
  });

  it("drops settled filings off the calendar and keeps the rest", async () => {
    const s = await open();
    await compliance.advance(owner(), { id: s.id, to: "submitted", payload: { x: 1 } });
    await compliance.advance(owner(), { id: s.id, to: "acknowledged", reference: "TXP-2" });

    await compliance.openSubmission(owner(), {
      kind: "pesticide.use_report",
      periodStart: "2026-02-01", periodEnd: "2026-02-28", dueOn: "2026-03-15",
    });

    const live = await compliance.calendar(owner(), {});
    expect(live.map((r) => r.periodStart)).toEqual(["2026-02-01"]);
    expect(await compliance.calendar(owner(), { includeSettled: true })).toHaveLength(2);
  });

  it("takes the deadline off the queue when the filing is settled", async () => {
    const s = await open();
    expect(await obligations.open(owner(), { kind: "compliance.submission_due" })).toHaveLength(1);

    await compliance.advance(owner(), { id: s.id, to: "waived", reason: "No applications in the period" });
    expect(await obligations.open(owner(), { kind: "compliance.submission_due" })).toHaveLength(0);
  });
});

/* ---------------------------------------------------- regulatory constants */

run("a published figure that changes on a date", () => {
  it("closes the previous window instead of overwriting it", async () => {
    await compliance.publishConstant(owner(), {
      key: "tax.1099_nec_threshold", value: "600", unit: "USD",
      effectiveFrom: "2020-01-01", basis: "Operator's accountant, 2020",
    });
    await compliance.publishConstant(owner(), {
      key: "tax.1099_nec_threshold", value: "2000", unit: "USD",
      effectiveFrom: "2026-01-01", basis: "Operator's accountant, 2026",
    });

    /**
     * The whole reason this is a table. A payroll export re-run for 2024 has
     * to use 2024's figure, and a system that overwrote the number answers
     * with this year's and shows no sign of having done so.
     */
    const then = await compliance.constantOn(owner(), {
      key: "tax.1099_nec_threshold", on: "2024-06-01",
    });
    expect(then.found).toBe(true);
    expect(then.found && then.constant.value).toBe("600");
    expect(then.found && then.constant.effectiveTo).toBe("2025-12-31");

    const now = await compliance.constantOn(owner(), {
      key: "tax.1099_nec_threshold", on: "2026-06-01",
    });
    expect(now.found && now.constant.value).toBe("2000");
    expect(now.found && now.constant.effectiveTo).toBe(null);
  });

  it("refuses two figures in force on the same day", async () => {
    await compliance.publishConstant(owner(), {
      key: "fee.permit", value: "95", effectiveFrom: "2026-01-01",
    });
    await expect(compliance.publishConstant(owner(), {
      key: "fee.permit", value: "110", effectiveFrom: "2026-01-01",
    })).rejects.toThrow(/two answers/i);
  });

  it("refuses a key the trade packs already own", async () => {
    /**
     * `retention.retainMonths` is the one jurisdiction derived figure a trade
     * pack really carries, and `trade-pack.ts` already seeds it into
     * `retention_policy`. A second copy here would be two answers to how long
     * a record has to be kept, which is the defect this codebase keeps
     * finding.
     */
    await expect(compliance.publishConstant(owner(), {
      key: "retention.service_report.months", value: "36", effectiveFrom: "2026-01-01",
    })).rejects.toThrow(/retention_policy/);
  });

  it("says a figure has run out rather than quietly using the old one", async () => {
    await compliance.publishConstant(owner(), {
      key: "fee.permit", value: "95", effectiveFrom: "2025-01-01",
    });
    await compliance.publishConstant(owner(), {
      key: "fee.permit", value: "110", effectiveFrom: "2026-01-01",
    });
    /** Close the current window by hand, as an operator would who knows it lapses. */
    await raw`update public.regulatory_constant set effective_to = '2026-06-30'
              where organization_id = ${ORG} and effective_from = '2026-01-01'`;

    const after = await compliance.constantOn(owner(), { key: "fee.permit", on: "2026-09-01" });
    expect(after.found).toBe(false);
    expect(!after.found && after.reason).toMatch(/publish the next one/i);
    /**
     * The last known value comes back so a screen can show what is being used
     * and say it is out of date. A caller that caught an error and fell back
     * to a default would be a hardcoded constant with extra steps.
     */
    expect(!after.found && after.lastKnown?.value).toBe("110");

    const stale = await compliance.staleConstants(owner(), { asOf: "2026-09-01" });
    expect(stale).toEqual([
      { key: "fee.permit", jurisdiction: "US", lastValue: "110", endedOn: "2026-06-30" },
    ]);
  });

  it("does not call a figure stale while its window is still open", async () => {
    await compliance.publishConstant(owner(), {
      key: "fee.permit", value: "110", effectiveFrom: "2026-01-01",
    });
    expect(await compliance.staleConstants(owner(), { asOf: "2027-01-01" })).toEqual([]);
  });

  it("says plainly when nothing has ever been published", async () => {
    const none = await compliance.constantOn(owner(), { key: "fee.nothing", on: "2026-01-01" });
    expect(none.found).toBe(false);
    expect(!none.found && none.lastKnown).toBe(null);
  });
});

/* ------------------------------------------------------------- permissions */

run("the permissions this module promises", () => {
  it("lets document:read look and not file", async () => {
    await compliance.register(owner(), DOC);

    expect(await compliance.documents(docReader(), {})).toHaveLength(1);
    await expect(compliance.register(docReader(), DOC))
      .rejects.toBeInstanceOf(PermissionError);
  });

  it("lets document:write file and not look", async () => {
    /**
     * The other half of the pair, and the half that makes the test above mean
     * something. An actor holding neither permission fails both calls and
     * would pass whichever guard the service actually asserted.
     */
    await compliance.register(docWriter(), DOC);
    await expect(compliance.documents(docWriter(), {}))
      .rejects.toBeInstanceOf(PermissionError);
  });

  it("keeps renewing and withdrawing behind document:write and nothing else", async () => {
    const first = await compliance.register(owner(), DOC);
    await expect(compliance.renew(docReader(), { id: first.id, kind: "licence", name: "x" }))
      .rejects.toBeInstanceOf(PermissionError);
    await expect(compliance.withdraw(docReader(), { id: first.id, reason: "x" }))
      .rejects.toBeInstanceOf(PermissionError);

    /**
     * And the holder of the write permission really can do both.
     *
     * Without these two lines the refusals above prove nothing about WHICH
     * permission is asserted: `docReader` holds neither `document:write` nor
     * `compliance:write`, so swapping the guard for the wrong one would leave
     * the test green. This is the half that pins it down.
     */
    const renewed = await compliance.renew(docWriter(), {
      id: first.id, kind: DOC.kind, name: DOC.name, expiresOn: "2028-12-31",
    });
    expect(renewed.supersedesId).toBe(first.id);
    const gone = await compliance.withdraw(docWriter(), { id: renewed.id, reason: "Board revoked it" });
    expect(gone.state).toBe("withdrawn");
  });

  it("does not let the filing cabinet permission touch the regulatory record", async () => {
    /**
     * `document:write` is "Manage company documents" and `compliance:write`
     * is "Manage licences, insurance and compliance records". Filing a
     * certificate of insurance must not entitle somebody to mark a statutory
     * filing as accepted by an authority, so the two are asserted separately
     * and this is what proves they are.
     */
    await expect(compliance.openSubmission(docWriter(), {
      kind: "local.x", dueOn: "2026-01-01", authorityName: "City",
    })).rejects.toBeInstanceOf(PermissionError);
    await expect(compliance.publishConstant(docWriter(), {
      key: "fee.permit", value: "1", effectiveFrom: "2026-01-01",
    })).rejects.toBeInstanceOf(PermissionError);
  });

  it("lets compliance:read read the calendar and not change it", async () => {
    await compliance.openSubmission(owner(), {
      kind: "pesticide.use_report", periodStart: "2026-01-01", periodEnd: "2026-01-31",
      dueOn: "2026-02-15",
    });

    expect(await compliance.calendar(complianceReader(), {})).toHaveLength(1);
    expect(await compliance.staleConstants(complianceReader(), {})).toEqual([]);

    await expect(compliance.openSubmission(complianceReader(), {
      kind: "local.x", dueOn: "2026-01-01", authorityName: "City",
    })).rejects.toBeInstanceOf(PermissionError);
    await expect(compliance.publishConstant(complianceReader(), {
      key: "fee.permit", value: "1", effectiveFrom: "2026-01-01",
    })).rejects.toBeInstanceOf(PermissionError);
  });

  it("lets compliance:write change the calendar and not read it back", async () => {
    const s = await compliance.openSubmission(complianceWriter(), {
      kind: "local.x", dueOn: "2026-01-01", authorityName: "City",
    });
    await compliance.publishConstant(complianceWriter(), {
      key: "fee.permit", value: "1", effectiveFrom: "2026-01-01",
    });
    expect(s.state).toBe("due");

    await expect(compliance.calendar(complianceWriter(), {}))
      .rejects.toBeInstanceOf(PermissionError);
    await expect(compliance.declared(complianceWriter()))
      .rejects.toBeInstanceOf(PermissionError);
    await expect(compliance.constantOn(complianceWriter(), { key: "fee.permit", on: "2026-06-01" }))
      .rejects.toBeInstanceOf(PermissionError);
  });

  it("refuses advancing and resubmitting without compliance:write", async () => {
    const s = await compliance.openSubmission(owner(), {
      kind: "local.x", dueOn: "2026-01-01", authorityName: "City",
    });
    await expect(compliance.advance(complianceReader(), { id: s.id, to: "prepared" }))
      .rejects.toBeInstanceOf(PermissionError);
    await expect(compliance.resubmit(complianceReader(), { id: s.id }))
      .rejects.toBeInstanceOf(PermissionError);
  });
});

run("errors say what kind of thing they are", () => {
  it("is a ConflictError rather than a bare throw", async () => {
    await expect(compliance.publishConstant(owner(), {
      key: "retention.x", value: "1", effectiveFrom: "2026-01-01",
    })).rejects.toBeInstanceOf(ConflictError);
  });
});
