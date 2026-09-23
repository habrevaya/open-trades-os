import { dateIn, instantOfLocal, minutesInDay, nextDay, wallTimeExists } from "../time/index.js";

/**
 * REVIEWS AND REPUTATION
 *
 * =========================================================================
 * THE FEATURE THIS MODULE REFUSES TO BUILD, AND WHY THE REFUSAL IS THE
 * MOST IMPORTANT THING IN THE FILE
 * =========================================================================
 *
 * The practice has a name in this industry: review gating. It works like
 * this. Before you send anybody to a public review page, you ask them
 * privately how the job went. A thumbs up routes to Google. A thumbs down
 * routes to a form that goes to the office. The public page therefore only
 * ever receives people who have already said they were pleased.
 *
 * Every competitor in this category sells it, usually under a gentler name:
 * "internal sentiment check", "smart routing", "happiness check first".
 * It is the single most requested feature in the category, and it is
 * requested for a good reason: it works. A contractor who turns it on
 * watches their public average rise within a month. Nothing else in a
 * marketing budget does that.
 *
 * It is also prohibited, on two independent grounds, and neither of them is
 * a matter of opinion.
 *
 *   THE REGULATOR. Consumer protection rules in the United States treat the
 *   suppression of negative reviews as a deceptive practice, because the
 *   published average is a representation to consumers about the business
 *   and the average is being manufactured. The mechanism does not have to
 *   delete anything to count: selecting who is invited on the basis of what
 *   they are expected to say produces the same false picture as deleting the
 *   bad ones, and it is the false picture the rules are about. Penalties
 *   attach per violation, and a violation here is a customer.
 *
 *   THE PLATFORM. The review platforms forbid it in their own terms, for
 *   their own reasons: a rating distribution that has been filtered at the
 *   source destroys the thing they are selling. Enforcement is not a fine.
 *   It is the removal of the reviews, or of the listing, and the listing is
 *   where a home services company's phone calls come from. A contractor who
 *   loses their profile loses the top of their funnel in an afternoon.
 *
 * NOW THE PART THAT DECIDES WHAT THIS FILE DOES. The vendor who ships
 * gating does not carry either of those risks. The contractor does. And the
 * contractor mostly does not know they are carrying it, because the feature
 * did not arrive labelled "we will filter your reviews and you will answer
 * for it". It arrived in an onboarding call labelled "we check sentiment
 * first so unhappy customers reach you instead of the internet", which
 * sounds like customer care and is in fact the whole violation stated out
 * loud. Shipping that switch is selling somebody a compliance risk they do
 * not know they are taking, against a benefit that shows up on a dashboard
 * this quarter and a cost that shows up as a removed listing in two years.
 * That is not a trade a contractor got to make, because nobody described it
 * to them.
 *
 * THIS PRODUCT'S PLANNED SPEC SAID OTHERWISE, AND THE SPEC IS WRONG. The
 * module description for M20 lists "sentiment based routing" and "internal
 * sentiment check before public ask" as capabilities, and a design note
 * defends it. This file is the argument for deleting that note. It is
 * recorded here rather than only in a document because the code is what
 * ships.
 *
 * SO THE ABSENCE IS STRUCTURAL, NOT AN OVERSIGHT WAITING TO BE FILLED.
 * There is no field on the request input for a predicted rating, a mood, a
 * score or a flag derived from any of them. There is no branch on one. The
 * complete set of facts the decision is allowed to read is declared as data
 * in REQUEST_INPUTS, the test suite proxies the input and fails if the
 * decision reads anything outside that set, and a second test reads this
 * source file with comments and strings removed and fails if the words
 * reappear in executable code. Those two tests exist so that the next person
 * under commercial pressure to add the switch has to delete a test that
 * explains why, which is a different act from adding a feature.
 *
 * WHAT "STRUCTURAL" COVERS AND WHAT IT DOES NOT, SINCE THE WORD WAS DOING
 * MORE WORK THAN THE CODE WAS. An earlier version of this file left two doors
 * open and neither was theoretical. WITHHOLDING_RULES and REQUEST_INPUTS were
 * exported as ordinary arrays that `decideRequest` consults on every call, and
 * `readonly` is a compile time adjective with no weight at runtime. Anybody
 * importing this module could push a rule whose condition read a private score
 * off the job and report the hold under an innocuous reason already in the
 * table, or simply overwrite the condition on a rule that was there, and the
 * result was the prohibited feature assembled entirely out of this module's
 * public exports with no edit to this file at all. Both arrays are frozen now,
 * along with every rule object in the table, so both attempts throw.
 *
 * What remains true, and is worth stating rather than papering over: nothing
 * in a pure function stops a caller asking this module for an answer and then
 * discarding the answer for the customers it privately expects to complain.
 * That is the same limit as an operator who leaves complaints open forever, it
 * is answered by a report rather than by a type, and it is not a reason to
 * leave the two doors above open.
 *
 * WHAT IS BUILT INSTEAD, WHICH IS THE LEGITIMATE VERSION OF THE SAME GOAL.
 * Ask everybody, on the same rules, with no prediction anywhere in the path.
 * Then use what they actually say to decide who gets a phone call from a
 * human. The ordering is the entire difference: service recovery happens
 * AFTER the public invitation has already gone out, so the customer's
 * ability to post is never what is being decided. A one star review with an
 * owner's reply under it and a callback logged against it does more for a
 * contractor than a filtered 4.9 anyway, because the filtered 4.9 is what
 * every one of their competitors has and it has stopped meaning anything.
 *
 * THE NEAREST THING TO A GATE IN THIS FILE, NAMED HONESTLY. Requests are
 * withheld while a complaint is open and while a callback is unresolved.
 * That is not gating and the distinction is worth stating precisely rather
 * than asserting: those rules key on a recorded operational fact, they apply
 * to every customer in that state whatever anybody expects them to say, they
 * withhold the invitation entirely rather than diverting it somewhere
 * private, and they expire on their own when the underlying record closes.
 * An operator could still abuse them by leaving complaints open forever.
 * Nothing in a pure function can prevent that, and the answer is a report on
 * how long complaints stay open, which belongs in the reporting module and
 * is not built here.
 *
 * Everything below is pure. No clock is read inside any decision: `now` is
 * a parameter everywhere, because a rule about timing that consults the
 * server's clock cannot be tested for the cases that matter.
 */

