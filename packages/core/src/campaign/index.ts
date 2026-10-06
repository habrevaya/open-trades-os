/**
 * CAMPAIGNS: THE HALF OF M19 THAT COULD NOT RUN
 *
 * `packages/core/src/marketing` can parse a touch, credit it under five
 * attribution models, validate a lead form and tell an owner what a channel
 * cost per booked job. All of that is measurement, and every bit of it is
 * about traffic somebody else sent. The thing a trades company owns outright,
 * its own customer list, could not be contacted at all: nothing in this
 * product selected an audience, and nothing sent to one. `campaign:read` and
 * `campaign:write` were on the owner's and the marketing manager's role from
 * the first migration, checked by nothing, which is the shape of a
 * restriction an owner believes they applied.
 *
 * WHY THE AUDIENCE IS A CLOSED SET OF RULES AND NOT A QUERY BUILDER
 *
 * A general query builder is the obvious thing to reach for and it is wrong
 * here in three separate ways. It is an injection surface against a database
 * where row level security is the only thing standing between two companies'
 * customer lists. It is an unbounded test matrix, so the day a filter
 * silently matches nobody there is no test that would have caught it. And it
 * produces audiences that cannot be explained: the screen can print the
 * filter tree, which is not the same as telling an owner "this will text the
 * 1,840 people who have not had us out in two years".
 *
 * The closed set below is nine rules, each one a campaign a contractor
 * actually runs. Each knows how to describe itself in a sentence. Adding a
 * tenth is a deliberate act with a test, which is the point.
 *
 * RULES COMBINE WITH AND, ONLY.
 *
 * Not because OR is hard, because OR is almost always a mistake here. An
 * owner building "lapsed maintenance OR in these postcodes" has not asked for
 * the union they typed; they want the intersection, and the union is four
 * times the send and the bill. AND also keeps every rule's contribution
 * visible: the preview can say what each one removed, and an audience that
 * came out at zero names the rule that emptied it.
 *
 * THE EMPTY RULE LIST IS REFUSED, and that refusal is the most valuable line
 * in this file. No rules means every customer on the list, which is the
 * single most expensive mistake available in this product: it is how a
 * company's domain gets blocked, how its one registered number gets flagged
 * by a carrier, and how a forty year old business teaches four thousand
 * people to mark it as spam in one afternoon. There is no accidental path to
 * sending to everybody.
 */

/* ------------------------------------------------------------------ rules */

export type RuleKind =
  /**
   * Win back: their most recent completed job is older than this.
   *
   * It REQUIRES one completed job, which is the difference between a win back
   * campaign and a campaign to everybody who ever rang for a price. Read
   * literally, "no job since" is also true of a lead who never bought, and a
   * discount offer to somebody who has never been a customer is a different
   * campaign with a different message.
   */
  | "no_job_since"
  /** Replacement: a unit old enough that the conversation is worth having. */
  | "equipment_older_than"
  /** Renewal: an agreement that ends soon. */
  | "agreement_ending_within"
  /** Win back a plan: an agreement that already lapsed or was cancelled. */
  | "agreement_lapsed"
  /**
   * Upsell: a customer who has NEVER held a plan, not one who holds none
   * today. The second reading includes everybody whose plan lapsed or
   * completed, and an introduction to somebody who had one for six years
   * reads as a company that does not know who its customers are. It is also
   * what makes the contradiction with `agreement_lapsed` true.
   */
  | "no_agreement"
  /** Geography, which is how a contractor thinks about density and drive time. */
  | "postal_code_in"
  /** The operator's own segmentation. */
  | "tagged_any"
  /** An inspection finding nobody bought. */
  | "open_deficiency"
  /**
   * Served at least once, which is how a list of leads is kept out of a
   * campaign meant for customers. Redundant beside `no_job_since`, which
   * implies it, and the reason it exists separately is a campaign to
   * customers with no agreement, where nothing else would exclude the leads.
   */
  | "served_at_least_once";

export type AudienceRule =
  | { kind: "no_job_since"; days: number }
  | { kind: "equipment_older_than"; years: number; category?: string | undefined }
  | { kind: "agreement_ending_within"; days: number }
  | { kind: "agreement_lapsed" }
  | { kind: "no_agreement" }
  | { kind: "postal_code_in"; codes: string[] }
  | { kind: "tagged_any"; tags: string[] }
  | { kind: "open_deficiency" }
  | { kind: "served_at_least_once" };

