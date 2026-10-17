/**
 * A/B TESTS FOR A CAMPAIGN: UP TO FOUR VERSIONS, CHOSEN SHARES, AND NO WINNER WITHOUT PROOF
 *
 * A text or an email can be written up to four ways. The audience is split, each
 * part gets one way, and afterwards the office reads the counts side by side. The
 * split is even unless the office chose shares: ninety in a hundred to the words
 * that have always worked and ten to the new ones is the commonest test a careful
 * owner wants, because it risks little of the list on an untried message.
 *
 * THE SPLIT IS RANDOM AND REPRODUCIBLE. A stable hash of the campaign id and the
 * customer id decides the half, so the same customer is in the same half on every
 * run, a send that stops and carries on the next day (a carrier's daily cap)
 * never moves anybody, and nothing about the customer (their street, their name,
 * how long ago they were served) can decide it. The hash is written out here, in
 * whole numbers, rather than taken from a library, so core stays free of
 * anything but arithmetic and the answer is the same in every runtime.
 *
 * NO WINNER UNLESS THE DIFFERENCE IS REAL. Two groups of two hundred people will
 * differ by a few clicks even when the words make no difference at all, and an
 * owner who rewrites every campaign after the better looking half is chasing
 * luck. So a version is called better only when a two proportion test says the
 * gap is unlikely to be luck. Three things are compared (clicks, replies, people
 * who booked) and each one is tested on its own, which makes a false alarm
 * likelier, so the bar is divided by the number compared: the conservative
 * (Bonferroni) answer. Anything short of that is said as "no clear difference",
 * with the counts, never as a trend.
 */

export type Variant = "a" | "b" | "c" | "d";
export const VARIANTS: readonly Variant[] = ["a", "b", "c", "d"];

/** At most four versions: past that, each part of a trades company's list is too small to tell anything. */
export const MAX_VERSIONS = 4;

/**
 * The smallest share a version may have, in whole percent. Under it a version of
 * a few hundred people's campaign reaches a handful, and a test of a handful
 * says nothing except "too few to tell", which the office would be paying to
 * learn.
 */
export const MIN_SHARE = 5;

/** Fowler Noll Vo (FNV-1a, 32 bit) then Murmur3's finaliser, so every bit of the input moves every bit of the result. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Which half a customer is in for one campaign.
 *
 * The campaign id is in the hash so a customer is not in the same half of every
 * test they are ever put in: if the same people always got version A, a company
 * that tested twice would be testing on the same group twice.
 */
export function variantFor(
  campaignId: string, customerId: string,
  split: { versions: number; shares?: readonly number[] | null | undefined } = { versions: 2 },
): Variant {
  const h = hash32(`${campaignId}:${customerId}`);
  const versions = Math.max(1, Math.min(MAX_VERSIONS, Math.floor(split.versions)));
  /**
   * Two even halves is the rule every campaign has used since tests began, kept
   * exactly, so a send that carries on across a release gives its remaining
   * recipients the halves the first day's rule gave.
   */
  if (!split.shares || split.shares.length !== versions) {
    return VARIANTS[versions === 2 ? h % 2 : h % versions]!;
  }
  /** A bucket of a hundred, walked through the shares in order: 90 and 10 sends buckets 0 to 89 to A. */
  const bucket = h % 100;
  let upTo = 0;
  for (let i = 0; i < versions; i += 1) {
    upTo += split.shares[i]!;
    if (bucket < upTo) return VARIANTS[i]!;
  }
  return VARIANTS[versions - 1]!;
}

export const VARIANT_LABEL: Record<Variant, string> = { a: "Version A", b: "Version B", c: "Version C", d: "Version D" };

/**
 * Whether shares make sense for this many versions: one whole percent per
 * version, each at least `MIN_SHARE`, adding up to a hundred. Shares that are
 * all the same are no choice at all and come back as null, the even split.
 */
export function checkShares(
  shares: readonly number[] | null | undefined, versions: number,
): { ok: true; shares: number[] | null } | { ok: false; message: string } {
  if (shares === null || shares === undefined || shares.length === 0) return { ok: true, shares: null };
  if (versions < 2) return { ok: false, message: "Shares need a second version to share with." };
  if (shares.length !== versions) {
    return { ok: false, message: `There are ${versions} versions, so give ${versions} shares, one for each.` };
  }
  if (shares.some((share) => !Number.isInteger(share))) {
    return { ok: false, message: "Each share is a whole percent, like 90 or 10." };
  }
  if (shares.some((share) => share < MIN_SHARE)) {
    return { ok: false, message: `Each version needs at least ${MIN_SHARE}% of the list, or it reaches too few people to tell anything.` };
  }
  const total = shares.reduce((sum, share) => sum + share, 0);
  if (total !== 100) return { ok: false, message: `The shares add up to ${total}%. They need to add up to 100%.` };
  return { ok: true, shares: shares.every((share) => share === shares[0]) ? null : [...shares] };
}