/* ========================================================================
 * 1. THE FACTS A REQUEST DECISION MAY READ
 * ===================================================================== */

/** A request we have already sent, for the purpose of not sending it twice. */
export interface SentRequest {
  jobId: string;
  sentAt: Date;
}

export interface Callback {
  /**
   * When the return visit was closed out. Null while it is still open, which
   * is the state that matters: the job is not finished, so there is nothing
   * to ask about yet.
   */
  resolvedAt: Date | null;
}

/**
 * Everything the decision is allowed to know about a job.
 *
 * Read the header. There is deliberately no predicted rating on here, no
 * score, and no flag derived from one. The absence is the feature.
 */
export interface JobFacts {
  jobId: string;
  customerId: string;
  completed: boolean;
  paid: boolean;
  /**
   * When the technician actually left, not when the office closed the job.
   * Those differ by up to a day in practice, and asking about a visit the
   * customer remembers from this morning is a different message from asking
   * about one they had to look up.
   */
  technicianLeftAt: Date | null;
  /** The return visit for the same fault, when there was one. */
  callback: Callback | null;
  /** Whether a complaint is open against this job right now. */
  complaintOpen: boolean;
  /** The customer has told us not to ask them for reviews. */
  optedOut: boolean;
  /**
   * Every review request already sent to THIS customer, for any job. One
   * list rather than two, because the commonest way to ask somebody twice is
   * a caller who passed the per job list where the per customer list was
   * wanted.
   */
  requests: readonly SentRequest[];
}

/**
 * THE COMPLETE SET OF FACTS THE DECISION READS, DECLARED AS DATA.
 *
 * This exists to be enforced. A test wraps the input in a proxy, records
 * every property the decision touches, and fails when the set is not a
 * subset of this list. Adding a new input to the decision therefore means
 * adding it here, in a file whose header explains which inputs are
 * forbidden and why, which is the smallest possible speed bump in front of
 * the one change this module must never accept.
 */
export const REQUEST_INPUTS: readonly string[] = Object.freeze([
  "jobId",
  "customerId",
  "completed",
  "paid",
  "technicianLeftAt",
  "callback",
  "callback.resolvedAt",
  "complaintOpen",
  "optedOut",
  "requests",
]);

/* ========================================================================
 * 2. WHEN TO ASK
 * ===================================================================== */

export interface RequestPolicy {
  /** The company's zone. Every hour in this policy is a wall clock hour in it. */
  timeZone: string;
  /**
   * How long after the technician leaves before the ask goes out. Short
   * enough that the visit is still in mind, long enough that the customer
   * has stopped thinking about the invoice.
   */
  delayMinutes: number;
  /**
   * Never ask the same person more often than this, however many jobs they
   * give us. A commercial customer with four properties generates four
   * completed jobs in a week, and four requests in a week is how a good
   * customer learns to filter our address.
   */
  customerCooldownDays: number;
  /** Whether payment is a precondition. Usually yes: an unpaid job is unfinished. */
  requirePaid: boolean;
  /**
   * Past this age we do not ask at all. A request about a job from two
   * months ago reads as a mailshot, and it is one: the only reason it is
   * going out now is that somebody turned the feature on and it swept the
   * back catalogue. That sweep is also the single fastest way to trip a
   * platform's bulk solicitation rule.
   */
  maxJobAgeDays: number;
  /** The earliest local hour a request may be sent, 0 to 23. */
  earliestHour: number;
  /** The hour after which it waits for tomorrow. */
  latestHour: number;
}

export type WithheldReason =
  | "customer_opted_out"
  | "already_asked_for_this_job"
  | "job_not_completed"
  | "departure_time_unknown"
  | "job_not_paid"
  | "complaint_open"
  | "callback_unresolved"
  | "job_too_old"
  | "customer_asked_recently";

export type RequestDecision =
  | {
      ask: true;
      jobId: string;
      customerId: string;
      /** The instant the request may go out, in the company's sending window. */
      sendAt: Date;
      /** False when `sendAt` is in the future and the caller should queue it. */
      readyNow: boolean;
    }
  | {
      ask: false;
      jobId: string;
      customerId: string;
      withheld: WithheldReason;
      /**
       * Plain text for the person asking "why did that customer never get
       * asked". That question is the reason this module gets opened, and a
       * boolean false answers it with nothing.
       */
      explanation: string;
      /**
       * Whether this clears itself. An open complaint does, eventually. An
       * opt out does not, and the difference decides whether the job belongs
       * on a retry queue or off it.
       */
      clearsOnItsOwn: boolean;
    };

const DAY_MS = 86_400_000;

/**
 * THE RULES, AS DATA, IN PRECEDENCE ORDER.
 *
 * The order is the answer to "which reason do we report when more than one
 * applies", and it is not arbitrary. Definitive reasons come first: an opt
 * out and a request already sent are both facts that will never change, and
 * reporting "complaint open" for a job we already asked about would send
 * somebody to close a complaint for no reason. After that the order runs
 * from the state of the job outward to the state of the customer, because
 * that is the order the person reading it can act in.
 */
interface WithholdingRule {
  reason: WithheldReason;
  clearsOnItsOwn: boolean;
  /** False when the rule does not bite. A string is the explanation. */
  applies: (facts: JobFacts, policy: RequestPolicy, now: Date) => false | string;
}

