import { describe, it, expect } from "vitest";
import {
  checkQueue, waitStep, ringRound, queueOutcome, placeInLine, carrierQueueName, ringPlan, twiml,
  softphoneIdentity, userOfIdentity, clientAddress, isOnline, dialable, PRESENCE_SECONDS,
  type CallQueue, type Directory, type RingGroup,
} from "../src/voice/index.js";

/**
 * A WAITING LINE AND THE BROWSER AS A PHONE
 *
 * The rules a caller waits under (when they are told their place, when the
 * group is rung again, when they have waited long enough) and the rules a
 * browser answers under (who it is, whether it is still there, what it may
 * dial). Each with the clock in a literal.
 */

const GROUP = "44444444-4444-4444-8444-444444444444";
const LINE = "77777777-7777-4777-8777-777777777777";
const SAM = "22222222-2222-4222-8222-222222222222";
const LEE = "33333333-3333-4333-8333-333333333333";

const directory: Directory = {
  menus: new Map(),
  ringGroups: new Map([[GROUP, "Service team"]]),
  people: new Map([[SAM, { name: "Sam Tech", phone: "+15125550102" }], [LEE, { name: "Lee Office", phone: null }]]),
  rotas: new Map(),
  queues: new Map([[LINE, "Service line"]]),
  assistant: false,
};

const queue = (over: Partial<CallQueue> = {}): CallQueue => ({
  id: LINE, name: "Service line", ringGroupId: GROUP, maxWaitSeconds: 300, announcePosition: true,
  holdMusicUrl: null, overflowTo: { kind: "voicemail", box: "main" }, ...over,
});

const NOW = new Date("2026-10-05T15:00:00Z");

describe("saving a waiting line", () => {
  it("takes a line answered by a group, overflowing to voicemail", () => {
    expect(checkQueue(queue(), directory)).toEqual({ ok: true });
  });

  it("refuses a line with no group to answer it, or a wait nobody would sit through", () => {
    expect(checkQueue(queue({ ringGroupId: "gone" }), directory).ok).toBe(false);
    expect(checkQueue(queue({ maxWaitSeconds: 10 }), directory).ok).toBe(false);
    expect(checkQueue(queue({ maxWaitSeconds: 3600 }), directory).ok).toBe(false);
  });

  it("refuses overflowing back into the same line, which would never end", () => {
    const verdict = checkQueue(queue({ overflowTo: { kind: "queue", id: LINE } }), directory);
    expect(!verdict.ok && verdict.reason).toContain("forever");
  });

  it("refuses hold music that is not a sound file", () => {
    expect(checkQueue(queue({ holdMusicUrl: "https://example.com/page" }), directory).ok).toBe(false);
    expect(checkQueue(queue({ holdMusicUrl: "ftp://example.com/a.mp3" }), directory).ok).toBe(false);
    expect(checkQueue(queue({ holdMusicUrl: "https://example.com/hold.mp3" }), directory).ok).toBe(true);
  });
});

