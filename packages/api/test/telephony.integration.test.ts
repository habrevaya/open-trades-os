import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as telephony from "../src/services/telephony";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * RECORDING PERMISSION, AND THE CARD NUMBER SOMEBODY READ OUT ON THE PHONE
 *
 * Both halves of this were built and neither was connected.
 * `telephony.mayRecord` decided whether a call could be recorded and nothing
 * called it. `transcript.redactTranscript` destroyed card numbers and
 * nothing called it either. The `call` table carried `recording_consent`
 * under a comment promising that an operator could answer a question about a
 * 2024 call, and no code wrote the column, on a table no code inserted into.
 *
 * A schema in that state is worse than a missing feature, because it reads
 * to a reviewer as a system that gates recording and can destroy one on
 * request, and it did neither.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("telephony:org");
const USER = fixtureId("telephony:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

const callRow = (id: string) => raw<{
  recording_consent: string | null; recording_started_at: Date | null;
  recording_refusal: string | null; recording_url: string | null;
  recording_deleted_at: Date | null; announcement_played_at: Date | null;
  transcript: string | null; transcript_redacted_at: Date | null;
  transcript_segments: { text: string }[] | null;
  transcript_redaction_counts: Record<string, number> | null;
}[]>`select recording_consent, recording_started_at, recording_refusal,
             recording_url, recording_deleted_at, announcement_played_at,
             transcript, transcript_redacted_at, transcript_segments,
             transcript_redaction_counts
      from public.call where id = ${id}`;

const aCall = () => telephony.logCall(owner(), {
  direction: "inbound",
  fromE164: "+15125550123",
  toE164: "+15125550100",
  status: "completed",
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Telephony Co", slug: "telephony-co" });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.call where organization_id = ${ORG}`;
  await raw`delete from public.recording_policy where organization_id = ${ORG}`;
});

run("a call is a row somebody can find", () => {
  it("writes the call nothing used to write", async () => {
    const call = await aCall();
    expect(call.id).toBeTruthy();
    expect(call.fromE164).toBe("+15125550123");

    const found = await telephony.callFor(owner(), call.id);
    expect(found.id).toBe(call.id);
  });

  it("row level security, not the query, is what hides another company's call", async () => {
    /**
     * The service does also filter on organization_id, and that filter is
     * unreachable: removing it leaves this test green, because RLS is FORCED
     * on `call` and the row is already invisible. The filter stays as a
     * second lock on the same door, but the thing being asserted here is the
     * policy, not the where clause.
     */
    const call = await aCall();
    const stranger: ServiceContext = {
      actor: { userId: USER, organizationId: fixtureId("telephony:other"), roles: ["owner"] as Actor["roles"] },
      db: db(),
    };
    await expect(telephony.callFor(stranger, call.id)).rejects.toThrow(NotFoundError);
  });
});

run("the operator declares the rule, the software holds them to it", () => {
  it("refuses a rule that is not in the catalogue", async () => {
    /**
     * A value outside CONSENT_RULES would fall through every strictness
     * comparison and behave like one party consent, which is the most
     * permissive option. The broken configuration must not be the thing that
     * enables recording.
     */
    await expect(telephony.setPolicy(owner(), {
      jurisdiction: "TX", rule: "one-party", announcementRequired: false, note: "Typed with a hyphen.",
    })).rejects.toThrow(/not one of/);
  });

  it("refuses a policy with no note", async () => {
    await expect(telephony.setPolicy(owner(), {
      jurisdiction: "TX", rule: "one_party", announcementRequired: false, note: "   ",
    })).rejects.toThrow(/no note/);
  });

  it("amends a jurisdiction in place rather than declaring it twice", async () => {
    await telephony.setPolicy(owner(), {
      jurisdiction: "TX", rule: "one_party", announcementRequired: false, note: "One party.",
    });
    await telephony.setPolicy(owner(), {
      jurisdiction: "TX", rule: "all_party", announcementRequired: true, note: "Counsel revised this.",
    });

    const all = await telephony.listPolicies(owner());
    expect(all.filter((p) => p.jurisdiction === "TX")).toHaveLength(1);
    expect(all.find((p) => p.jurisdiction === "TX")?.rule).toBe("all_party");
  });

  it("withdrawing a declaration makes recording harder, not easier", async () => {
    await telephony.setPolicy(owner(), {
      jurisdiction: "TX", rule: "one_party", announcementRequired: false, note: "One party.",
    });
    const call = await aCall();
    const parties = [
      { role: "caller" as const, jurisdiction: "TX", consented: true },
      { role: "agent" as const, jurisdiction: "TX" },
    ];

    const before = await telephony.decideRecording(owner(), {
      callId: call.id, parties, announcementPlayed: false,
    });
    expect(before.ok).toBe(true);

    await telephony.removePolicy(owner(), "TX");

    const after = await telephony.decideRecording(owner(), {
      callId: call.id, parties, announcementPlayed: false,
    });
    expect(after.ok).toBe(false);
    expect(after.governing).toBe("unknown");
  });

  it("refuses to withdraw a declaration that was never made", async () => {
    await expect(telephony.removePolicy(owner(), "TX")).rejects.toThrow(NotFoundError);
  });
});

run("whether this call may be recorded", () => {
  const oneParty = () => telephony.setPolicy(owner(), {
    jurisdiction: "TX", rule: "one_party", announcementRequired: false,
    note: "Our counsel says one participant's agreement is enough here.",
  });
  const allParty = () => telephony.setPolicy(owner(), {
    jurisdiction: "CA", rule: "all_party", announcementRequired: true,
    note: "Everybody has to agree before we start.",
  });

  it("permits a one party call and writes down the rule that governed it", async () => {
    await oneParty();
    const call = await aCall();

    const decision = await telephony.decideRecording(owner(), {
      callId: call.id,
      parties: [
        { role: "caller", jurisdiction: "TX", consented: true },
        { role: "agent", jurisdiction: "TX" },
      ],
      announcementPlayed: false,
    });

    expect(decision.ok).toBe(true);
    expect(decision.governing).toBe("one_party");

    const [row] = await callRow(call.id);
    expect(row!.recording_consent).toBe("one_party");
    expect(row!.recording_started_at).not.toBeNull();
    expect(row!.recording_refusal).toBeNull();
  });

  it("the strictest party governs the whole call", async () => {
    await oneParty();
    await allParty();
    const call = await aCall();

    /**
     * A call is one conversation and it has to satisfy everybody in it. The
     * company being in a one party place does not make the Californian on
     * the other end of it a one party participant.
     */
    const decision = await telephony.decideRecording(owner(), {
      callId: call.id,
      parties: [
        /**
         * The lenient jurisdiction is FIRST on purpose. With the strict one
         * first, a resolver that simply took the first party's rule would
         * pass this test, and the assertion would prove nothing.
         */
        { role: "agent", jurisdiction: "TX", consented: true },
        { role: "caller", jurisdiction: "CA", consented: true },
      ],
      announcementPlayed: true,
    });

    expect(decision.ok).toBe(true);
    expect(decision.governing).toBe("all_party");
  });

  it("an all party call with one silent participant is refused", async () => {
    await allParty();
    const call = await aCall();

    const decision = await telephony.decideRecording(owner(), {
      callId: call.id,
      parties: [
        { role: "caller", jurisdiction: "CA", consented: true },
        { role: "third_party", jurisdiction: "CA" },
      ],
      announcementPlayed: true,
    });

    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.reason).toBe("consent_missing");

    const [row] = await callRow(call.id);
    expect(row!.recording_refusal).toBe("consent_missing");
    expect(row!.recording_started_at).toBeNull();
  });

  it("somebody who said no ends it, and the row says which of the three nulls this is", async () => {
    await oneParty();
    const call = await aCall();

    const decision = await telephony.decideRecording(owner(), {
      callId: call.id,
      parties: [
        { role: "caller", jurisdiction: "TX", consented: false },
        { role: "agent", jurisdiction: "TX", consented: true },
      ],
      announcementPlayed: true,
    });

    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.reason).toBe("party_declined");

    /**
     * The point of storing the refusal: "nobody turned recording on", "the
     * provider dropped the file" and "the customer said do not record me"
     * are three different facts and all three used to be a null URL.
     */
    const [row] = await callRow(call.id);
    expect(row!.recording_refusal).toBe("party_declined");
  });

  it("a party nobody located makes the whole call unknown", async () => {
    await oneParty();
    const call = await aCall();

    const decision = await telephony.decideRecording(owner(), {
      callId: call.id,
      parties: [
        { role: "caller", consented: true },
        { role: "agent", jurisdiction: "TX", consented: true },
      ],
      announcementPlayed: false,
    });

    /**
     * "The places we happen to have policies for are all lenient" is not
     * evidence about the place we have no policy for.
     */
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.governing).toBe("unknown");
    expect(decision.reason).toBe("announcement_not_played");
  });

  it("records that the announcement was played", async () => {
    await allParty();
    const call = await aCall();
    await telephony.decideRecording(owner(), {
      callId: call.id,
      parties: [{ role: "caller", jurisdiction: "CA", consented: true }],
      announcementPlayed: true,
    });

    const [row] = await callRow(call.id);
    expect(row!.announcement_played_at).not.toBeNull();
  });
});