/**
 * Frozen, because `readonly` is not.
 *
 * `applies` is a free form condition over the job, which is what makes the
 * table readable and is also the one thing in this module that could be
 * pointed at a fact nobody declared. The type stops that at compile time and
 * stops nothing at all at runtime: an importer can cast the array back to a
 * mutable one, push a rule that reads a private score, and get the prohibited
 * behaviour out of this module's public exports without touching this file.
 * Freezing the rules and the array around them turns that from a silent
 * success into a TypeError, which is the difference between a door and a sign
 * on a door.
 */
function frozenRules(rules: readonly WithholdingRule[]): readonly WithholdingRule[] {
  for (const rule of rules) Object.freeze(rule);
  return Object.freeze(rules);
}

export const WITHHOLDING_RULES: readonly WithholdingRule[] = frozenRules([
  {
    reason: "customer_opted_out",
    clearsOnItsOwn: false,
    applies: (facts) =>
      facts.optedOut
        ? "This customer has asked not to be sent review requests. Nothing will change that except them asking again."
        : false,
  },
  {
    reason: "already_asked_for_this_job",
    clearsOnItsOwn: false,
    applies: (facts) => {
      const sent = facts.requests.find((request) => request.jobId === facts.jobId);
      return sent
        ? `A request for this job already went out on ${sent.sentAt.toISOString().slice(0, 10)}. One job gets one ask, and a second one is a nudge the platforms treat as pressure.`
        : false;
    },
  },
  {
    reason: "job_not_completed",
    clearsOnItsOwn: true,
    applies: (facts) =>
      facts.completed
        ? false
        : "The job is not marked complete. Asking about work that is still open is asking about an opinion the customer has not formed yet.",
  },
  {
    reason: "departure_time_unknown",
    clearsOnItsOwn: true,
    applies: (facts) =>
      facts.technicianLeftAt
        ? false
        : "The job is complete but nothing recorded when the technician left, so there is no clock to measure the delay from. Check the visit record.",
  },
  {
    reason: "job_not_paid",
    clearsOnItsOwn: true,
    applies: (facts, policy) =>
      !policy.requirePaid || facts.paid
        ? false
        : "The invoice is unpaid. Asking for a public review while we are still chasing money puts the two conversations in the same inbox.",
  },
  {
    reason: "complaint_open",
    clearsOnItsOwn: true,
    applies: (facts) =>
      facts.complaintOpen
        ? "There is an open complaint on this job. The ask resumes by itself once the complaint is closed, and until then somebody owes this customer a conversation instead."
        : false,
  },
  {
    reason: "callback_unresolved",
    clearsOnItsOwn: true,
    applies: (facts) =>
      facts.callback && facts.callback.resolvedAt === null
        ? "We have been back to this job and the return visit is still open. The work is not finished, so there is nothing settled to ask about yet."
        : false,
  },
  {
    reason: "job_too_old",
    clearsOnItsOwn: false,
    applies: (facts, policy, now) => {
      const leftAt = facts.technicianLeftAt;
      if (!leftAt) return false;
      const ageDays = (now.getTime() - leftAt.getTime()) / DAY_MS;
      return ageDays > policy.maxJobAgeDays
        ? `That job finished ${Math.floor(ageDays)} days ago, past the ${policy.maxJobAgeDays} day limit. A request this late reads as a mailshot, and a batch of them is what a platform's bulk solicitation rule is looking for.`
        : false;
    },
  },
  {
    reason: "customer_asked_recently",
    clearsOnItsOwn: true,
    applies: (facts, policy, now) => {
      const cutoff = now.getTime() - policy.customerCooldownDays * DAY_MS;
      const recent = facts.requests
        .filter((request) => request.sentAt.getTime() >= cutoff)
        .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0];
      return recent
        ? `We asked this customer on ${recent.sentAt.toISOString().slice(0, 10)}, inside the ${policy.customerCooldownDays} day gap. Somebody who gives us four jobs a month is not four people to ask.`
        : false;
    },
  },
]);

/**
 * The next instant inside the company's sending window.
 *
 * Computed in wall clock terms rather than by adding offsets, because the
 * two cases that break the arithmetic version are both real: a window that
 * would land on the hour that does not exist when the clocks go forward, and
 * a company whose zone is not the server's. The loop is bounded because an
 * unbounded search over a misconfigured window (earliest at or after latest)
 * would hang the worker rather than send a request late.
 */
function nextSendableInstant(at: Date, policy: RequestPolicy): Date {
  const open = policy.earliestHour * 60;
  const close = policy.latestHour * 60;
  let cursor = at;

  for (let pass = 0; pass < 16; pass += 1) {
    const date = dateIn(cursor, policy.timeZone);
    const minutes = minutesInDay(cursor, policy.timeZone);
    if (minutes >= open && minutes < close) return cursor;

    const targetDate = minutes < open ? date : nextDay(date);
    cursor = wallTimeExists(targetDate, open, policy.timeZone)
      ? instantOfLocal(targetDate, open, policy.timeZone)
      // The opening hour fell in a daylight saving gap, so it did not happen.
      // An hour later did, and a request an hour late is not a defect.
      : instantOfLocal(targetDate, open + 60, policy.timeZone);
  }
  return cursor;
}

/**
 * Whether to ask about this job, and when.
 *
 * Read the file header before changing this function. There is no branch in
 * it on anything anybody expects the customer to say, and that is enforced
 * by test rather than by hoping.
 */