export const RULE_KINDS: readonly RuleKind[] = [
  "no_job_since", "equipment_older_than", "agreement_ending_within", "agreement_lapsed",
  "no_agreement", "postal_code_in", "tagged_any", "open_deficiency", "served_at_least_once",
];

/**
 * The longest a lookback may be, in days. Twenty years.
 *
 * Not a guess at what is reasonable: a bound, so a typo in a day count
 * cannot turn a win back campaign into "everybody we have ever met".
 */
export const MAX_LOOKBACK_DAYS = 7300;
/** An equipment age in years. Fifty, beyond which every unit qualifies. */
export const MAX_AGE_YEARS = 50;
/** How many postal codes or tags one rule may name. */
export const MAX_LIST = 200;

/* ---------------------------------------------------------------- refusals */

export type AudienceRefusal =
  | { reason: "no_rules"; message: string }
  | { reason: "unknown_rule"; message: string; kind: string }
  | { reason: "out_of_range"; message: string; kind: RuleKind }
  | { reason: "empty_list"; message: string; kind: RuleKind }
  | { reason: "list_too_long"; message: string; kind: RuleKind }
  | { reason: "repeated_rule"; message: string; kind: RuleKind }
  | { reason: "contradiction"; message: string; kind: RuleKind };

export type AudienceVerdict =
  | { ok: true; rules: AudienceRule[] }
  | { ok: false; refusals: AudienceRefusal[] };

/**
 * A rule a second copy of would be a contradiction rather than a narrowing.
 *
 * Two `postal_code_in` rules AND together to the intersection of two postcode
 * lists, which is either one of them or nothing, and whoever typed it meant
 * the union. Two `no_job_since` rules are the tighter of the two, so the
 * looser one is a line of configuration that does nothing. Both read as
 * working and neither does what it looks like, so both are refused rather
 * than resolved: an operator told "you have this rule twice" fixes it in
 * seconds, and an operator whose second rule was quietly dropped does not
 * find out until the send.
 */
const ONCE_ONLY: readonly RuleKind[] = RULE_KINDS;

/**
 * Pairs that cannot both hold, so an audience carrying both is empty by
 * construction. Checked because an empty audience is indistinguishable from
 * a rule that matched nobody this month, and the two want different answers.
 */
const CONTRADICTIONS: readonly [RuleKind, RuleKind][] = [
  ["no_agreement", "agreement_ending_within"],
  ["no_agreement", "agreement_lapsed"],
  /**
   * `agreement_lapsed` is about an agreement that has ended; `ending_within`
   * is about one that has not. A customer can hold one of each, which is why
   * this pair is NOT a contradiction and is deliberately absent from this
   * list.
   */
];

function rangeMessage(what: string, low: number, high: number, got: number): string {
  return `${what} has to be between ${low} and ${high}. It is ${got}.`;
}

/**
 * Whether this set of rules describes an audience worth sending to, and what
 * is wrong with it when it does not.
 *
 * ALL the refusals come back, not the first. An owner who has three problems
 * with a campaign should learn all three before the next attempt, for the
 * same reason the lead form returns every field's complaint at once.
 */
