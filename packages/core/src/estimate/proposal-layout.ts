/**
 * HOW A PROPOSAL IS LAID OUT, AS DATA IN A CLOSED VOCABULARY
 *
 * A company designs its proposal once: a cover with a photograph, then the
 * sections it sells in, in its own order (about us, the options, the
 * warranty, financing, what other customers said, the small print). This is
 * the shape that design is stored in and the rules it is held to, used by
 * the screen that edits it, the service that saves it, the page that draws a
 * proposal and the PDF, so the four cannot disagree about what a section is.
 *
 * CLOSED, for the reason custom field types are closed. A section kind is
 * only worth storing if the page and the PDF can both draw it; an open list
 * means a template saved with a kind one of them does not know, and a
 * customer's copy that silently leaves a page out.
 *
 * THE OPTIONS ARE A SECTION, AND THERE IS EXACTLY ONE OF THEM. Moving them is
 * the point (a company that opens on its warranty puts the price third), and
 * a proposal without them has nothing on it to approve.
 *
 * THE TERMS ARE THE ESTIMATE'S, NOT THE TEMPLATE'S. The section places them;
 * what they say was copied onto the estimate when it was written and is
 * covered by the approval hash. A template carrying its own terms would be a
 * second copy of the small print that could disagree with the first.
 */

export const SECTION_KINDS = [
  "options", "about", "warranty", "financing", "reviews", "terms", "custom",
] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

/** What each kind is called on the editor, and the heading it starts with. */
export const SECTION_LABEL: Record<SectionKind, string> = {
  options: "Your options",
  about: "About us",
  warranty: "Our warranty",
  financing: "Paying over time",
  reviews: "What customers say",
  terms: "Terms",
  custom: "A section of your own",
};

/** Kinds a layout may hold once at most. `custom` is the only one that repeats. */
const ONCE: readonly SectionKind[] = ["options", "about", "warranty", "financing", "reviews", "terms"];

/** Kinds that are nothing without words of their own. */
const NEEDS_BODY: readonly SectionKind[] = ["about", "warranty", "custom"];

export const MAX_SECTIONS = 12;
export const MAX_BODY = 4000;

export interface Section {
  kind: SectionKind;
  title: string;
  /** The words under the heading. Ignored on `options` and `terms`, which draw the estimate's own. */
  body: string | null;
  /** On `reviews`: the lowest rating shown, and how many at most. */
  minRating?: number | undefined;
  count?: number | undefined;
}

export interface Cover {
  headline: string;
  intro: string | null;
  /** The stored file key of the photograph, or null for a cover without one. */
  photoKey: string | null;
}

export interface Layout {
  cover: Cover | null;
  sections: Section[];
  showOptionPhotos: boolean;
}

/**
 * The layout every proposal had before templates: the options, then the
 * terms. An estimate with no layout of its own is drawn in this, so a
 * company that never opens the template editor sees exactly what it saw.
 */
export const FIXED_LAYOUT: Layout = {
  cover: null,
  sections: [
    { kind: "options", title: SECTION_LABEL.options, body: null },
    { kind: "terms", title: SECTION_LABEL.terms, body: null },
  ],
  showOptionPhotos: true,
};

/** A starting point for a new template, more than the fixed layout and still editable. */
export function starterLayout(companyName: string): Layout {
  return {
    cover: { headline: `A proposal from ${companyName}`, intro: null, photoKey: null },
    sections: [
      { kind: "about", title: SECTION_LABEL.about, body: `${companyName} is a local, licensed and insured company.` },
      { kind: "options", title: SECTION_LABEL.options, body: null },
      { kind: "warranty", title: SECTION_LABEL.warranty, body: "Every job is covered by our workmanship warranty." },
      { kind: "terms", title: SECTION_LABEL.terms, body: null },
    ],
    showOptionPhotos: true,
  };
}

export type LayoutDecision = { ok: true; layout: Layout } | { ok: false; problems: string[] };

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * WHETHER A LAYOUT CAN BE SAVED, AND WHAT IT IS ONCE IT CAN.
 *
 * Takes `unknown`, because it is called on what a form posted, what the API
 * was sent and what an estimate's stored copy holds, and none of those is
 * trusted to be the right shape. Every problem at once, numbered by section,
 * because "section 4 needs some words" is something a person can find.
 */