describe("waiting in line", () => {
  it("tells the caller their place in words", () => {
    expect(placeInLine(1)).toBe("You are next in line.");
    expect(placeInLine(2)).toBe("There is one caller ahead of you.");
    expect(placeInLine(4)).toBe("There are 3 callers ahead of you.");
  });

  it("rings the group the first time round, and again only once the last round has had its time", () => {
    const first = waitStep({ queue: queue(), position: 1, waitedSeconds: 0, rungAt: null, ringSeconds: 20, now: NOW });
    expect(first).toEqual({ kind: "hold", say: "You are next in line. Thanks for waiting.", ring: true });

    const soon = waitStep({ queue: queue(), position: 1, waitedSeconds: 15, rungAt: new Date(NOW.getTime() - 15_000), ringSeconds: 20, now: NOW });
    expect(soon.kind === "hold" && soon.ring).toBe(false);

    const later = waitStep({ queue: queue(), position: 1, waitedSeconds: 40, rungAt: new Date(NOW.getTime() - 30_000), ringSeconds: 20, now: NOW });
    expect(later.kind === "hold" && later.ring).toBe(true);
  });

  it("says nothing about the caller's place when the line is set not to", () => {
    const quiet = waitStep({ queue: queue({ announcePosition: false }), position: 3, waitedSeconds: 0, rungAt: null, ringSeconds: 20, now: NOW });
    expect(quiet.kind === "hold" && quiet.say).toBeNull();
  });

  it("sends the caller on once they have waited as long as the line keeps anybody", () => {
    const over = waitStep({ queue: queue({ maxWaitSeconds: 120 }), position: 1, waitedSeconds: 125, rungAt: NOW, ringSeconds: 20, now: NOW });
    expect(over).toEqual({ kind: "leave", why: "Waited 2 minutes 5 seconds in line, which is as long as this line keeps a caller." });
  });

  it("offers the caller to each person in turn when the group rings one after another", () => {
    const group: RingGroup = {
      id: GROUP, name: "Service team", strategy: "in_order", ringSeconds: 20,
      members: [{ userId: SAM, label: "Sam" }, { e164: "+15125550199", label: "Answering service" }],
      noAnswerTo: { kind: "voicemail", box: "main" },
    };
    const plan = ringPlan(group, directory);
    expect(ringRound(plan, 0)?.numbers).toEqual(["+15125550102"]);
    expect(ringRound(plan, 1)?.numbers).toEqual(["+15125550199"]);
    expect(ringRound(plan, 2)?.numbers).toEqual(["+15125550102"]);
    expect(ringRound({ steps: [], skipped: [] }, 0)).toBeNull();
  });

  it("reads how a caller left the line", () => {
    expect(queueOutcome("bridged", 30)).toEqual({ kind: "answered" });
    expect(queueOutcome("hangup", 45).kind).toBe("gone");
    expect(queueOutcome("leave", 300)).toEqual({
      kind: "overflow", why: "Waited 5 minutes in line, which is as long as this line keeps a caller.",
    });
    expect(queueOutcome("system-error", 3).kind).toBe("overflow");
  });

  it("holds the caller in the carrier's queue under a name of the line's own", () => {
    const xml = twiml([{ verb: "enqueue", queue: carrierQueueName(LINE), waitUrl: "https://x/wait?q=1&a=2", action: "https://x/done" }]);
    expect(xml).toContain(`<Enqueue action="https://x/done" method="POST" waitUrl="https://x/wait?q=1&amp;a=2" waitUrlMethod="POST">ots-${LINE}</Enqueue>`);
    expect(twiml([{ verb: "dialQueue", queue: "ots-a", url: "https://x/c" }]))
      .toContain("<Dial><Queue url=\"https://x/c\" method=\"POST\">ots-a</Queue></Dial>");
  });
});

describe("the browser as a phone", () => {
  it("names a person's browser by their id, and reads the id back", () => {
    expect(softphoneIdentity(SAM)).toBe("u_22222222222242228222222222222222");
    expect(userOfIdentity(`client:${softphoneIdentity(SAM)}`)).toBe(SAM);
    expect(userOfIdentity("client:someone_else")).toBeNull();
  });

  it("rings a person in the browser instead of their phone while they are taking calls there", () => {
    const group: RingGroup = {
      id: GROUP, name: "Office", strategy: "all_at_once", ringSeconds: 20,
      members: [{ userId: SAM, label: "Sam" }, { userId: LEE, label: "Lee" }],
      noAnswerTo: { kind: "voicemail", box: "main" },
    };
    expect(ringPlan(group, directory).steps[0]!.numbers).toEqual(["+15125550102"]);
    const online = ringPlan(group, directory, new Set([SAM, LEE]));
    expect(online.steps[0]!.numbers).toEqual([clientAddress(SAM), clientAddress(LEE)]);
    expect(online.skipped).toEqual([]);
    expect(twiml([{ verb: "dial", to: online.steps[0]!.numbers, action: "https://x/d", timeoutSeconds: 20 }]))
      .toContain(`<Client>${softphoneIdentity(SAM)}</Client>`);
  });

  it("counts a browser as gone two missed beats after it last said it was there", () => {
    expect(isOnline(new Date(NOW.getTime() - 60_000), true, NOW)).toBe(true);
    expect(isOnline(new Date(NOW.getTime() - (PRESENCE_SECONDS + 1) * 1000), true, NOW)).toBe(false);
    expect(isOnline(NOW, false, NOW)).toBe(false);
  });

  it("dials a US number however it is written, and refuses emergency numbers from a browser", () => {
    expect(dialable("(512) 555-0147")).toEqual({ ok: true, e164: "+15125550147" });
    expect(dialable("1 512 555 0147")).toEqual({ ok: true, e164: "+15125550147" });
    expect(dialable("+44 20 7946 0958")).toEqual({ ok: true, e164: "+442079460958" });
    expect(dialable("911").ok).toBe(false);
    expect(dialable("555-0147").ok).toBe(false);
  });
});