export function checkAudience(rules: readonly AudienceRule[]): AudienceVerdict {
  const refusals: AudienceRefusal[] = [];

  if (rules.length === 0) {
    refusals.push({
      reason: "no_rules",
      message:
        "A campaign needs at least one rule saying who it is for. With no rules it goes to "
        + "every customer on the list, which is how a company's sending number gets flagged "
        + "and its domain blocked in one afternoon.",
    });
    return { ok: false, refusals };
  }

  const seen = new Set<RuleKind>();
  for (const rule of rules) {
    if (!RULE_KINDS.includes(rule.kind)) {
      refusals.push({
        reason: "unknown_rule",
        kind: String((rule as { kind: string }).kind),
        message: `"${String((rule as { kind: string }).kind)}" is not something an audience can be `
          + `selected on. One of: ${RULE_KINDS.join(", ")}.`,
      });
      continue;
    }

    if (ONCE_ONLY.includes(rule.kind) && seen.has(rule.kind)) {
      refusals.push({
        reason: "repeated_rule",
        kind: rule.kind,
        message: `This campaign has the "${rule.kind}" rule twice. Two of them narrow to `
          + "whichever is tighter, so one of the two does nothing. Combine them into one.",
      });
    }
    seen.add(rule.kind);

    switch (rule.kind) {
      case "no_job_since":
      case "agreement_ending_within": {
        if (!Number.isInteger(rule.days) || rule.days < 1 || rule.days > MAX_LOOKBACK_DAYS) {
          refusals.push({
            reason: "out_of_range", kind: rule.kind,
            message: rangeMessage("A number of days", 1, MAX_LOOKBACK_DAYS, rule.days),
          });
        }
        break;
      }
      case "equipment_older_than": {
        if (!Number.isInteger(rule.years) || rule.years < 1 || rule.years > MAX_AGE_YEARS) {
          refusals.push({
            reason: "out_of_range", kind: rule.kind,
            message: rangeMessage("An age in years", 1, MAX_AGE_YEARS, rule.years),
          });
        }
        break;
      }
      case "postal_code_in": {
        const codes = rule.codes.filter((code) => code.trim() !== "");
        if (codes.length === 0) {
          refusals.push({
            reason: "empty_list", kind: rule.kind,
            message: "A postcode rule with no postcodes in it matches nobody. Remove the rule or "
              + "name the areas.",
          });
        } else if (codes.length > MAX_LIST) {
          refusals.push({
            reason: "list_too_long", kind: rule.kind,
            message: `${codes.length} postcodes is more than the ${MAX_LIST} this will take. `
              + "A list that long is not a geography, it is the whole service area.",
          });
        }
        break;
      }
      case "tagged_any": {
        const tags = rule.tags.filter((tag) => tag.trim() !== "");
        if (tags.length === 0) {
          refusals.push({
            reason: "empty_list", kind: rule.kind,
            message: "A tag rule with no tags in it matches nobody. Remove the rule or name the tags.",
          });
        } else if (tags.length > MAX_LIST) {
          refusals.push({
            reason: "list_too_long", kind: rule.kind,
            message: `${tags.length} tags is more than the ${MAX_LIST} this will take.`,
          });
        }
        break;
      }
      case "agreement_lapsed":
      case "no_agreement":
      case "open_deficiency":
      case "served_at_least_once":
        break;
      default: {
        /** Unreachable while every kind above is handled, a build error when one is added. */
        const unchecked: never = rule;
        refusals.push({
          reason: "unknown_rule", kind: String(unchecked),
          message: `"${String(unchecked)}" has no validation written for it.`,
        });
      }
    }
  }

  for (const [a, b] of CONTRADICTIONS) {
    if (seen.has(a) && seen.has(b)) {
      refusals.push({
        reason: "contradiction", kind: a,
        message: `"${a}" and "${b}" cannot both be true of the same customer, so this audience is `
          + "empty before any data is looked at.",
      });
    }
  }

  if (refusals.length > 0) return { ok: false, refusals };
  return { ok: true, rules: [...rules] };
}

/* -------------------------------------------------------------- in words */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * One rule as a sentence an owner can check against what they meant.
 *
 * This is not a nicety. The difference between "has not had us out in 2
 * years" and "has not had us out in 2 months" is a factor of twelve in the
 * size of the send and the bill, and it is one character in a form.
 */
export function describeRule(rule: AudienceRule): string {
  switch (rule.kind) {
    case "no_job_since":
      return `were last served more than ${plural(rule.days, "day", "days")} ago`;
    case "equipment_older_than":
      return rule.category
        ? `have ${rule.category} equipment installed more than ${plural(rule.years, "year", "years")} ago`
        : `have equipment installed more than ${plural(rule.years, "year", "years")} ago`;
    case "agreement_ending_within":
      return `hold an agreement ending within ${plural(rule.days, "day", "days")}`;
    case "agreement_lapsed":
      return "had an agreement that has lapsed or been cancelled";
    case "no_agreement":
      return "have never held an agreement";
    case "postal_code_in":
      return `have a property in ${rule.codes.length === 1 ? rule.codes[0] : `${rule.codes.length} postcodes`}`;
    case "tagged_any":
      return `are tagged ${rule.tags.map((t) => `"${t}"`).join(" or ")}`;
    case "open_deficiency":
      return "have an inspection finding that is still open";
    case "served_at_least_once":
      return "have had at least one job completed";
    default: {
      const undescribed: never = rule;
      return String(undescribed);
    }
  }
}

/**
 * The whole audience as one sentence.
 *
 * "Customers who have not had completed work in 730 days and hold no
 * agreement." That sentence on a confirmation screen is the last thing
 * between an owner and a send they cannot take back.
 */
export function describeAudience(rules: readonly AudienceRule[]): string {
  if (rules.length === 0) return "Everybody, which this will not do.";
  return `Customers who ${rules.map(describeRule).join(" and ")}.`;
}

/* ----------------------------------------------------------------- pacing */