export function decideRequest(
  facts: JobFacts,
  policy: RequestPolicy,
  now: Date,
): RequestDecision {
  const jobId = facts.jobId;
  const customerId = facts.customerId;

  for (const rule of WITHHOLDING_RULES) {
    const explanation = rule.applies(facts, policy, now);
    if (explanation !== false) {
      return {
        ask: false,
        jobId,
        customerId,
        withheld: rule.reason,
        explanation,
        clearsOnItsOwn: rule.clearsOnItsOwn,
      };
    }
  }

  const leftAt = facts.technicianLeftAt;
  if (!leftAt) {
    /**
     * Unreachable while `departure_time_unknown` sits above in the table.
     * Kept because it is what makes the types honest, and because somebody
     * reordering that table should get a withheld request rather than an
     * invalid date arriving at the scheduler.
     */
    return {
      ask: false, jobId, customerId,
      withheld: "departure_time_unknown",
      explanation: "Nothing recorded when the technician left, so there is no clock to measure the delay from.",
      clearsOnItsOwn: true,
    };
  }

  /**
   * The delay runs from whichever came later: the technician leaving, or the
   * callback being closed out. Measuring from the original visit would fire
   * the request the moment a callback was resolved, about a job whose
   * defining event for the customer was us coming back twice.
   */
  const resolvedAt = facts.callback?.resolvedAt ?? null;
  const base = resolvedAt && resolvedAt.getTime() > leftAt.getTime() ? resolvedAt : leftAt;
  const earliest = new Date(base.getTime() + policy.delayMinutes * 60_000);
  const candidate = earliest.getTime() > now.getTime() ? earliest : now;
  const sendAt = nextSendableInstant(candidate, policy);

  return { ask: true, jobId, customerId, sendAt, readyNow: sendAt.getTime() <= now.getTime() };
}

/* ========================================================================
 * 2b. WHAT THE REPLY IS FOR
 * ===================================================================== */

/**
 * What the customer said, after the invitation already went out.
 *
 * This type exists downstream of the ask on purpose. Nothing in section 2
 * can see it, and nothing in section 2 takes an argument that could carry
 * it. That is the ordering the whole module is arranged around.
 */
export interface Reply {
  jobId: string;
  customerId: string;
  /** One to five. */
  rating: number;
  receivedAt: Date;
}

export interface RecoveryPolicy {
  /** At or below this rating, a human owes them a conversation. */
  recoverAtOrBelow: number;
  /** At or below this, it is today's problem rather than tomorrow's. */
  sameDayAtOrBelow: number;
}

export type RecoveryDecision =
  | { recover: true; urgency: "same_day" | "next_business_day"; because: string }
  | { recover: false; because: string };

/**
 * Who gets a phone call.
 *
 * The legitimate version of the thing section 1 refuses. It reads a rating
 * that has already been given rather than one that has been guessed, it
 * changes who we ring rather than who we invite, and it runs after the
 * public ask rather than in place of it. Strip any one of those three and it
 * becomes the prohibited feature, which is why they are stated here rather
 * than left to be inferred from the call site.
 */
export function routeReply(reply: Reply, policy: RecoveryPolicy): RecoveryDecision {
  if (reply.rating > policy.recoverAtOrBelow) {
    return {
      recover: false,
      because: `They rated the job ${reply.rating}. Nothing is owed beyond a thank you.`,
    };
  }
  const urgency = reply.rating <= policy.sameDayAtOrBelow ? "same_day" : "next_business_day";
  return {
    recover: true,
    urgency,
    because: `They rated the job ${reply.rating}. Somebody should ring them${urgency === "same_day" ? " today" : " tomorrow"}, and the review they leave is not the point of the call.`,
  };
}

/* ========================================================================
 * 3. WHAT THE RATING ACTUALLY IS
 * ===================================================================== */

export interface Review {
  id: string;
  /** The operator's own identifier for the platform it was posted on. */
  platform: string;
  /** One to five. */
  rating: number;
  postedAt: Date;
  /** When we replied, if we have. */
  respondedAt?: Date | null;
  /** Who did the work, when the review names them or the job does. */
  technicianId?: string | undefined;
}

/** The two sided confidence level the lower bound is computed at. */
export const Z_95 = 1.959963984540054;

/**
 * The Wilson score interval's lower bound.
 *
 * WHY THIS ONE, NAMED EXPLICITLY, BECAUSE THE CHOICE IS THE WHOLE POINT.
 *
 * The failure it prevents: a technician with four five star reviews sits at
 * the top of every list in the product, above one with forty at 4.8, because
 * a mean has no idea how many numbers went into it. Somebody then hands the
 * new technician the commercial accounts. Four reviews is not evidence, and
 * a bare mean cannot say so.
 *
 * Wilson takes the sample size into the ordering directly: the interval is
 * wide when n is small and narrows as n grows, so the lower bound rises
 * toward the mean only as the evidence arrives. The alternatives were
 * considered and rejected. A plain mean has no n in it at all. A minimum
 * review threshold hides new technicians completely rather than ranking them
 * cautiously. A Bayesian average with a prior does the same job and is
 * arguably better, but it requires choosing a prior mean and a prior weight,
 * which are two numbers nobody in the office can defend if asked; Wilson's
 * only parameter is a confidence level.
 *
 * WHAT IS APPROXIMATE ABOUT IT, SAID PLAINLY. Wilson is derived for a
 * binomial proportion: a yes or no per trial. A five star scale is not that.
 * Each review is mapped to its share of the maximum, (rating - 1) / 4, and
 * the sum of those shares is used where a count of successes would go. The
 * variance term is therefore wrong in the third decimal place, because a
 * scale with five levels does not have the variance of a coin. It is wrong
 * in a way that does not matter for the only thing this number is used for,
 * which is ORDERING, because the error is in the same direction for every
 * group being ordered. It would matter if the number were displayed to a
 * customer as a rating, which is why it is not.
 */