/** "90% get version A and 10% get version B", or the even split in words. */
export function splitInWords(versions: number, shares: readonly number[] | null | undefined): string {
  const used = VARIANTS.slice(0, versions);
  if (!shares || shares.length !== versions) {
    return versions === 2 ? "Half get version A and half get version B." : `The list is split evenly between versions ${used.map((v) => v.toUpperCase()).join(", ")}.`;
  }
  const parts = used.map((v, i) => `${shares[i]}% get version ${v.toUpperCase()}`);
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}.`;
}

/* ----------------------------------------------------- the two proportion test */

/** The two sided tail of a standard normal beyond `z`, by Numerical Recipes' erfc (fractional error under 1.2e-7). */
function twoSidedNormalTail(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * x);
  const poly = -x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418
    + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587
      + t * (-0.82215223 + t * 0.17087277))))))));
  return Math.min(1, t * Math.exp(poly));
}

export interface Arm {
  /** People in this half who were sent it. */
  n: number;
  /** Of them (or of those who acted), how many did the thing being counted. */
  hits: number;
}

export type RateVerdict = "no_data" | "too_few" | "no_clear_difference" | "a_higher" | "b_higher";

export interface RateComparison {
  verdict: RateVerdict;
  /** Each half's rate as a percentage to one place, or null with nobody in it. */
  rateA: string | null;
  rateB: string | null;
  /** The chance a gap this big appears by luck alone if the versions were the same. Null when no test was run. */
  pValue: number | null;
  /** The bar the chance had to get under. */
  alpha: number;
  /** One or two plain sentences, for the screen. */
  sentence: string;
}

export const ALPHA = 0.05;

function percent(hits: number, n: number): string | null {
  if (n <= 0) return null;
  return (Math.round((hits / n) * 1000) / 10).toFixed(1);
}

/** "about 1 time in 20", from a chance. */
export function luckInWords(p: number): string {
  if (p >= 0.995) return "almost every time";
  if (p >= 0.5) return `about ${Math.round(p * 100)} times in 100`;
  const inN = Math.round(1 / p);
  if (inN > 10_000) return "fewer than 1 time in 10,000";
  return `about 1 time in ${inN.toLocaleString("en-US")}`;
}

/**
 * A pooled two proportion z test, two sided.
 *
 * It refuses to speak when the counts are too small for the normal
 * approximation it rests on: when fewer than five of either half would be
 * expected to do the thing, or fewer than five not to, in each half. Saying
 * "no clear difference" there would be a claim too, so the answer is "too few
 * to tell", which is different, and says so.
 */
export function compareRates(
  a: Arm, b: Arm, alpha: number = ALPHA,
  /** What the two are called in the sentence: the first version, and the one compared with it. */
  names: { first: Variant; second: Variant } = { first: "a", second: "b" },
): RateComparison {
  const first = names.first.toUpperCase();
  const second = names.second.toUpperCase();
  const rateA = percent(a.hits, a.n);
  const rateB = percent(b.hits, b.n);
  const base = { rateA, rateB, alpha };
  if (a.n <= 0 || b.n <= 0 || a.hits > a.n || b.hits > b.n || a.hits < 0 || b.hits < 0) {
    return {
      ...base, verdict: "no_data", pValue: null,
      sentence: "Nobody has been sent one of the versions yet, so there is nothing to compare.",
    };
  }
  const pooled = (a.hits + b.hits) / (a.n + b.n);
  const expected = [a.n * pooled, a.n * (1 - pooled), b.n * pooled, b.n * (1 - pooled)];
  if (expected.some((e) => e < 5)) {
    return {
      ...base, verdict: "too_few", pValue: null,
      sentence: `${a.hits} of ${a.n} against ${b.hits} of ${b.n} is too few to tell the versions apart. `
        + "The numbers are too small for any gap to mean anything yet.",
    };
  }
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.n + 1 / b.n));
  const z = (b.hits / b.n - a.hits / a.n) / se;
  const pValue = twoSidedNormalTail(z);
  const counts = `${a.hits} of ${a.n} (${rateA}%) for version ${first} against ${b.hits} of ${b.n} (${rateB}%) for version ${second}`;
  if (pValue >= alpha) {
    return {
      ...base, verdict: "no_clear_difference", pValue,
      sentence: `${counts}. A gap this size turns up by chance ${luckInWords(pValue)} when the two versions are `
        + "really the same, so neither is shown to be better.",
    };
  }
  const better = z > 0 ? "b" : "a";
  return {
    ...base, verdict: better === "b" ? "b_higher" : "a_higher", pValue,
    sentence: `${counts}. Version ${better === "b" ? second : first} did better. If the two versions were really the same, `
      + `a gap this big would turn up by chance ${luckInWords(pValue)}.`,
  };
}

/* ------------------------------------------------------------ the whole test */

export type Measure = "clicks" | "replies" | "booked";

export const MEASURE_LABEL: Record<Measure, string> = {
  clicks: "People who clicked the link",
  replies: "People who replied",
  booked: "People who booked a job",
};

export interface VersionCounts {
  /** Queued to this half. The people who could have acted. */
  sent: number;
  clicks: number;
  /** Null when replies are not read back for this campaign, so the test leaves it out rather than counting a blank as nobody. */
  replies: number | null;
  booked: number;
}

export interface TestJudgement {
  /** One per measure per version compared with the first, which is `against`. */
  measures: { measure: Measure; label: string; against: Variant; comparison: RateComparison }[];
  /** Null unless the counts prove one version better, as `judgeVersions` explains. */
  winner: Variant | null;
  /** One sentence. Never says a version won without the test behind it. */
  headline: string;
}

/** Two versions, the first against the second: the test as it was before there could be more. */
export function judgeTest(a: VersionCounts, b: VersionCounts): TestJudgement {
  return judgeVersions([a, b]);
}

/**
 * The whole test: every other version compared with the first, on each measure.
 *
 * EACH AGAINST THE FIRST, NOT EVERY PAIR. The first version is the words the
 * company already sends, and the question an owner asks is whether a new one
 * beats it. Comparing every pair as well would mean six comparisons for four
 * versions, each one another chance of a false alarm.
 *
 * THE SAME CONSERVATIVE BAR, SPREAD WIDER. Five in a hundred divided by
 * everything compared: the measures times the versions compared with the
 * first (Bonferroni again). Three measures and three new versions is nine
 * comparisons, so each must clear five in nine hundred, and a test with more
 * versions asks more of each, which is the price of asking more questions.
 *
 * A WINNER ONLY WHEN THE COUNTS SAY SO. A new version is named when it did
 * clearly better than the first on something, the first did clearly better than
 * it on nothing, and no other version also did better than the first, because
 * two new versions that each beat the first have not been compared with each
 * other. The first version is named when it did clearly better than every
 * other version on something and none did better than it on anything.
 */
export function judgeVersions(all: readonly VersionCounts[]): TestJudgement {
  const versions = all.slice(0, MAX_VERSIONS);
  const first = versions[0]!;
  const others = versions.slice(1);
  const repliesKnown = versions.every((v) => v.replies !== null);
  const compared: Measure[] = ["clicks", ...(repliesKnown ? ["replies" as const] : []), "booked"];
  /** Bonferroni: the bar is split across everything compared, so looking at more things does not multiply the false alarms. */
  const alpha = ALPHA / (compared.length * Math.max(1, others.length));
  const hits = (v: VersionCounts, m: Measure) => (m === "clicks" ? v.clicks : m === "replies" ? v.replies ?? 0 : v.booked);
  const measures = others.flatMap((other, i) => {
    const against = VARIANTS[i + 1]!;
    return compared.map((measure) => ({
      measure,
      label: MEASURE_LABEL[measure],
      against,
      comparison: compareRates(
        { n: first.sent, hits: hits(first, measure) }, { n: other.sent, hits: hits(other, measure) },
        alpha, { first: "a", second: against },
      ),
    }));
  });

  const beatFirst = (v: Variant) => measures.filter((m) => m.against === v && m.comparison.verdict === "b_higher");
  const firstBeat = (v: Variant) => measures.filter((m) => m.against === v && m.comparison.verdict === "a_higher");
  const challengers = VARIANTS.slice(1, versions.length).filter((v) => beatFirst(v).length > 0);
  const two = versions.length === 2;
  const on = (found: typeof measures) => [...new Set(found.map((m) => m.label.toLowerCase()))].join(" and ");

  if (challengers.length === 1 && firstBeat(challengers[0]!).length === 0) {
    const winner = challengers[0]!;
    return {
      measures, winner,
      headline: two
        ? `${VARIANT_LABEL[winner]} did better on ${on(beatFirst(winner))}, by more than luck would explain.`
        : `${VARIANT_LABEL[winner]} did better than version A on ${on(beatFirst(winner))}, by more than luck would explain. `
          + "The other versions were compared only with version A.",
    };
  }
  if (challengers.length === 0) {
    const beaten = VARIANTS.slice(1, versions.length).filter((v) => firstBeat(v).length > 0);
    if (beaten.length > 0 && beaten.length === others.length) {
      const lostOn = measures.filter((m) => m.comparison.verdict === "a_higher");
      return {
        measures, winner: "a",
        headline: two
          ? `Version A did better on ${on(lostOn)}, by more than luck would explain.`
          : `Version A did better than every other version, on ${on(lostOn)}, by more than luck would explain.`,
      };
    }
  }
  if (challengers.length > 1) {
    return {
      measures, winner: null,
      headline: "More than one version did better than version A at something, and they have not been compared with each other, so there is no single winner.",
    };
  }
  if (challengers.length === 1) {
    const mixed = challengers[0]!;
    return {
      measures, winner: null,
      headline: two
        ? "The versions each did better at something, so there is no single winner. Read the counts and decide what matters more."
        : `${VARIANT_LABEL[mixed]} did better than version A at one thing and worse at another, so there is no single winner. Read the counts and decide what matters more.`,
    };
  }
  const beatenSome = VARIANTS.slice(1, versions.length).filter((v) => firstBeat(v).length > 0);
  if (beatenSome.length > 0) {
    return {
      measures, winner: null,
      headline: `Version A did better than ${beatenSome.map((v) => `version ${v.toUpperCase()}`).join(" and ")}, `
        + "but not clearly better than every other version, so there is no single winner.",
    };
  }
  const nobody = measures.every((m) => m.comparison.verdict === "no_data");
  /** Only when NOTHING could be tested: one measure with a clear "no difference" is a finding, however thin the rest. */
  const tooFew = measures.every((m) => m.comparison.verdict === "too_few" || m.comparison.verdict === "no_data");
  return {
    measures, winner: null,
    headline: nobody
      ? "Nobody has been sent a version yet."
      : tooFew
        ? "Too few people have acted to tell the versions apart yet. No winner."
        : "No clear winner. The gaps are small enough that luck could explain them.",
  };
}

/* ------------------------------------------------- holding part of the list back */

/**
 * The most and the least of a list that may be held back from a test, in whole
 * percent. Under five the held back part is too small to be worth the wait;
 * over ninety five the test itself reaches too few to say anything.
 */
export const MIN_HOLD_BACK = 5;
export const MAX_HOLD_BACK = 95;

/**
 * Whether a held back share makes sense: a whole percent between the bounds,
 * and only on a test, because with one version there is no winner to send.
 * Nothing (null, absent or zero) is no hold back, the default.
 */
export function checkHoldBack(
  share: number | null | undefined, versions: number,
): { ok: true; share: number | null } | { ok: false; message: string } {
  if (share === null || share === undefined || share === 0) return { ok: true, share: null };
  if (!Number.isInteger(share)) return { ok: false, message: "Hold back a whole percent of the list, like 80." };
  if (versions < 2) {
    return { ok: false, message: "Holding part of the list back is for a test. Write a second version first, or hold nobody back." };
  }
  if (share < MIN_HOLD_BACK || share > MAX_HOLD_BACK) {
    return { ok: false, message: `Hold back between ${MIN_HOLD_BACK}% and ${MAX_HOLD_BACK}% of the list, so both the test and the rest reach enough people.` };
  }
  return { ok: true, share };
}

/**
 * Whether a customer is in the held back part of one campaign.
 *
 * A hash of its own, with a prefix the version hash does not have, so who is
 * held back says nothing about which version they would have got: the test
 * part keeps the shares the office chose. Stable, like the version, so a send
 * that carries on tomorrow holds back the same people.
 */
export function heldBackFor(campaignId: string, customerId: string, share: number | null | undefined): boolean {
  if (!share || share <= 0) return false;
  return hash32(`hold:${campaignId}:${customerId}`) % 100 < share;
}

/** "80% are held back. The test goes to the other 20%, and you send the winner to the 80% afterwards." */
export function holdBackInWords(share: number | null | undefined): string | null {
  if (!share) return null;
  return `${share}% of the list is held back. The test goes to the other ${100 - share}%, and once it is judged you `
    + `send the winner to the ${share}%. Nothing goes to them by itself.`;
}

/**
 * What the held back part may be sent, from the test's judgement as it stands:
 * the winner when there is one, and version A, the words the company already
 * sends, when nothing won. Never a version that did not win, because the reason
 * for holding people back was to send them what the test proved.
 */
export function restChoice(winner: Variant | null): { version: Variant; won: boolean; sentence: string } {
  if (winner) {
    return {
      version: winner, won: true,
      sentence: `${VARIANT_LABEL[winner]} won, by more than luck would explain.`,
    };
  }
  return {
    version: "a", won: false,
    sentence: "No version won, so there is no winner to send. You can wait for more results, or send version A, the words you already use.",
  };
}