run("a recording nobody can say was allowed", () => {
  it("refuses to store audio for a call nobody asked about", async () => {
    const call = await aCall();
    await expect(telephony.attachRecording(owner(), call.id, "s3://calls/1.mp3"))
      .rejects.toThrow(/nobody asked whether this call could be recorded/);

    const [row] = await callRow(call.id);
    expect(row!.recording_url).toBeNull();
  });

  it("refuses to store audio for a call that was refused, and names the refusal", async () => {
    await telephony.setPolicy(owner(), {
      jurisdiction: "CA", rule: "all_party", announcementRequired: true, note: "Everybody agrees first.",
    });
    const call = await aCall();
    await telephony.decideRecording(owner(), {
      callId: call.id,
      parties: [{ role: "caller", jurisdiction: "CA", consented: false }],
      announcementPlayed: true,
    });

    await expect(telephony.attachRecording(owner(), call.id, "s3://calls/1.mp3"))
      .rejects.toThrow(/party_declined/);
  });

  it("stores audio once permission exists", async () => {
    await telephony.setPolicy(owner(), {
      jurisdiction: "TX", rule: "one_party", announcementRequired: false, note: "One party.",
    });
    const call = await aCall();
    await telephony.decideRecording(owner(), {
      callId: call.id,
      parties: [{ role: "caller", jurisdiction: "TX", consented: true }],
      announcementPlayed: false,
    });

    await telephony.attachRecording(owner(), call.id, "s3://calls/1.mp3");
    const [row] = await callRow(call.id);
    expect(row!.recording_url).toBe("s3://calls/1.mp3");
  });

  it("deletion clears the address in the same statement that stamps it", async () => {
    await telephony.setPolicy(owner(), {
      jurisdiction: "TX", rule: "one_party", announcementRequired: false, note: "One party.",
    });
    const call = await aCall();
    await telephony.decideRecording(owner(), {
      callId: call.id,
      parties: [{ role: "caller", jurisdiction: "TX", consented: true }],
      announcementPlayed: false,
    });
    await telephony.attachRecording(owner(), call.id, "s3://calls/1.mp3");

    await telephony.deleteRecording(owner(), call.id, "The customer asked us to.");

    const [row] = await callRow(call.id);
    expect(row!.recording_url).toBeNull();
    expect(row!.recording_deleted_at).not.toBeNull();
    /**
     * The permission stays. Erasing it would make a lawfully recorded and
     * then deleted call indistinguishable from one that was never allowed.
     */
    expect(row!.recording_started_at).not.toBeNull();
  });

  it("a deleted recording cannot be re-attached, and permission cannot be re-granted", async () => {
    await telephony.setPolicy(owner(), {
      jurisdiction: "TX", rule: "one_party", announcementRequired: false, note: "One party.",
    });
    const call = await aCall();
    await telephony.decideRecording(owner(), {
      callId: call.id,
      parties: [{ role: "caller", jurisdiction: "TX", consented: true }],
      announcementPlayed: false,
    });
    await telephony.attachRecording(owner(), call.id, "s3://calls/1.mp3");
    await telephony.deleteRecording(owner(), call.id, "Asked to.");

    await expect(telephony.attachRecording(owner(), call.id, "s3://calls/copy.mp3"))
      .rejects.toThrow(ConflictError);
    await expect(telephony.decideRecording(owner(), {
      callId: call.id,
      parties: [{ role: "caller", jurisdiction: "TX", consented: true }],
      announcementPlayed: false,
    })).rejects.toThrow(ConflictError);
  });

  it("a deletion asked for before the audio arrives blocks the audio", async () => {
    /**
     * A customer who says "do not keep a recording of this" often says it on
     * the call, which is minutes before the provider's webhook lands with
     * the file. Stamping the deletion on a call that has no URL yet is what
     * makes the instruction hold: the attach that arrives afterwards is
     * refused rather than quietly stored and then needing a second deletion
     * nobody remembers to ask for.
     */
    await telephony.setPolicy(owner(), {
      jurisdiction: "TX", rule: "one_party", announcementRequired: false, note: "One party.",
    });
    const call = await aCall();
    await telephony.decideRecording(owner(), {
      callId: call.id,
      parties: [{ role: "caller", jurisdiction: "TX", consented: true }],
      announcementPlayed: false,
    });

    await telephony.deleteRecording(owner(), call.id, "Asked on the call.");

    await expect(telephony.attachRecording(owner(), call.id, "s3://calls/late.mp3"))
      .rejects.toThrow(ConflictError);
    const [row] = await callRow(call.id);
    expect(row!.recording_url).toBeNull();
  });

  it("deleting twice is not an error", async () => {
    const call = await aCall();
    await telephony.deleteRecording(owner(), call.id, "Asked to.");
    const first = await callRow(call.id);
    await telephony.deleteRecording(owner(), call.id, "Asked again.");
    const second = await callRow(call.id);
    expect(second[0]!.recording_deleted_at?.getTime())
      .toBe(first[0]!.recording_deleted_at?.getTime());
  });
});