export function wilsonLowerBound(successes: number, trials: number, z = Z_95): number {
  if (trials <= 0) return 0;
  /**
   * At no successes the bound is exactly zero, because the centre and the
   * spread are the same quantity, z squared over twice n, and they cancel.
   * Computed separately they leave floating point dust of about 1e-17, which
   * is small enough to look like nothing and large enough to decide an
   * ordering: two groups holding nothing but one star reviews come out at
   * different numbers, and the three review one sorts ABOVE the thirty review
   * one. That is the exact inversion this section exists to prevent, and it
   * arrives past the tie break that was supposed to catch it, so the
   * degenerate case is answered rather than computed.
   */
  if (successes <= 0) return 0;
  const p = successes / trials;
  const z2 = z * z;
  const centre = p + z2 / (2 * trials);
  const spread = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  const bound = (centre - spread) / (1 + z2 / trials);
  // Only the low end can drift. At p of exactly 1 the bound works out to
  // 1 / (1 + z squared over n), which is under 1 for every finite n, and the
  // exact answer at p of 0 is returned above. This is the backstop.
  return Math.min(1, Math.max(0, bound));
}

export interface RatingView {
  count: number;
  /** Null rather than zero when there is nothing to average. A business with
   * no reviews does not have a rating of 0.0, and a 0.0 on a screen is a
   * catastrophe rendered as a fact. */
  mean: number | null;
  /** The same average with old reviews worth less. Null on an empty set. */
  recentMean: number | null;
  /** The confidence aware figure, on the one to five scale, for ORDERING. */
  confidence: number | null;
  method: "wilson_lower_bound_95_on_share_of_maximum";
  /** What each number above is wrong about. Shown next to it, not buried. */
  caveats: { mean: string; recentMean: string; confidence: string };
}

export interface RatingOptions {
  /**
   * How long it takes a review to count half as much. Exponential rather
   * than a cutoff window, because a cutoff makes the recent average jump on
   * the day an old review falls out of it, and somebody then asks why the
   * rating dropped on a day nothing happened.
   */
  halfLifeDays: number;
}

/**
 * Three views of the same reviews, because no single number is honest.
 *
 * The mean is what every platform shows and it is wrong about TIME: a shop
 * that was badly run two years ago and is well run now reads as mediocre
 * forever, and the owner cannot tell whether last quarter helped. The
 * recency weighted view fixes that and is wrong about VOLUME: with a dozen
 * reviews it swings on one. The lower bound is wrong about HOW GOOD YOU ARE,
 * deliberately and always downward, which is exactly what makes it safe to
 * sort by and unsafe to print on a van.
 */
export function summarise(
  reviews: readonly Review[],
  options: RatingOptions,
  now: Date,
): RatingView {
  const caveats = {
    mean: "Every review counts the same however old it is, so a bad year two years ago is still in this number and no amount of recent work moves it quickly.",
    recentMean: "Old reviews are discounted, so this moves fast. On a small number of reviews a single new one swings it, and that swing is not news.",
    confidence: "Deliberately pessimistic, and lower than the real rating by design. It is for putting technicians or locations in order without a two review newcomer topping the list. Never show it to a customer as the rating.",
  } as const;

  const count = reviews.length;
  if (count === 0) {
    return { count: 0, mean: null, recentMean: null, confidence: null, method: "wilson_lower_bound_95_on_share_of_maximum", caveats };
  }

  const total = reviews.reduce((sum, review) => sum + review.rating, 0);
  const mean = total / count;

  let weighted = 0;
  let weight = 0;
  for (const review of reviews) {
    const ageDays = Math.max(0, (now.getTime() - review.postedAt.getTime()) / DAY_MS);
    const w = Math.pow(0.5, ageDays / options.halfLifeDays);
    weighted += review.rating * w;
    weight += w;
  }
  /**
   * A weight total of zero means every review is old enough that its weight
   * underflowed to nothing. Falling back to the plain mean is better than a
   * division by zero rendering NaN on a dashboard, and better than null,
   * which would read as "no reviews" for a business that has plenty.
   */
  const recentMean = weight > 0 ? weighted / weight : mean;

  const successes = reviews.reduce((sum, review) => sum + (review.rating - 1) / 4, 0);
  const confidence = 1 + 4 * wilsonLowerBound(successes, count);

  return { count, mean, recentMean, confidence, method: "wilson_lower_bound_95_on_share_of_maximum", caveats };
}

export interface RatedGroup {
  /** A technician id, a location id, whatever is being ranked. */
  key: string;
  reviews: readonly Review[];
}

export interface RankedGroup {
  key: string;
  view: RatingView;
}

/**
 * Put groups in order without letting a two review newcomer win.
 *
 * Ties break on count first, so between two groups the interval cannot
 * separate, the one with more evidence goes above. Then on the key, so the
 * order is stable and a list does not reshuffle itself between page loads
 * for no reason anybody can explain.
 */
