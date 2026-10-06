/**
 * A/B TESTS FOR A CAMPAIGN: TWO VERSIONS, ONE HALF EACH, AND NO WINNER WITHOUT PROOF
 *
 * A text or an email can be written two ways. The audience is split in two, each
 * half gets one way, and afterwards the office reads the counts side by side.
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

export type Variant = "a" | "b";
export const VARIANTS: readonly Variant[] = ["a", "b"];

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
export function variantFor(campaignId: string, customerId: string): Variant {
  return hash32(`${campaignId}:${customerId}`) % 2 === 0 ? "a" : "b";
}

export const VARIANT_LABEL: Record<Variant, string> = { a: "Version A", b: "Version B" };

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
export function compareRates(a: Arm, b: Arm, alpha: number = ALPHA): RateComparison {
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
  const counts = `${a.hits} of ${a.n} (${rateA}%) for version A against ${b.hits} of ${b.n} (${rateB}%) for version B`;
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
    sentence: `${counts}. Version ${better === "b" ? "B" : "A"} did better. If the two versions were really the same, `
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
  measures: { measure: Measure; label: string; comparison: RateComparison }[];
  /** Null unless some measure is clearly better for one version and none is clearly better for the other. */
  winner: Variant | null;
  /** One sentence. Never says a version won without the test behind it. */
  headline: string;
}

export function judgeTest(a: VersionCounts, b: VersionCounts): TestJudgement {
  const compared: Measure[] = ["clicks", ...(a.replies !== null && b.replies !== null ? ["replies" as const] : []), "booked"];
  /** Bonferroni: the bar is split across what is compared, so looking at three things does not triple the false alarms. */
  const alpha = ALPHA / compared.length;
  const hits = (v: VersionCounts, m: Measure) => (m === "clicks" ? v.clicks : m === "replies" ? v.replies ?? 0 : v.booked);
  const measures = compared.map((measure) => ({
    measure,
    label: MEASURE_LABEL[measure],
    comparison: compareRates({ n: a.sent, hits: hits(a, measure) }, { n: b.sent, hits: hits(b, measure) }, alpha),
  }));
  const forA = measures.filter((m) => m.comparison.verdict === "a_higher");
  const forB = measures.filter((m) => m.comparison.verdict === "b_higher");
  if (forA.length > 0 && forB.length > 0) {
    return {
      measures, winner: null,
      headline: "The versions each did better at something, so there is no single winner. Read the counts and decide what matters more.",
    };
  }
  if (forA.length > 0 || forB.length > 0) {
    const winner: Variant = forB.length > 0 ? "b" : "a";
    const on = (forB.length > 0 ? forB : forA).map((m) => m.label.toLowerCase()).join(" and ");
    return {
      measures, winner,
      headline: `${VARIANT_LABEL[winner]} did better on ${on}, by more than luck would explain.`,
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