run("what a stored transcript is allowed to contain", () => {
  it("refuses malformed provider output rather than repairing it", async () => {
    const call = await aCall();
    /**
     * Every defect has a one line repair and every repair is wrong. A
     * transcript that is obviously broken gets looked at; one that was
     * quietly straightened out gets believed.
     */
    await expect(telephony.attachTranscript(owner(), {
      callId: call.id,
      segments: [{ speaker: "caller", startMs: 4000, endMs: 1000, text: "Hello", confidence: 0.9 }],
    })).rejects.toThrow(ConflictError);

    const [row] = await callRow(call.id);
    expect(row!.transcript).toBeNull();
  });

  it("refuses an empty transcript instead of storing a silent customer", async () => {
    const call = await aCall();
    await expect(telephony.attachTranscript(owner(), { callId: call.id, segments: [] }))
      .rejects.toThrow(ConflictError);
  });

  it("the card number is gone from the row, not scheduled for removal", async () => {
    const call = await aCall();
    const result = await telephony.attachTranscript(owner(), {
      callId: call.id,
      segments: [
        { speaker: "agent", startMs: 0, endMs: 2000, text: "What is the card number?", confidence: 0.95 },
        { speaker: "caller", startMs: 2000, endMs: 6000, text: "It is 4111 1111 1111 1111.", confidence: 0.92 },
      ],
    });

    expect(result.report.redacted).toBe(true);
    expect(result.report.countsByCategory.card_number).toBe(1);

    const [row] = await callRow(call.id);
    expect(row!.transcript).not.toBeNull();
    expect(row!.transcript).not.toContain("4111 1111 1111 1111");
    expect(row!.transcript).toContain("#");
    expect(row!.transcript_redacted_at).not.toBeNull();
    expect(row!.transcript_redaction_counts?.card_number).toBe(1);

    /**
     * The segments array is written from the SAME redacted segments as the
     * flattened text. Rendering the readable column from the raw input,
     * which is the obvious shortcut, would put the card number back.
     */
    const stored = JSON.stringify(row!.transcript_segments);
    expect(stored).not.toContain("4111 1111 1111 1111");
  });

  it("keeps the offsets a viewer scrubs to", async () => {
    const call = await aCall();
    await telephony.attachTranscript(owner(), {
      callId: call.id,
      segments: [
        { speaker: "agent", startMs: 0, endMs: 2000, text: "Card number?", confidence: 0.95 },
        { speaker: "caller", startMs: 2000, endMs: 6000, text: "4111 1111 1111 1111", confidence: 0.92 },
      ],
    });

    const [row] = await callRow(call.id);
    const segments = row!.transcript_segments as unknown as
      { startMs: number; endMs: number; text: string }[];
    expect(segments.map((s) => [s.startMs, s.endMs])).toEqual([[0, 2000], [2000, 6000]]);
    /** Masking only ever replaces characters, so length is preserved. */
    expect(segments[1]!.text).toHaveLength("4111 1111 1111 1111".length);
  });

  it("stores a clean transcript with nothing removed", async () => {
    const call = await aCall();
    const result = await telephony.attachTranscript(owner(), {
      callId: call.id,
      segments: [
        { speaker: "agent", startMs: 0, endMs: 2000, text: "The water heater is leaking?", confidence: 0.95 },
        { speaker: "caller", startMs: 2000, endMs: 5000, text: "Since Tuesday, yes.", confidence: 0.93 },
      ],
    });

    expect(result.report.redacted).toBe(false);
    const [row] = await callRow(call.id);
    expect(row!.transcript).toContain("water heater");
    /**
     * Stamped even when nothing was found. The column answers "has the
     * redaction pass run on this row", and leaving it null on a clean
     * transcript would make a clean one look unprocessed.
     */
    expect(row!.transcript_redacted_at).not.toBeNull();
  });

  it("reports quality so a bad transcription is not acted on silently", async () => {
    const call = await aCall();
    const result = await telephony.attachTranscript(owner(), {
      callId: call.id,
      segments: [
        { speaker: "agent", startMs: 0, endMs: 2000, text: "Sorry, say again?", confidence: 0.3 },
        { speaker: "caller", startMs: 2000, endMs: 5000, text: "I said the boiler.", confidence: 0.25 },
      ],
    });
    expect(result.quality.concerns.length).toBeGreaterThan(0);
  });
});