export function checkLayout(input: unknown): LayoutDecision {
  const problems: string[] = [];
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  let cover: Cover | null = null;
  if (raw["cover"] !== null && raw["cover"] !== undefined) {
    const c = (typeof raw["cover"] === "object" ? raw["cover"] : {}) as Record<string, unknown>;
    const headline = text(c["headline"]);
    const intro = text(c["intro"]) || null;
    const photoKey = text(c["photoKey"]) || null;
    if (headline === "") problems.push("The cover needs a headline, or take the cover off.");
    if (headline.length > 120) problems.push("The cover's headline is longer than a hundred and twenty characters.");
    if (intro && intro.length > 600) problems.push("The cover's introduction is longer than six hundred characters.");
    cover = { headline, intro, photoKey };
  }

  const list = Array.isArray(raw["sections"]) ? raw["sections"] as unknown[] : [];
  if (list.length > MAX_SECTIONS) problems.push(`A proposal holds at most ${MAX_SECTIONS} sections.`);

  const sections: Section[] = [];
  const counted = new Map<SectionKind, number>();
  list.forEach((entry, index) => {
    const n = index + 1;
    const s = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const kind = text(s["kind"]);
    if (!(SECTION_KINDS as readonly string[]).includes(kind)) {
      problems.push(`Section ${n} is a "${kind || "nothing"}", which a proposal cannot draw. One of: ${SECTION_KINDS.join(", ")}.`);
      return;
    }
    const k = kind as SectionKind;
    counted.set(k, (counted.get(k) ?? 0) + 1);
    const title = text(s["title"]) || SECTION_LABEL[k];
    const body = text(s["body"]) || null;
    if (title.length > 80) problems.push(`Section ${n}'s heading is longer than eighty characters.`);
    if (body && body.length > MAX_BODY) problems.push(`Section ${n} is longer than ${MAX_BODY} characters.`);
    if (NEEDS_BODY.includes(k) && !body) problems.push(`Section ${n} (${title}) needs some words under it.`);

    const section: Section = { kind: k, title, body: k === "options" || k === "terms" ? null : body };
    if (k === "reviews") {
      const minRating = s["minRating"] === undefined || s["minRating"] === null || s["minRating"] === "" ? 5 : Number(s["minRating"]);
      const count = s["count"] === undefined || s["count"] === null || s["count"] === "" ? 3 : Number(s["count"]);
      if (!Number.isInteger(minRating) || minRating < 1 || minRating > 5) problems.push(`Section ${n}: the lowest rating shown is a whole number from 1 to 5.`);
      if (!Number.isInteger(count) || count < 1 || count > 6) problems.push(`Section ${n}: show between 1 and 6 reviews.`);
      section.minRating = minRating;
      section.count = count;
    }
    sections.push(section);
  });

  for (const kind of ONCE) {
    if ((counted.get(kind) ?? 0) > 1) problems.push(`${SECTION_LABEL[kind]} is in the proposal twice. It can be there once.`);
  }
  if ((counted.get("options") ?? 0) === 0) {
    problems.push("The options have to be in the proposal: without them there is nothing to approve.");
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, layout: { cover, sections, showOptionPhotos: raw["showOptionPhotos"] !== false } };
}

/**
 * What an estimate is drawn in: its own copy when it has one that still
 * reads, and the fixed layout otherwise. A stored copy this build cannot
 * read (written by a newer one, or damaged) falls back rather than throwing,
 * because a customer's proposal that will not open is worse than one in the
 * plain layout.
 */
export function layoutOrFixed(stored: unknown): Layout {
  if (stored === null || stored === undefined) return FIXED_LAYOUT;
  const decision = checkLayout(stored);
  return decision.ok ? decision.layout : FIXED_LAYOUT;
}

/** A section moved up (-1) or down (1), for the editor's arrows. Out of range is no move. */
export function moveSection<T>(sections: readonly T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  if (index < 0 || index >= sections.length || to < 0 || to >= sections.length) return [...sections];
  const out = [...sections];
  const [moved] = out.splice(index, 1);
  out.splice(to, 0, moved!);
  return out;
}