export function rankByConfidence(
  groups: readonly RatedGroup[],
  options: RatingOptions,
  now: Date,
): RankedGroup[] {
  return groups
    .map((group) => ({ key: group.key, view: summarise(group.reviews, options, now) }))
    .sort((a, b) => {
      const left = a.view.confidence ?? 0;
      const right = b.view.confidence ?? 0;
      if (left !== right) return right - left;
      if (a.view.count !== b.view.count) return b.view.count - a.view.count;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
}

/* ========================================================================
 * 4. WHICH REVIEWS NEED A REPLY, AND BY WHEN
 * ===================================================================== */

export interface ResponseBand {
  /** The highest rating this band covers, inclusive. */
  upToRating: number;
  /** The clock, in hours. */
  withinHours: number;
  /**
   * Whether the clock only runs while the office is open. A one star wants
   * a reply from somebody who can actually resolve it, and there is nobody
   * in the building at two on a Sunday morning. A five star does not care.
   */
  businessHoursOnly: boolean;
  /** Lower sorts first when two items are due at the same moment. */
  priority: number;
  /** Why this clock and not another. Shown on the work list. */
  reason: string;
}

export interface ResponsePolicy {
  timeZone: string;
  /** Days the office is open, 0 for Sunday through 6 for Saturday. */
  businessDays: readonly number[];
  openHour: number;
  closeHour: number;
  /** Ascending by `upToRating`, covering 1 through 5. */
  bands: readonly ResponseBand[];
}

/**
 * A STARTING POINT, NOT A RULE FROM ANYWHERE.
 *
 * Worth contrasting with section 5, which ships no defaults at all. The
 * difference is whose rule it is. This is the company's own service
 * standard, invented here as something to edit, and being wrong about it
 * costs a reply sent a day later than somebody would have liked. A table of
 * a platform's rules is somebody else's rule, it goes stale without anybody
 * noticing, and in a self hosted product it can never be corrected in the
 * field. So one ships with defaults and the other does not.
 */
export const DEFAULT_RESPONSE_BANDS: readonly ResponseBand[] = [
  {
    upToRating: 1,
    withinHours: 4,
    businessHoursOnly: true,
    priority: 1,
    reason: "A one star is the review every prospect reads first, and the reply under it is the only part of that conversation we control. Four open hours, because the useful reply is the one that arrives while the customer is still willing to pick up the phone.",
  },
  {
    upToRating: 3,
    withinHours: 24,
    businessHoursOnly: true,
    priority: 2,
    reason: "Two and three star reviews are the ones that describe a fixable process. They are worth a considered answer rather than a fast one, but they still age badly.",
  },
  {
    upToRating: 4,
    withinHours: 72,
    businessHoursOnly: true,
    priority: 3,
    reason: "A four star usually names the one thing that stopped it being a five. Answering it is how that thing gets fixed.",
  },
  {
    upToRating: 5,
    withinHours: 168,
    businessHoursOnly: false,
    priority: 4,
    reason: "A five star still gets an answer, because a profile where only the complaints have replies reads as a company that only shows up when it is in trouble. Calendar hours, since nothing is at stake in the delay.",
  },
];

export type PolicyVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Whether the declared policy can be used at all.
 *
 * Configuration on a machine this project does not run, so it is checked
 * rather than trusted. The failure that matters most is an empty set of
 * business days: the deadline search would then have no hour that counts and
 * would spin to its bound on every review, which presents as a slow screen
 * rather than as the configuration error it is.
 */
export function checkResponsePolicy(policy: ResponsePolicy): PolicyVerdict {
  if (policy.businessDays.length === 0) {
    return { ok: false, reason: "The response policy has no business days on it, so a deadline measured in open hours can never arrive. Set the days the office is open." };
  }
  if (policy.businessDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    return { ok: false, reason: "Business days are numbers from 0 for Sunday to 6 for Saturday, and one of these is outside that." };
  }
  if (!(policy.openHour < policy.closeHour)) {
    return { ok: false, reason: `The office is set to open at ${policy.openHour} and close at ${policy.closeHour}, which is not a day with any hours in it.` };
  }
  if (policy.bands.length === 0) {
    return { ok: false, reason: "The response policy has no bands, so no review would ever be due a reply." };
  }
  let previous = 0;
  for (const band of policy.bands) {
    if (!(band.upToRating > previous)) {
      return { ok: false, reason: `The bands are out of order at ${band.upToRating}. They run from the lowest rating up, and each one covers everything above the last.` };
    }
    if (!(band.withinHours > 0)) {
      return { ok: false, reason: `The band up to ${band.upToRating} allows ${band.withinHours} hours, which makes every review in it overdue the moment it is posted.` };
    }
    previous = band.upToRating;
  }
  if (previous < 5) {
    return { ok: false, reason: `The bands stop at ${previous}, so a five star review would have no deadline and would silently never appear on the work list.` };
  }
  return { ok: true };
}

/** The band a rating falls in, or null when the policy does not cover it. */
export function bandFor(rating: number, policy: ResponsePolicy): ResponseBand | null {
  return policy.bands.find((band) => rating <= band.upToRating) ?? null;
}

/**
 * The day of the week an instant falls on IN THE COMPANY'S ZONE.
 *
 * Via the calendar date rather than `getDay`, which answers for the server.
 * A review posted at eight on a Friday evening in Chicago is already
 * Saturday in UTC, and a deadline computed from the server's weekday would
 * skip the whole of the working day that is actually left.
 */
function weekdayIn(instant: Date, timeZone: string): number {
  return new Date(`${dateIn(instant, timeZone)}T00:00:00Z`).getUTCDay();
}

function openingOn(date: string, policy: ResponsePolicy): Date {
  const open = policy.openHour * 60;
  return wallTimeExists(date, open, policy.timeZone)
    ? instantOfLocal(date, open, policy.timeZone)
    : instantOfLocal(date, open + 60, policy.timeZone);
}

/**
 * When a reply to this review is due.
 *
 * For a band measured in OPEN hours the clock only runs on days the office
 * is open, between opening and closing, in the company's zone. The naive
 * version, posted plus four hours, gives a one star posted at eight on a
 * Friday evening a deadline of midnight on Saturday: a deadline nobody can
 * meet, already breached by Monday morning, on a work list that is therefore
 * permanently red and consequently ignored. A work list nobody trusts is the
 * same as not having one.
 *
 * The loop is bounded. `checkResponsePolicy` rejects the configuration that
 * would make it spin, and the bound is what stops a bad configuration that
 * slipped past from hanging a request instead of returning a wrong date.
 */
export function respondBy(postedAt: Date, band: ResponseBand, policy: ResponsePolicy): Date {
  if (!band.businessHoursOnly) {
    return new Date(postedAt.getTime() + band.withinHours * 3_600_000);
  }

  const open = policy.openHour * 60;
  const close = policy.closeHour * 60;
  let remainingMinutes = band.withinHours * 60;
  let cursor = postedAt;

  for (let pass = 0; pass < 400; pass += 1) {
    const date = dateIn(cursor, policy.timeZone);
    const minutes = minutesInDay(cursor, policy.timeZone);

    if (!policy.businessDays.includes(weekdayIn(cursor, policy.timeZone)) || minutes >= close) {
      cursor = openingOn(nextDay(date), policy);
      continue;
    }
    if (minutes < open) {
      cursor = openingOn(date, policy);
      continue;
    }

    const availableToday = close - minutes;
    if (remainingMinutes <= availableToday) {
      /**
       * Built from the wall clock rather than by adding milliseconds, so a
       * deadline that crosses a daylight saving change lands on the hour the
       * office recognises rather than an hour either side of it.
       */
      return instantOfLocal(date, minutes + remainingMinutes, policy.timeZone);
    }
    remainingMinutes -= availableToday;
    cursor = openingOn(nextDay(date), policy);
  }
  return cursor;
}

export interface ResponseItem {
  review: Review;
  band: ResponseBand;
  dueAt: Date;
  /** Why this one has this clock. Straight from the band, for the screen. */
  reason: string;
  /** Milliseconds past the deadline. Zero when it is not late yet. */
  overdueBy: number;
}

/**
 * The reply queue, in the order somebody should work it.
 *
 * Overdue first, most overdue at the top, then by deadline, then by the
 * band's priority. The first two of those are one ordering and not two:
 * `now` is the same for every item, so descending lateness IS ascending
 * deadline, and lateness is clamped at zero so everything not yet due ties
 * and falls through to its deadline anyway. The lateness comparator is kept
 * for what it says and for surviving a change to how lateness is measured,
 * not because it separates anything the next one would not. The priority tie
 * break is the one doing separate work, for two reviews in different bands
 * that fall due at the same moment.
 *
 * Sorting by rating alone would put a week old one star below a fresh one,
 * and sorting by date alone would put a five star from this morning above a
 * one star from last night.
 *
 * Reviews we have already answered are not on the list. A queue that keeps
 * showing finished work is a queue people stop reading.
 */
export function responseWorkList(
  reviews: readonly Review[],
  policy: ResponsePolicy,
  now: Date,
): ResponseItem[] {
  const items: ResponseItem[] = [];

  for (const review of reviews) {
    if (review.respondedAt) continue;
    const band = bandFor(review.rating, policy);
    /**
     * A rating outside the declared bands is skipped rather than guessed at.
     * Guessing would put a review on the list with a deadline nobody
     * declared, and `checkResponsePolicy` already refuses the policy that
     * makes this possible, so reaching here means somebody bypassed it.
     */
    if (!band) continue;
    const dueAt = respondBy(review.postedAt, band, policy);
    items.push({
      review,
      band,
      dueAt,
      reason: band.reason,
      overdueBy: Math.max(0, now.getTime() - dueAt.getTime()),
    });
  }

  return items.sort((a, b) => {
    if (a.overdueBy !== b.overdueBy) return b.overdueBy - a.overdueBy;
    if (a.dueAt.getTime() !== b.dueAt.getTime()) return a.dueAt.getTime() - b.dueAt.getTime();
    return a.band.priority - b.band.priority;
  });
}

/* ========================================================================
 * 5. WHAT EACH PLATFORM FORBIDS
 * ===================================================================== */

/**
 * THIS FILE MAKES NO CLAIM ABOUT ANY NAMED COMPANY'S CURRENT POLICY.
 *
 * Same reasoning, and deliberately the same shape, as the telephony module's
 * CONSENT_RULES, which ships no table of which jurisdictions are one party
 * and which are all party. Shipping a table that says "this platform forbids
 * incentives and that one does not" would be shipping a claim about somebody
 * else's terms, into a product that is self hosted and can therefore never
 * be corrected in the field once it goes stale. The terms change, the copy
 * here would not, and a contractor would be relying on a screen that was
 * accurate on the day it was written.
 *
 * So what is modelled is the MECHANISM. The prohibitions below are the kinds
 * of thing a review platform forbids, each with the consequence of being
 * caught. Which of them applies where is CONFIGURATION, declared per
 * platform by the operator, who has read the terms themselves. This file
 * applies what they declared and refuses when they have declared nothing.
 *
 * ONE RULE IS ABSENT FROM THIS TABLE ON PURPOSE. Asking only the customers
 * you expect to say something nice is prohibited everywhere and is also not
 * here, because everything in this table is a switch an operator can turn
 * off. That one is not configurable in this product at any setting, for the
 * reasons in the file header, and putting it here would imply otherwise.
 */
export const PROHIBITIONS = [
  "incentives",
  "bulk_requests",
  "templated_replies",
  "solicitation_on_site",
  "third_party_sending",
] as const;

export type Prohibition = (typeof PROHIBITIONS)[number];

export interface ProhibitionProfile {
  label: string;
  /** One sentence an office manager would recognise as the thing they do. */
  description: string;
  /** What happens when it is noticed. Shown on the settings screen. */
  consequence: string;
}

export const PROHIBITION: Record<Prohibition, ProhibitionProfile> = {
  incentives: {
    label: "Anything of value for a review",
    description: "A discount, a credit, an entry into a draw, a gift card, offered in exchange for posting.",
    consequence: "Reviews obtained this way are removed when found, and the pattern is easy to see from the outside because they arrive in a burst. The listing itself can go with them.",
  },
  bulk_requests: {
    label: "Asking everybody at once",
    description: "A single send to a list, rather than one request tied to one job that just finished.",
    consequence: "A spike in a rating distribution is the exact signature the platforms filter on, and the usual outcome is that the whole batch is discarded, including the genuine ones.",
  },
  templated_replies: {
    label: "The same reply under every review",
    description: "One block of text pasted under every review, or generated for every review without anybody reading the review.",
    consequence: "It is visible to any prospect who scrolls, which is the real cost, and some platforms treat identical replies at volume as automated activity.",
  },
  solicitation_on_site: {
    label: "Asking at the door",
    description: "A technician standing in the customer's kitchen asking them to post a review before they leave.",
    consequence: "The reviews arrive from the same handful of locations in a pattern that reads as coordinated, and a customer asked in person is a customer who felt obliged, which some platforms treat as a solicited review regardless of what it says.",
  },
  third_party_sending: {
    label: "Sending from somebody else's system",
    description: "Requests issued by an agency or a tool under its own identity rather than the company's.",
    consequence: "The platform sees one sender behind hundreds of businesses, and an enforcement against that sender takes every business with it.",
  },
};

export interface PlatformPolicy {
  /**
   * The operator's own identifier for a platform, matched exactly against
   * what is recorded on a request. Never parsed, never prefix matched: a
   * fuzzy match here silently applies one platform's rules to another.
   */
  platform: string;
  prohibits: readonly Prohibition[];
  /** What the operator is claiming, in their words, with the date they checked. */
  note: string;
}

export type PlatformCatalogueVerdict =
  | { ok: true; byPlatform: ReadonlyMap<string, PlatformPolicy> }
  | { ok: false; reason: string };

/**
 * Whether the declared platform policies can be used at all.
 *
 * The two that matter: a prohibition outside the known set, which would fall
 * through every comparison and behave like no rule at all, and a duplicated
 * platform, where which rules apply would depend on the order the
 * configuration file happened to be read in.
 */
export function checkPlatformPolicies(
  policies: readonly PlatformPolicy[],
): PlatformCatalogueVerdict {
  const byPlatform = new Map<string, PlatformPolicy>();

  for (const policy of policies) {
    const id = policy.platform.trim();
    if (id === "") {
      return { ok: false, reason: "A platform policy has no platform on it. Every policy has to say what it applies to." };
    }
    if (byPlatform.has(id)) {
      return { ok: false, reason: `There are two policies for ${id}. Delete one: with both in place, which rules apply depends on the order the file happened to be read in.` };
    }
    const unknown = policy.prohibits.filter((rule) => !PROHIBITIONS.includes(rule));
    if (unknown.length > 0) {
      return { ok: false, reason: `The policy for ${id} lists ${unknown.map((rule) => `"${String(rule)}"`).join(", ")}, which this build does not know about. Known rules: ${PROHIBITIONS.join(", ")}.` };
    }
    if (policy.note.trim() === "") {
      return { ok: false, reason: `The policy for ${id} has no note. The note is what tells the next person which terms were read and when, and a blank one tells them nothing.` };
    }
    byPlatform.set(id, policy);
  }

  return { ok: true, byPlatform };
}

export interface PlannedRequest {
  platform: string;
  /** Something of value is offered in exchange for posting. */
  offersIncentive: boolean;
  /** Sent to a list in one go rather than tied to one finished job. */
  isBulkSend: boolean;
  /** Asked in person, on site, before the technician left. */
  askedOnSite: boolean;
  /** Issued under somebody else's sending identity. */
  sentByThirdParty: boolean;
}

export interface PlannedReply {
  platform: string;
  /** The same body is going under more than one review. */
  isTemplated: boolean;
}

export type PlatformVerdict =
  | { ok: true; platform: string }
  | { ok: false; platform: string; prohibition: Prohibition | null; reason: string };

/**
 * An unknown platform is refused rather than allowed.
 *
 * The same default as the telephony module takes for an undeclared
 * jurisdiction, for the same reason. Refusing costs a request that was
 * probably fine and a person adding a line of configuration. Allowing costs
 * a rule broken on a platform nobody had checked, and the penalty there
 * lands on the listing the company's phone calls come from.
 */
function undeclared(platform: string): PlatformVerdict {
  return {
    ok: false,
    platform,
    prohibition: null,
    reason: `Nothing has been declared about what ${platform} allows, so nothing is being sent to it. Add a policy for it in settings, with a note saying which terms were read and when.`,
  };
}

export function checkPlannedRequest(
  request: PlannedRequest,
  policies: ReadonlyMap<string, PlatformPolicy>,
): PlatformVerdict {
  const policy = policies.get(request.platform);
  if (!policy) return undeclared(request.platform);

  /**
   * Ordered from the most serious, so a request that breaks two rules is
   * reported by the one with the worse consequence. An incentive is
   * deliberate and is the one that gets reviews removed; asking at the door
   * is usually a technician being friendly.
   */
  const checks: readonly [Prohibition, boolean][] = [
    ["incentives", request.offersIncentive],
    ["third_party_sending", request.sentByThirdParty],
    ["bulk_requests", request.isBulkSend],
    ["solicitation_on_site", request.askedOnSite],
  ];

  for (const [prohibition, planned] of checks) {
    if (planned && policy.prohibits.includes(prohibition)) {
      const profile = PROHIBITION[prohibition];
      return {
        ok: false,
        platform: request.platform,
        prohibition,
        reason: `${profile.label}: not allowed on ${request.platform} under this company's declared policy. ${profile.consequence}`,
      };
    }
  }
  return { ok: true, platform: request.platform };
}

export function checkPlannedReply(
  reply: PlannedReply,
  policies: ReadonlyMap<string, PlatformPolicy>,
): PlatformVerdict {
  const policy = policies.get(reply.platform);
  if (!policy) return undeclared(reply.platform);

  if (reply.isTemplated && policy.prohibits.includes("templated_replies")) {
    const profile = PROHIBITION.templated_replies;
    return {
      ok: false,
      platform: reply.platform,
      prohibition: "templated_replies",
      reason: `${profile.label}: not allowed on ${reply.platform} under this company's declared policy. ${profile.consequence}`,
    };
  }
  return { ok: true, platform: reply.platform };
}