export interface PacePlan {
  /** How many go out in the first batch. */
  firstBatch: number;
  /** How many days the whole send takes at this cap. */
  days: number;
  /**
   * Seconds between messages, so a carrier's throughput is respected by
   * waiting rather than by being rejected. Null when nothing was declared.
   */
  secondsBetween: number | null;
  /** True when the audience does not fit in one day. */
  staged: boolean;
}

/**
 * How to spread a send across days and seconds.
 *
 * THE COLUMNS THIS READS WERE WRITTEN FOR A SENDER THAT DID NOT EXIST.
 * `messaging_campaign.messages_per_second` and `.daily_cap` have been in the
 * schema since registration was built, with the comment "carrier assigned
 * throughput, so the sender can pace rather than fail". They were written by
 * the registration service, read back by it for display, and consulted by no
 * sender, because there was no sender. A carrier that assigns 10 messages a
 * second and a daily cap of 2,000 does not slow a sender down that ignores
 * it; it rejects the overflow, and a rejected marketing message counts
 * against the number's standing whether or not anybody reads the error.
 *
 * `cap` of zero is NOT "no cap". It is a carrier that has approved the
 * registration and allowed nothing through, which happens, and it must send
 * nothing rather than everything. Absent (null) is no declared cap.
 */
export function pace(count: number, limits: {
  perSecond?: number | null | undefined;
  dailyCap?: number | null | undefined;
}): PacePlan {
  const cap = limits.dailyCap ?? null;
  const perSecond = limits.perSecond ?? null;
  const secondsBetween = perSecond !== null && perSecond > 0 ? 1 / perSecond : null;

  if (cap === null) {
    return { firstBatch: count, days: count === 0 ? 0 : 1, secondsBetween, staged: false };
  }
  if (cap <= 0) {
    return { firstBatch: 0, days: 0, secondsBetween, staged: count > 0 };
  }
  const firstBatch = Math.min(count, cap);
  return {
    firstBatch,
    days: Math.ceil(count / cap),
    secondsBetween,
    staged: count > cap,
  };
}

/* ---------------------------------------------------- what a send becomes */

export type RecipientState =
  /** Selected, not yet handed to a sender. */
  | "pending"
  /** Handed to the outbox. Whether it arrives is the outbox's answer, not ours. */
  | "queued"
  /** Not sent, and the reason is on the row. Never silently dropped. */
  | "skipped";

export const RECIPIENT_STATES: readonly RecipientState[] = ["pending", "queued", "skipped"];

export type CampaignState = "draft" | "scheduled" | "sending" | "sent" | "cancelled";

export const CAMPAIGN_STATES: readonly CampaignState[] = [
  "draft", "scheduled", "sending", "sent", "cancelled",
];

/**
 * Which state changes are allowed.
 *
 * A campaign that has sent anything can never return to draft. The body of a
 * sent campaign is what four thousand people have in their inbox, and a
 * product that lets somebody edit it afterwards is a product whose own record
 * of what it said is a guess.
 */
const TRANSITIONS: Record<CampaignState, readonly CampaignState[]> = {
  draft: ["scheduled", "sending", "cancelled"],
  scheduled: ["draft", "sending", "cancelled"],
  /**
   * `sending` to `sending` is allowed, and it is how a staged send continues
   * on the second day. Without it the next batch would need a state nothing
   * else distinguishes.
   */
  sending: ["sending", "sent", "cancelled"],
  sent: [],
  cancelled: [],
};

