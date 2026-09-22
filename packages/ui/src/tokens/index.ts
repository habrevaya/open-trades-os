/**
 * DESIGN TOKENS
 *
 * The organizing idea: a field instrument, not a dashboard. This gets read
 * outdoors, on a phone, in sunlight, by someone wearing gloves.
 *
 * Semantic colours derive from the APWA Uniform Color Code, the utility
 * marking standard every excavator, plumber and locator in North America
 * already reads off the pavement: blue is potable water, red is electric,
 * yellow is gas, green is sewer, purple is reclaimed. It is invisible to
 * anyone who does not know it and immediately legible to anyone who does.
 *
 * Every foreground token below passes WCAG AA on white. The contrast ratios
 * are recorded because "legible in sunlight" is a requirement, not a vibe, and
 * a future change should have to knowingly break it.
 */

export const colors = {
  // Neutrals. Text floors at ink900, never #000, so it does not vibrate.
  ink900: "#10151A",   // 18.35:1  headlines, primary text, dark surfaces
  ink700: "#39424A",   // 10.23:1  body copy. AAA at 14px
  ink500: "#6A7480",   //  4.75:1  metadata. The last step that passes AA
  steel400: "#B9C2CB", //  1.80:1  disabled controls only. NEVER text
  steel300: "#D3DAE0",
  steel200: "#E6EAEE",
  steel100: "#F2F5F7",
  canvasRaised: "#FAFBFC",
  canvas: "#FFFFFF",

  // Action. One accent: APWA potable water blue, darkened to clear AA.
  blue100: "#E4EDFC",
  blue300: "#9FBCEF",
  blue600: "#0B57D0",  //  6.39:1
  blue700: "#08409B",  //  9.47:1

  // Semantic. Four states, learnable in a day.
  red600: "#C4261D",   //  5.77:1  electric   -> destructive, overdue
  redTint: "#FBEAE9",
  amber700: "#B45309", //  5.02:1  gas        -> warning, at risk
  amberTint: "#FCF0E1",
  green700: "#15803D", //  5.02:1  sewer      -> complete, paid
  greenTint: "#E6F4EB",
  purple700: "#6B3FA0",//  7.38:1  reclaimed  -> recurring, contracts
  purpleTint: "#F0EAF8",
} as const;

/** Job and invoice states, mapped to the semantic set once, centrally. */
export const statusTone = {
  // Jobs
  lead: "neutral", estimating: "info", scheduled: "info", in_progress: "info",
  on_hold: "warning", completed: "success", invoiced: "info", paid: "success",
  cancelled: "neutral",
  // Visits
  unassigned: "warning", dispatched: "info", en_route: "info", working: "info",
  no_show: "danger", completed_after_cancellation: "warning",
  // Invoices
  draft: "neutral", open: "info", partially_paid: "warning",
  void: "neutral", written_off: "danger",
  // Recurring work gets its own hue, which is what purple is reserved for.
  recurring: "recurring", membership: "recurring", contract: "recurring",
} as const;

export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "recurring";

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32, 12: 48, 16: 64 } as const;

/** No radius above 8px on a control, and no pills. Pills are for avatars. */
export const radius = { sm: 2, base: 4, md: 8, full: 9999 } as const;

/**
 * Control heights. 48px is not a style choice: it is the smallest target a
 * person wearing a work glove hits reliably, which is why the field app uses
 * it everywhere and the office app only for primary actions.
 */
export const controlHeight = { sm: 32, md: 40, lg: 48 } as const;

export const typography = {
  family: '"IBM Plex Sans", -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  /** Weights stop at 600. Hierarchy comes from size, colour and space. */
  weights: { normal: 400, medium: 500, semibold: 600 },
  /** Body never goes below 14px anywhere, because the field user is the constraint. */
  minBodyPx: 14,
} as const;