export function canTransition(from: CampaignState, to: CampaignState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transitionRefusal(from: CampaignState, to: CampaignState): string {
  if (from === "sent") {
    return "This campaign has already gone out. What it said is in people's inboxes, and a "
      + "record that can be edited afterwards is not a record. Copy it into a new campaign.";
  }
  if (from === "cancelled") {
    return "This campaign was cancelled. Copy it into a new one rather than reviving it, so the "
      + "cancellation stays true.";
  }
  return `A ${from} campaign cannot become ${to}.`;
}

/* -------------------------------------------------------------- the body */

export type BodyRefusal =
  | { reason: "empty"; message: string }
  | { reason: "no_subject"; message: string }
  | { reason: "subject_on_sms"; message: string }
  | { reason: "too_long"; message: string }
  | { reason: "unknown_field"; message: string };

/**
 * WHAT A CAMPAIGN BODY MAY SAY ABOUT THE PERSON IT GOES TO.
 *
 * The placeholders are the message templates' own syntax, `{{ customer.firstName }}`,
 * filled by the one renderer this product has, so a template an operator
 * already wrote in M18 can be the body of a campaign without translation.
 *
 * A CLOSED LIST, and the reason is the renderer's own rule: an unknown path
 * resolves to an empty string rather than failing, so `{{ custmer.firstName }}`
 * sends "Hi ," to four thousand people and nothing anywhere reports it. A
 * template can be checked against what it declares; a campaign is checked
 * against this, before it can be saved.
 */
export const MERGE_FIELDS = [
  { key: "customer.firstName", label: "Their first name", example: "Maria" },
  { key: "customer.name", label: "Their name as it is on the account", example: "Maria Lopez" },
  { key: "company.name", label: "Your company's name", example: "Hartley Heating and Air" },
  { key: "company.phone", label: "Your main number", example: "+15125550100" },
] as const;

export type MergeField = (typeof MERGE_FIELDS)[number]["key"];

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** Every placeholder a body uses, in the order it first uses them. */
export function placeholdersIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1]!;
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * The first word of a customer's name, for "Hi Maria".
 *
 * Only the first word, because that is what a person is called, and the whole
 * name when it is one word. A commercial account comes out as the first word
 * of the company, which is why the merge field list says what each one is.
 */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/** The scope a campaign body renders against, for one recipient. */
export function mergeScope(input: {
  customerName: string;
  companyName: string;
  companyPhone?: string | null | undefined;
}): Record<string, unknown> {
  return {
    customer: { firstName: firstNameOf(input.customerName), name: input.customerName.trim() },
    company: { name: input.companyName, phone: input.companyPhone ?? "" },
  };
}

/**
 * Whether what is written can be sent on this channel.
 *
 * SMS has no subject line, and a campaign carrying one is a campaign built
 * for email and switched to text, where the subject becomes either a silently
 * dropped field or the first line of the message depending on who wrote the
 * sender. Refusing says which.
 *
 * The length bound is 1,600 characters, the practical ceiling on a segmented
 * SMS. Beyond it the carrier truncates, and a truncated marketing text with
 * no opt out line in the part that arrived is the opt out line missing.
 */
export const SMS_MAX = 1600;

export function checkBody(input: {
  channel: "sms" | "email";
  subject?: string | null | undefined;
  body: string;
}): { ok: true } | { ok: false; refusals: BodyRefusal[] } {
  const refusals: BodyRefusal[] = [];
  const body = input.body.trim();
  const subject = input.subject?.trim() ?? "";

  if (body === "") {
    refusals.push({ reason: "empty", message: "There is nothing to send." });
  }
  if (input.channel === "email" && subject === "") {
    refusals.push({
      reason: "no_subject",
      message: "An email campaign needs a subject line. A blank one is one of the oldest spam "
        + "signatures there is.",
    });
  }
  if (input.channel === "sms" && subject !== "") {
    refusals.push({
      reason: "subject_on_sms",
      message: "A text has no subject line. Put it in the message or switch the campaign to email.",
    });
  }
  if (input.channel === "sms" && body.length > SMS_MAX) {
    refusals.push({
      reason: "too_long",
      message: `${body.length} characters is longer than the ${SMS_MAX} a text can carry. The `
        + "carrier truncates the rest, and what gets cut off is the end, where the opt out line is.",
    });
  }

  const known = MERGE_FIELDS.map((f) => f.key as string);
  const unknown = [...placeholdersIn(body), ...placeholdersIn(subject)]
    .filter((name, i, all) => !known.includes(name) && all.indexOf(name) === i);
  if (unknown.length > 0) {
    refusals.push({
      reason: "unknown_field",
      message: `${unknown.map((u) => `{{ ${u} }}`).join(", ")} is not something a campaign can fill in, `
        + "and it would arrive as a gap in the sentence. The ones that work are: "
        + `${known.map((k) => `{{ ${k} }}`).join(", ")}.`,
    });
  }

  if (refusals.length > 0) return { ok: false, refusals };
  return { ok: true };
}

/* ------------------------------------------------------------- the result */

export interface CampaignResult {
  selected: number;
  queued: number;
  skipped: number;
  /** Reason to count, for the skipped. The worklist, not diagnostics. */
  skippedBy: Record<string, number>;
}

/**
 * The share of the audience that could actually be contacted, as a string.
 *
 * A number, not a float, for the same reason money is: this ends up on a
 * screen and in a report, and a reader comparing two campaigns needs the two
 * figures to have been produced the same way.
 */
export function reachRate(result: CampaignResult): string | null {
  if (result.selected === 0) return null;
  return ((result.queued / result.selected) * 100).toFixed(1);
}
