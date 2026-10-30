import { Flow, INK, MUTED, RULE, LOSS, longDate, usd, quantity, widthOf, type Column } from "./layout.js";
import { hex, fit, type RenderOptions, type Rgb } from "./writer.js";
import type { PdfImage } from "./image.js";
import { documentNumber } from "../work/index.js";
import {
  barLayout, seriesLayout, splitBarLayout, splitSeriesLayout, labelEvery,
  type ChartPlan, type ChartColumn, type ChartRow, type ChartSplit,
} from "../reporting/chart.js";

/**
 * THE DOCUMENTS A CUSTOMER, A VENDOR OR AN ACCOUNTANT IS HANDED AS A FILE
 *
 * An invoice, a proposal, a statement, a purchase order and a report. Each takes the shape its
 * screen already reads, built by the api from ONE function for the office and
 * the customer's link alike, so the file and the page cannot disagree about a
 * number. Nothing here reads a database or a clock it was not handed.
 *
 * What a customer's copy leaves out is left out before it gets here: these
 * inputs have no cost, no margin and no technician's notes to forget to
 * delete.
 */

export interface Company {
  name: string;
  /** `#RRGGBB`, the company's own colour, or null for ink. */
  color: string | null;
  /**
   * How to reach the company, as `branding.contactLines` writes it: the postal
   * address, then the phone and email. Printed under the name on every page.
   * Empty or absent prints nothing, never an empty label.
   */
  contact?: string[] | undefined;
  /**
   * The company's logo as a page can draw it (`readImage`), on every page
   * beside the name. Absent or null prints the name alone.
   */
  logo?: PdfImage | null | undefined;
}

const accentOf = (company: Company): Rgb | null => (company.color ? hex(company.color) : null);

/* ------------------------------------------------------------- invoice */

export interface InvoicePdfInput {
  company: Company;
  number: number;
  /**
   * The branch's code written on the invoice when it was made ("HOU"),
   * printed in front of the number wherever the number is, as the screens
   * print it. Absent or null prints the number alone.
   */
  numberPrefix?: string | null | undefined;
  status: string;
  issuedOn: string | null;
  dueOn: string | null;
  currency: string;
  customerName: string;
  /** Who pays it, when that is somebody other than the customer. */
  payerName?: string | null | undefined;
  propertyAddress: string;
  lines: Array<{ name: string; description: string | null; quantity: string; unitPrice: string; lineTotal: string }>;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  amountPaid: string;
  balance: string;
  payments: Array<{ receivedAt: string; method: string; amount: string }>;
  /** A closing sentence: where to pay, or that it is paid. */
  note?: string | null | undefined;
  generatedAt: Date;
}

const METHOD: Record<string, string> = {
  card: "Card", card_present: "Card", ach: "Bank transfer", cash: "Cash",
  check: "Cheque", financing: "Financing", credit: "Account credit", other: "Payment",
};

/** What the status means to the person holding the paper. */
function invoiceState(status: string): string | null {
  switch (status) {
    case "draft": return "Draft. Not issued yet, and nothing is owed on it.";
    case "void": return "Void. Nothing is owed on this invoice.";
    case "written_off": return "Written off. Nothing more will be collected on it.";
    case "paid": return "Paid in full. Thank you.";
    default: return null;
  }
}

export function invoicePdf(input: InvoicePdfInput, options: RenderOptions = {}): Uint8Array {
  const money = (v: string) => usd(v, input.currency);
  const flow = new Flow({
    company: input.company.name,
    contact: input.company.contact,
    accent: accentOf(input.company),
    logo: input.company.logo ?? null,
    title: `Invoice ${documentNumber(input.numberPrefix, input.number)}`,
    subtitle: [input.issuedOn ? `Issued ${longDate(input.issuedOn)}` : null, input.dueOn ? `Due ${longDate(input.dueOn)}` : null]
      .filter(Boolean).join(", ") || undefined,
  });

  flow.facts([
    ["Bill to", input.payerName && input.payerName !== input.customerName
      ? `${input.payerName}, for ${input.customerName}` : input.customerName],
    ["Work at", input.propertyAddress],
  ]);
  const state = invoiceState(input.status);
  if (state) { flow.gap(6); flow.paragraph(state, { font: "bold" }); }
  flow.gap(14);

  flow.table(
    [
      { label: "Item" },
      { label: "Qty", width: 48, align: "right" },
      { label: "Price", width: 84, align: "right" },
      { label: "Amount", width: 90, align: "right" },
    ],
    input.lines.map((line) => [
      line.description ? `${line.name}\n${line.description}` : line.name,
      quantity(line.quantity), money(line.unitPrice), money(line.lineTotal),
    ]),
  );

  const discounted = Number(input.discountTotal) !== 0;
  flow.totals([
    ["Subtotal", money(input.subtotal)],
    ...(discounted ? [["Discount", `-${money(input.discountTotal)}`] as [string, string]] : []),
    ["Tax", money(input.taxTotal)],
    ["Total", money(input.total), true],
    ["Paid", money(input.amountPaid)],
    ["Balance due", money(input.balance), true],
  ]);

  if (input.payments.length > 0) {
    flow.gap(12);
    flow.heading("Payments", 11);
    flow.table(
      [{ label: "Received", width: 160 }, { label: "How" }, { label: "Amount", width: 90, align: "right" }],
      input.payments.map((p) => [longDate(p.receivedAt), METHOD[p.method] ?? "Payment", money(p.amount)]),
    );
  }

  if (input.note) { flow.gap(14); flow.paragraph(input.note, { color: MUTED }); }

  return flow.finish({
    title: `${input.company.name} invoice ${documentNumber(input.numberPrefix, input.number)}`,
    createdAt: input.generatedAt,
    footer: `${input.company.name}, invoice ${documentNumber(input.numberPrefix, input.number)}`,
  }, options);
}

/* ---------------------------------------------------------- work order */

/**
 * A JOB AS A WORK ORDER, for the technician to carry and the customer to sign.
 *
 * What the job is, where, for whom and when; who was sent on each visit;
 * what to do (the job's own words and each visit's checklist, with what is
 * already done marked); what was used; and lines for the customer to sign.
 *
 * Prices are printed only when the input carries them. The technician's copy
 * is built without them by the api, so this function never has a price to
 * leave out by mistake, and it has no cost column to forget at all.
 */
export interface WorkOrderPdfInput {
  company: Company;
  number: number;
  /** The branch's code written on the job when it was made ("HOU"), printed in front of the number. */
  numberPrefix?: string | null | undefined;
  status: string;
  /** The job's branch, by name with its code, when it is in one. */
  branch?: { name: string; code: string | null } | null | undefined;
  jobType?: string | null | undefined;
  summary: string;
  description: string | null;
  customerComplaint?: string | null | undefined;
  customerName: string;
  customerPhone?: string | null | undefined;
  propertyAddress: string;
  accessNotes?: string | null | undefined;
  hazardNotes?: string | null | undefined;
  visits: Array<{
    /** The window in the company's own clock and zone, in words: "Tue, Oct 6, 9:00 AM to 11:00 AM CDT". */
    when: string;
    status: string;
    technicians: string[];
    /** When work started and finished, in words, once they did. */
    arrived?: string | null | undefined;
    completed?: string | null | undefined;
    checklist: Array<{ label: string; required: boolean; done: boolean }>;
    /**
     * What was taken on the phone at this visit, already read and already chosen for this copy and
     * this reader. An image is null for one this file cannot print (a HEIC, a sixteen bit PNG),
     * which is said in a line rather than dropped.
     */
    photos?: WorkOrderPicture[] | undefined;
    /** The customer's signature drawn on the phone, when one was taken. */
    signature?: WorkOrderPicture | null | undefined;
  }>;
  /** Photographs on the job itself rather than on one of its visits. */
  jobPhotos?: WorkOrderPicture[] | undefined;
  /**
   * Said once, under the visits, when photographs were left off in whole or in part: the reader's
   * role does not show them, the copy shows only what the customer may see, or a limit was reached.
   */
  photoNote?: string | null | undefined;
  /** What was used on the job. A price is null on the technician's copy. */
  parts: Array<{
    name: string; description: string | null; kind: string; quantity: string;
    unitPrice: string | null; lineTotal: string | null;
    /** Why it is not charged (warranty, rework), when it is not. */
    noCharge: string | null;
  }>;
  /** False for the technician's copy, which prints no money at all. */
  prices: boolean;
  currency: string;
  /** "Printed for the technician" or "Office copy", under the title. */
  copy: string;
  generatedAt: Date;
}

/** A photograph or signature on the work order: the picture, and the words under it. */
export interface WorkOrderPicture {
  /** Null for one this file cannot print. */
  image: PdfImage | null;
  /** "Before, Oct 6, 9:14 AM CDT": what it is and when, in the company's own clock. */
  caption: string;
}

/** The tallest a photograph is printed, in points: about three inches, so a page holds two and they are legible on paper. */
export const WORK_ORDER_PHOTO_HEIGHT = 216;
/** The tallest a signature is printed, in points. */
export const WORK_ORDER_SIGNATURE_HEIGHT = 64;

const JOB_STATE: Record<string, string> = {
  lead: "Lead", estimating: "Being priced", scheduled: "Scheduled", in_progress: "Under way",
  on_hold: "On hold", completed: "Completed", invoiced: "Invoiced", paid: "Paid", cancelled: "Cancelled",
};
const VISIT_STATE: Record<string, string> = {
  unassigned: "Nobody assigned", scheduled: "Scheduled", dispatched: "Sent out", en_route: "On the way",
  working: "Working", completed: "Completed", cancelled: "Cancelled", no_show: "Customer not there",
  completed_after_cancellation: "Done after it was cancelled",
};
const PART_KIND: Record<string, string> = {
  part: "Part", labor: "Labour", equipment: "Equipment", subcontractor: "Subcontractor",
  disposal: "Disposal", permit: "Permit", other: "Other",
};
const worded = (map: Record<string, string>, value: string) =>
  map[value] ?? value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** One picture with its words under it, or the line that says it cannot be printed. */
function printPicture(flow: Flow, picture: WorkOrderPicture, maxHeight: number): void {
  if (picture.image) {
    flow.image(picture.image, { maxHeight, caption: picture.caption });
  } else {
    flow.paragraph(`${picture.caption}: this picture is on the job's page and is not a kind this file can print.`, { size: 9, color: MUTED });
  }
}

export function workOrderPdf(input: WorkOrderPdfInput, options: RenderOptions = {}): Uint8Array {
  const number = documentNumber(input.numberPrefix, input.number);
  const money = (v: string | null) => (v === null ? "" : usd(v, input.currency));
  const flow = new Flow({
    company: input.company.name,
    contact: input.company.contact,
    accent: accentOf(input.company),
    logo: input.company.logo ?? null,
    title: `Work order ${number}`,
    subtitle: input.copy,
  });

  flow.paragraph(input.summary, { font: "bold", size: 13 });
  flow.gap(4);
  flow.facts([
    ["Status", worded(JOB_STATE, input.status)],
    ["Branch", input.branch ? (input.branch.code ? `${input.branch.name} (${input.branch.code})` : input.branch.name) : null],
    ["Kind of job", input.jobType],
    ["Customer", input.customerName],
    ["Phone", input.customerPhone],
    ["Work at", input.propertyAddress],
    ["Getting in", input.accessNotes],
    ["Take care", input.hazardNotes],
  ]);

  const words = [input.customerComplaint ? `The customer says: ${input.customerComplaint}` : null, input.description]
    .filter((w): w is string => Boolean(w && w.trim()));
  if (words.length > 0) {
    flow.gap(12);
    flow.heading("The work", 11);
    for (const said of words) { flow.paragraph(said); flow.gap(4); }
  }

  flow.gap(12);
  flow.heading("Visits", 11);
  if (input.visits.length === 0) {
    flow.paragraph("No visit is booked yet.", { color: MUTED });
  }
  input.visits.forEach((visit, i) => {
    flow.gap(6);
    flow.paragraph(`Visit ${i + 1}: ${visit.when}`, { font: "bold" });
    flow.facts([
      ["Status", worded(VISIT_STATE, visit.status)],
      ["Who", visit.technicians.length > 0 ? visit.technicians.join(", ") : "Nobody assigned yet"],
      ["Started", visit.arrived],
      ["Finished", visit.completed],
    ]);
    if (visit.checklist.length > 0) {
      flow.gap(6);
      flow.table(
        [{ label: "Done", width: 48 }, { label: "Checklist" }],
        visit.checklist.map((item) => [item.done ? "Done" : "", `${item.label}${item.required ? " (must be done)" : ""}`]),
      );
    }
    if (visit.signature) {
      flow.gap(6);
      flow.ensure(WORK_ORDER_SIGNATURE_HEIGHT + 34);
      flow.paragraph("Signed on the phone", { font: "bold", size: 9 });
      printPicture(flow, visit.signature, WORK_ORDER_SIGNATURE_HEIGHT);
    }
    if (visit.photos && visit.photos.length > 0) {
      flow.gap(6);
      flow.paragraph(`Photographs from visit ${i + 1}`, { font: "bold", size: 9 });
      for (const photo of visit.photos) printPicture(flow, photo, WORK_ORDER_PHOTO_HEIGHT);
    }
  });
  if (input.jobPhotos && input.jobPhotos.length > 0) {
    flow.gap(10);
    flow.paragraph("Photographs on the job", { font: "bold", size: 9 });
    for (const photo of input.jobPhotos) printPicture(flow, photo, WORK_ORDER_PHOTO_HEIGHT);
  }
  if (input.photoNote) {
    flow.gap(6);
    flow.paragraph(input.photoNote, { size: 9, color: MUTED });
  }

  flow.gap(12);
  flow.heading(input.prices ? "Parts and labour" : "Parts and labour used", 11);
  if (input.parts.length === 0) {
    flow.paragraph("Nothing recorded yet. Write down what you use:", { color: MUTED });
    flow.table([{ label: "What", width: 300 }, { label: "How many" }], [["", ""], ["", ""], ["", ""]]);
  } else {
    const described = (part: WorkOrderPdfInput["parts"][number]) =>
      [part.name, part.description, part.noCharge ? `No charge: ${part.noCharge}` : null].filter(Boolean).join("\n");
    if (input.prices) {
      flow.table(
        [
          { label: "What" }, { label: "Kind", width: 80 },
          { label: "Qty", width: 44, align: "right" },
          { label: "Price", width: 76, align: "right" }, { label: "Amount", width: 84, align: "right" },
        ],
        input.parts.map((part) => [
          described(part), worded(PART_KIND, part.kind), quantity(part.quantity), money(part.unitPrice), money(part.lineTotal),
        ]),
      );
    } else {
      flow.table(
        [{ label: "What" }, { label: "Kind", width: 90 }, { label: "Qty", width: 50, align: "right" }],
        input.parts.map((part) => [described(part), worded(PART_KIND, part.kind), quantity(part.quantity)]),
      );
    }
  }

  /**
   * The signature lines, kept together on one page: a customer signing at
   * the top of a page with what they are agreeing to on the one before is
   * signing a blank sheet.
   */
  flow.gap(18);
  flow.ensure(120);
  flow.heading("Customer sign off", 11);
  flow.paragraph("I agree the work above was done to my satisfaction.", { size: 9, color: MUTED });
  const lineWidth = (flow.width - 24) / 2;
  for (const pair of [["Signature", "Date"], ["Name in capitals", "Technician"]] as const) {
    flow.gap(34);
    pair.forEach((label, i) => {
      const x = flow.left + i * (lineWidth + 24);
      flow.page.line(x, flow.y, x + lineWidth, flow.y, { color: INK, width: 0.6 });
      flow.page.text(x, flow.y + 11, label, { size: 8, color: MUTED });
    });
    flow.gap(12);
  }

  return flow.finish({
    title: `${input.company.name} work order ${number}`,
    createdAt: input.generatedAt,
    footer: `${input.company.name}, work order ${number}, ${input.copy.toLowerCase()}`,
  }, options);
}

/* ------------------------------------------------------------ proposal */

export interface ProposalPdfInput {
  company: Company;
  number: number;
  title: string | null;
  status: string;
  issuedOn: string | null;
  expiresOn: string | null;
  decidedAt: string | null;
  signerName: string | null;
  selectedOptionId: string | null;
  customerName: string;
  propertyAddress: string;
  terms: string | null;
  options: Array<{
    id: string;
    name: string;
    description: string | null;
    tier: string | null;
    isRecommended: boolean;
    subtotal: string;
    discountTotal: string;
    taxTotal: string;
    total: string;
    optionalTotal: string;
    lines: Array<{
      name: string; description: string | null; quantity: string; unitPrice: string; lineTotal: string;
      memberDiscountAmount: string; memberPlan: string | null; isOptional: boolean; isSelected: boolean;
    }>;
    /** The option's photographs, already read; null for one this cannot print. */
    photos?: Array<PdfImage | null> | undefined;
    /**
     * The pictures of the price book items on the option's lines, each once,
     * with the line's name under it; null for one this cannot print.
     */
    linePictures?: Array<{ name: string; image: PdfImage | null }> | undefined;
  }>;
  /**
   * The company's layout, when the estimate has one: a cover and the sections
   * in their order. Absent is the fixed layout, the options then the terms.
   * A section's words are what it says; the options and the terms draw the
   * estimate's own.
   */
  layout?: {
    cover: { headline: string; intro: string | null; photo: PdfImage | null; photoUnprintable: boolean } | null;
    sections: Array<{
      kind: string;
      title: string;
      body: string | null;
      reviews?: Array<{ author: string | null; rating: number | null; body: string | null }> | undefined;
    }>;
  } | undefined;
  generatedAt: Date;
}

const UNPRINTABLE = "A photograph is shown here on the proposal's screen copy; it is not a kind this file can print.";

export function proposalPdf(input: ProposalPdfInput, options: RenderOptions = {}): Uint8Array {
  const flow = new Flow({
    company: input.company.name,
    contact: input.company.contact,
    accent: accentOf(input.company),
    logo: input.company.logo ?? null,
    title: `Proposal ${input.number}`,
    subtitle: [input.issuedOn ? `Written ${longDate(input.issuedOn)}` : null, input.expiresOn ? `Good until ${longDate(input.expiresOn)}` : null]
      .filter(Boolean).join(", ") || undefined,
  });

  /**
   * A cover is its own page: the headline, the photograph and a sentence,
   * and who it is for, before anything about money.
   */
  const cover = input.layout?.cover ?? null;
  if (cover) {
    flow.gap(30);
    flow.paragraph(cover.headline, { font: "bold", size: 20 });
    flow.gap(12);
    if (cover.photo) flow.image(cover.photo, { maxHeight: 360 });
    else if (cover.photoUnprintable) flow.paragraph(UNPRINTABLE, { size: 9, color: MUTED });
    if (cover.intro) { flow.gap(8); flow.paragraph(cover.intro, { size: 11 }); }
    flow.gap(12);
    flow.facts([["Prepared for", input.customerName], ["Work at", input.propertyAddress]]);
    flow.newPage();
  }

  if (input.title) { flow.paragraph(input.title, { font: "bold", size: 13 }); flow.gap(4); }
  if (!cover) flow.facts([["Prepared for", input.customerName], ["Work at", input.propertyAddress]]);

  if (input.signerName && input.decidedAt) {
    const chosen = input.options.find((o) => o.id === input.selectedOptionId);
    flow.gap(6);
    flow.paragraph(
      `Approved by ${input.signerName} on ${longDate(input.decidedAt)}${chosen ? `, choosing ${chosen.name}` : ""}.`,
      { font: "bold" },
    );
  }

  const drawOptions = () => {
    for (const option of input.options) {
      flow.gap(16);
      const named = [option.tier, option.name].filter(Boolean).join(": ");
      flow.heading(`${named}${option.isRecommended ? " (recommended)" : ""}`, 12);
      if (option.description) flow.paragraph(option.description, { color: MUTED });
      for (const photo of option.photos ?? []) {
        flow.gap(6);
        if (photo) flow.image(photo, { maxHeight: 200 });
        else flow.paragraph(UNPRINTABLE, { size: 9, color: MUTED });
      }
      for (const picture of option.linePictures ?? []) {
        flow.gap(6);
        if (picture.image) flow.image(picture.image, { maxHeight: 140, caption: picture.name });
        else flow.paragraph(`A picture of ${picture.name} is shown on the proposal's screen copy; it is not a kind this file can print.`, { size: 9, color: MUTED });
      }
      flow.gap(6);
      flow.table(
        [
          { label: "Item" },
          { label: "Qty", width: 48, align: "right" },
          { label: "Price", width: 84, align: "right" },
          { label: "Amount", width: 90, align: "right" },
        ],
        option.lines.map((line) => {
          const said = [line.name];
          if (line.description) said.push(line.description);
          if (Number(line.memberDiscountAmount) > 0) {
            said.push(`Includes ${usd(line.memberDiscountAmount)} off${line.memberPlan ? ` as a ${line.memberPlan} member` : " as a member"}.`);
          }
          if (line.isOptional) said.push(line.isSelected ? "Optional, included." : "Optional, not in the total.");
          return [said.join("\n"), quantity(line.quantity), usd(line.unitPrice), usd(line.lineTotal)];
        }),
      );
      const discounted = Number(option.discountTotal) !== 0;
      flow.totals([
        ["Subtotal", usd(option.subtotal)],
        ...(discounted ? [["Discount", `-${usd(option.discountTotal)}`] as [string, string]] : []),
        ["Tax", usd(option.taxTotal)],
        ["Total", usd(option.total), true],
      ]);
      if (Number(option.optionalTotal) > 0) {
        flow.paragraph(`Optional extras not in the total: ${usd(option.optionalTotal)}.`, { size: 9, color: MUTED });
      }
    }
  };

  const sections = input.layout?.sections
    ?? [{ kind: "options", title: "Your options", body: null }, { kind: "terms", title: "Terms", body: null }];
  for (const section of sections) {
    if (section.kind === "options") { drawOptions(); continue; }
    if (section.kind === "terms") {
      if (!input.terms) continue;
      flow.gap(16);
      flow.heading(section.title, 11);
      flow.paragraph(input.terms, { size: 9 });
      continue;
    }
    if (section.kind === "reviews") {
      const reviews = section.reviews ?? [];
      if (reviews.length === 0 && !section.body) continue;
      flow.gap(16);
      flow.heading(section.title, 12);
      if (section.body) flow.paragraph(section.body);
      for (const review of reviews) {
        flow.gap(6);
        const stars = review.rating ? `${review.rating} out of 5` : null;
        flow.paragraph([stars, review.author].filter(Boolean).join(", "), { font: "bold", size: 9 });
        if (review.body) flow.paragraph(review.body, { size: 9, color: MUTED });
      }
      continue;
    }
    if (!section.body) continue;
    flow.gap(16);
    flow.heading(section.title, 12);
    flow.paragraph(section.body);
  }

  return flow.finish({
    title: `${input.company.name} proposal ${input.number}`,
    createdAt: input.generatedAt,
    footer: `${input.company.name}, proposal ${input.number}`,
  }, options);
}

/* ----------------------------------------------------------- statement */

export interface StatementPdfInput {
  company: Company;
  customerName: string;
  from: string;
  to: string;
  openingBalance: string;
  closingBalance: string;
  owedOnInvoices: string;
  heldOnAccount: string;
  lines: Array<{ date: string; description: string; charge: string | null; credit: string | null; balance: string }>;
  aging: { current: string; days1To30: string; days31To60: string; days61To90: string; over90: string };
  /** Each with its branch's code when it was printed with one, as on the invoice itself. */
  openInvoices: Array<{ number: number; numberPrefix?: string | null | undefined; issuedOn: string | null; dueOn: string | null; total: string; balance: string; daysOverdue: number }>;
  generatedAt: Date;
  /** The company's calendar day it was produced on, said on the page. */
  asOf: string;
}

export function statementPdf(input: StatementPdfInput, options: RenderOptions = {}): Uint8Array {
  const flow = new Flow({
    company: input.company.name,
    contact: input.company.contact,
    accent: accentOf(input.company),
    logo: input.company.logo ?? null,
    title: "Statement",
    subtitle: `${longDate(input.from)} to ${longDate(input.to)}`,
  });

  flow.facts([
    ["For", input.customerName],
    ["As of", longDate(input.asOf)],
  ]);
  flow.gap(6);
  flow.paragraph(
    "A copy of your account on the day it was made. Payments made since then are not on it.",
    { size: 9, color: MUTED },
  );
  flow.gap(12);

  flow.table(
    [
      { label: "Date", width: 110 },
      { label: "What" },
      { label: "Charges", width: 80, align: "right" },
      { label: "Credits", width: 80, align: "right" },
      { label: "Balance", width: 84, align: "right" },
    ],
    [
      [longDate(input.from), "Balance brought forward", "", "", usd(input.openingBalance)],
      ...input.lines.map((line) => [
        longDate(line.date), line.description, line.charge ? usd(line.charge) : "", line.credit ? usd(line.credit) : "", usd(line.balance),
      ]),
    ],
    { boldRows: new Set([0]) },
  );
  flow.totals([["Balance at the end", usd(input.closingBalance), true]]);

  flow.gap(16);
  flow.heading("What is owed today", 11);
  flow.table(
    [
      { label: "Not yet due", align: "right" }, { label: "1 to 30 days", align: "right" },
      { label: "31 to 60", align: "right" }, { label: "61 to 90", align: "right" }, { label: "Over 90", align: "right" },
    ],
    [[usd(input.aging.current), usd(input.aging.days1To30), usd(input.aging.days31To60), usd(input.aging.days61To90), usd(input.aging.over90)]],
  );
  flow.totals([
    ["Owed on invoices", usd(input.owedOnInvoices), true],
    ...(Number(input.heldOnAccount) > 0 ? [["Held for you", usd(input.heldOnAccount)] as [string, string]] : []),
  ]);

  if (input.openInvoices.length > 0) {
    flow.gap(16);
    flow.heading("Open invoices", 11);
    flow.table(
      [
        { label: "Invoice", width: 70 }, { label: "Issued" }, { label: "Due" },
        { label: "Total", width: 84, align: "right" }, { label: "Still owed", width: 84, align: "right" },
      ],
      input.openInvoices.map((inv) => [
        documentNumber(inv.numberPrefix, inv.number), longDate(inv.issuedOn),
        inv.dueOn ? `${longDate(inv.dueOn)}${inv.daysOverdue > 0 ? `, ${inv.daysOverdue} days late` : ""}` : "",
        usd(inv.total), usd(inv.balance),
      ]),
    );
  }

  return flow.finish({
    title: `${input.company.name} statement for ${input.customerName}`,
    createdAt: input.generatedAt,
    footer: `${input.company.name}, statement for ${input.customerName}`,
  }, options);
}

/* ------------------------------------------------------ purchase order */

/**
 * A PURCHASE ORDER AS THE VENDOR'S COUNTER READS IT.
 *
 * Their part number first, because that is what they pick by; how many in
 * THEIR units when they sell by the pack ("2 box of 25"), with our count
 * beside it; the price as they quote it; and where each line is going, with
 * the street, because "deliver to Van 4" means nothing to a driver. The same
 * fields the emailed body and the printable link carry, from the same reader.
 */
export interface PurchaseOrderPdfInput {
  company: Company;
  number: number;
  status: string;
  vendorName: string;
  vendorAccount: string | null;
  submittedAt: string | null;
  expectedAt: string | null;
  notes: string | null;
  total: string;
  lines: Array<{
    vendorPartNumber: string | null; itemCode: string; itemName: string;
    quantityOrdered: string; unitPrice: string; lineTotal: string; deliverTo: string;
    /** When the vendor sells by the pack: how many packs, of how many, called what, at what each. */
    packs?: { count: string; size: string; unit: string | null; price: string } | null | undefined;
  }>;
  generatedAt: Date;
}

export function purchaseOrderPdf(input: PurchaseOrderPdfInput, options: RenderOptions = {}): Uint8Array {
  const flow = new Flow({
    company: input.company.name,
    contact: input.company.contact,
    accent: accentOf(input.company),
    logo: input.company.logo ?? null,
    title: `Purchase order ${input.number}`,
    subtitle: [
      input.submittedAt ? `Sent ${longDate(input.submittedAt)}` : null,
      input.expectedAt ? `Wanted by ${longDate(input.expectedAt)}` : null,
    ].filter(Boolean).join(", ") || undefined,
  });

  flow.facts([
    ["To", input.vendorName],
    ...(input.vendorAccount ? [["Our account", input.vendorAccount] as [string, string]] : []),
  ]);
  if (input.status === "cancelled") { flow.gap(6); flow.paragraph("Cancelled. Do not ship anything on this order.", { font: "bold" }); }
  flow.gap(14);

  flow.table(
    [
      { label: "Part", width: 90 },
      { label: "Description" },
      { label: "Qty", width: 92, align: "right" },
      { label: "Each", width: 76, align: "right" },
      { label: "Amount", width: 80, align: "right" },
    ],
    input.lines.map((line) => {
      const packs = line.packs;
      const qty = packs
        ? `${quantity(packs.count)} ${packs.unit ?? "pack"} of ${quantity(packs.size)}\n(${quantity(line.quantityOrdered)})`
        : quantity(line.quantityOrdered);
      return [
        line.vendorPartNumber ?? line.itemCode,
        `${line.itemName}\nDeliver to ${line.deliverTo}`,
        qty,
        usd(packs ? packs.price : line.unitPrice),
        usd(line.lineTotal),
      ];
    }),
  );
  flow.totals([["Total", usd(input.total), true]]);

  if (input.notes) { flow.gap(12); flow.paragraph(input.notes); }
  flow.gap(14);
  flow.paragraph("Please confirm this order and when it will ship by replying to the email it came with.", { color: MUTED });

  return flow.finish({
    title: `${input.company.name} purchase order ${input.number}`,
    createdAt: input.generatedAt,
    footer: `${input.company.name}, purchase order ${input.number}`,
  }, options);
}

/* ------------------------------------------------- a signed staff document */

export interface SignedDocumentPdfInput {
  company: Company;
  /** The document's title, as it was when it was signed. */
  title: string;
  /** The exact words that were signed. */
  body: string;
  /** The fingerprint the signature carries: SHA-256 of the title and the words. */
  documentHash: string;
  /** The name as they signed it: typed, or the name on their record when drawn. */
  signerName: string;
  signerEmail?: string | null | undefined;
  /** When, already written in the company's own clock and zone, "March 4, 2026 at 2:15 PM CST". */
  signedAtText: string;
  signedVia: "typed" | "drawn";
  /** The drawn signature as a page can print it. Null for a typed one, or a picture a PDF cannot carry. */
  signature?: PdfImage | null | undefined;
  /** Where it came from, when the screen could say. Evidence, printed as kept. */
  ipAddress?: string | null | undefined;
  userAgent?: string | null | undefined;
  generatedAt: Date;
}

/**
 * A signed document, for the person who signed it or the office that asked.
 *
 * WHO, WHEN, HOW, AND THE WORDS, in that order, because a printed copy is read
 * as evidence: the facts the record keeps about the signing, then the words
 * exactly as they were shown, then the signature itself. Nothing is added to
 * the words and nothing is left out of them. The fingerprint is the one every
 * signature of the document carries, so a copy can be checked against the
 * record without trusting this page.
 */
export function signedDocumentPdf(input: SignedDocumentPdfInput, options: RenderOptions = {}): Uint8Array {
  const flow = new Flow({
    company: input.company.name,
    contact: input.company.contact,
    accent: accentOf(input.company),
    logo: input.company.logo ?? null,
    title: "Signed document",
    subtitle: input.signedAtText,
  });

  flow.heading(input.title, 14);
  flow.gap(4);
  flow.facts([
    ["Signed by", input.signerName],
    ["Email", input.signerEmail],
    ["Signed", input.signedAtText],
    ["How", input.signedVia === "drawn" ? "Drew their signature on the screen" : "Typed their full name"],
    ["From address", input.ipAddress],
    ["Browser", input.userAgent ? fit(input.userAgent, "regular", 10, 200) : null],
  ]);
  flow.gap(6);
  flow.paragraph(`Fingerprint of the words: ${input.documentHash}`, { size: 8, color: MUTED });
  flow.gap(14);

  flow.heading("The words they signed", 11);
  flow.paragraph(input.body);

  flow.gap(18);
  flow.heading("Signature", 11);
  if (input.signedVia === "drawn" && input.signature) {
    flow.image(input.signature, { maxHeight: 90, caption: `Drawn by ${input.signerName}` });
  } else if (input.signedVia === "drawn") {
    flow.paragraph(`${input.signerName} drew their signature. The picture is kept with the record but this page cannot print it.`, { color: MUTED });
  } else {
    flow.paragraph(input.signerName, { font: "bold", size: 14 });
  }
  flow.gap(10);
  flow.paragraph(
    `Signing says ${input.signerName} read the words above and agreed to them, on ${input.signedAtText}.`,
    { size: 9, color: MUTED },
  );

  return flow.finish({
    title: `${input.company.name}: ${input.title}, signed by ${input.signerName}`,
    createdAt: input.generatedAt,
    footer: `${input.company.name}, ${input.title}, signed by ${input.signerName}`,
  }, options);
}

/* -------------------------------------------------------------- report */

export interface ReportPdfInput {
  company: Company;
  name: string;
  question: string | null;
  /** The dates in words: "March 2026". */
  period: string;
  /** Anything else that narrows it, in words. */
  narrowedBy?: string | null | undefined;
  /** Whose run this is, said on the page because a technician's copy has fewer rows. */
  ranAs?: string | null | undefined;
  columns: Array<ChartColumn & { type: string }>;
  rows: ChartRow[];
  truncated: boolean;
  /** The chart the screen would draw, or null with the reason it would not. */
  chart: ChartPlan | null;
  chartNote?: string | null | undefined;
  generatedAt: Date;
}

const SHORT_MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** One report cell as words: the same rules the emailed summary uses. */
export function reportCell(column: { type: string; sortPrefix?: boolean | undefined }, value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "Not set";
  if (column.type === "money") return usd(value);
  if (column.type === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n) : String(value);
  }
  const text = String(value);
  if (column.type === "status") {
    return text.split("_").map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");
  }
  if (column.type === "date") {
    const month = /^(\d{4})-(\d{2})$/.exec(text);
    if (month) return `${SHORT_MONTH[Number(month[2]) - 1] ?? ""} ${month[1]}`;
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return longDate(text);
  }
  return column.sortPrefix ? text.replace(/^\d+\s+/, "") : text;
}

/**
 * The chart, drawn from the same plan the screen draws from: `chartFor` and
 * the two layouts in `reporting/chart.ts` decide every position, and this only
 * puts marks where they say. So the picture in the email is the picture on
 * the screen, and neither can disagree with the table under it.
 */
function drawChart(flow: Flow, plan: ChartPlan, accent: Rgb): void {
  const label = (value: string | number | null) => reportCell(plan.dimension, value);
  const figure = (exact: string) => reportCell(plan.measure, exact);

  if (plan.kind === "bars") {
    const layout = barLayout(plan, flow.width, 18, 150);
    flow.ensure(layout.height + 10);
    const top = flow.y;
    const page = flow.page;
    page.line(flow.left + layout.zeroX, top, flow.left + layout.zeroX, top + layout.height - 18, { color: RULE });
    for (const bar of layout.bars) {
      const y = top + bar.y;
      page.text(flow.left, y + bar.height - 2, fit(label(bar.point.key), "regular", 8, 140), { size: 8, color: INK });
      page.rect(flow.left + bar.x, y, Math.max(0.5, bar.width), bar.height, { fill: bar.point.value < 0 ? LOSS : accent });
      const end = bar.point.value < 0 ? flow.left + bar.x - 4 : flow.left + bar.x + bar.width + 4;
      page.text(end, y + bar.height - 2, figure(bar.point.exact), {
        size: 8, color: MUTED, align: bar.point.value < 0 ? "right" : "left",
      });
    }
    flow.y = top + layout.height;
    return;
  }

  const height = 190;
  flow.ensure(height + 10);
  const top = flow.y;
  const page = flow.page;
  const layout = seriesLayout(plan, flow.width, height);
  for (const grid of layout.gridlines) {
    page.line(flow.left + layout.plot.x, top + grid.y, flow.left + layout.plot.x + layout.plot.width, top + grid.y, {
      color: RULE, width: grid.value === 0 ? 0.8 : 0.3,
    });
    page.text(flow.left + layout.plot.x - 6, top + grid.y + 3, reportCell(plan.measure, String(grid.value)), {
      size: 7, color: MUTED, align: "right",
    });
  }
  if (plan.kind === "columns") {
    for (const p of layout.points) {
      page.rect(flow.left + p.column.x, top + p.column.y, p.column.width, Math.max(0.5, p.column.height), {
        fill: p.point.value < 0 ? LOSS : accent,
      });
    }
  } else {
    page.polyline(layout.points.map((p) => ({ x: flow.left + p.x, y: top + p.y })), { color: accent, width: 1.5 });
    for (const p of layout.points) {
      page.rect(flow.left + p.x - 1.5, top + p.y - 1.5, 3, 3, { fill: p.point.value < 0 ? LOSS : accent });
    }
  }
  const every = labelEvery(layout.points.length, 8);
  layout.points.forEach((p, i) => {
    if (i % every !== 0 && i !== layout.points.length - 1) return;
    page.text(flow.left + p.x, top + layout.plot.y + layout.plot.height + 14, label(p.point.key), {
      size: 7, color: MUTED, align: "center",
    });
  });
  flow.y = top + height;
}

export function reportPdf(input: ReportPdfInput, options: RenderOptions = {}): Uint8Array {
  const accent = accentOf(input.company) ?? { r: 0.15, g: 0.39, b: 0.92 };
  /**
   * No contact lines on a report. It goes to the company's own people, who
   * know the phone number, and the room is better spent on the report.
   */
  const flow = new Flow({
    company: input.company.name,
    accent: accentOf(input.company),
    logo: input.company.logo ?? null,
    title: fit(input.name, "bold", 14, 300),
    subtitle: input.period,
  });

  if (input.question) flow.paragraph(input.question, { color: MUTED });
  flow.facts([["Narrowed to", input.narrowedBy], ["As seen by", input.ranAs]]);
  flow.gap(10);

  if (input.chart) {
    flow.heading(`${input.chart.measure.label} by ${input.chart.dimension.label.toLowerCase()}`, 10);
    flow.gap(4);
    drawChart(flow, input.chart, accent);
    const notes: string[] = [];
    if (input.chart.omitted > 0) notes.push(`${input.chart.omitted} more not drawn; every row is in the table.`);
    if (input.chart.summedOver.length > 0) notes.push(`Added up over ${input.chart.summedOver.join(" and ").toLowerCase()}.`);
    if (notes.length > 0) flow.paragraph(notes.join(" "), { size: 8, color: MUTED });
    flow.gap(12);
  } else if (input.chartNote) {
    flow.paragraph(input.chartNote, { size: 9, color: MUTED });
    flow.gap(10);
  }

  if (input.rows.length === 0) {
    flow.paragraph("Nothing fell inside this report for these dates.");
  } else {
    const columns: Column[] = input.columns.map((c) => ({
      label: c.label, align: c.role === "measure" ? "right" : "left",
    }));
    flow.table(columns, input.rows.map((row) => input.columns.map((c) => reportCell(c, row[c.key]))));
    if (input.truncated) {
      flow.gap(6);
      flow.paragraph("The report stops at a thousand rows, and this one reached it.", { size: 9, color: MUTED });
    }
  }

  return flow.finish({
    title: `${input.name}, ${input.period}`,
    createdAt: input.generatedAt,
    footer: `${input.company.name}, ${input.name}, ${input.period}`,
  }, options);
}

/* ------------------------------------------------------------ dashboard */

/**
 * The colour of each value of a second grouping, by its place in the legend:
 * the screen's own six (`ReportChart`), so a printed tile and the tile on the
 * wall agree about which colour is which. The last is kept for "everything
 * else", wherever it falls.
 */
const SERIES: Rgb[] = [
  { r: 0x39 / 255, g: 0x42 / 255, b: 0x4a / 255 },
  { r: 0x0b / 255, g: 0x57 / 255, b: 0xd0 / 255 },
  { r: 0x15 / 255, g: 0x80 / 255, b: 0x3d / 255 },
  { r: 0xb4 / 255, g: 0x53 / 255, b: 0x09 / 255 },
  { r: 0x6b / 255, g: 0x3f / 255, b: 0xa0 / 255 },
  { r: 0xb9 / 255, g: 0xc2 / 255, b: 0xcb / 255 },
];
const seriesColour = (split: ChartSplit, index: number): Rgb =>
  SERIES[split.series[index]?.other ? SERIES.length - 1 : Math.min(index, SERIES.length - 2)]!;

/** What each colour is, in words beside its swatch, because a colour alone says nothing. */
function drawLegend(flow: Flow, split: ChartSplit): void {
  const label = (key: string | number | null, other: boolean) => (other ? "Everything else" : reportCell(split.dimension, key));
  let x = flow.left;
  flow.ensure(14);
  flow.y += 10;
  split.series.forEach((series, index) => {
    const text = fit(label(series.key, series.other), "regular", 8, 140);
    const width = 12 + widthOf(text, "regular", 8) + 14;
    if (x + width > flow.right) {
      x = flow.left;
      flow.ensure(14);
      flow.y += 12;
    }
    flow.page.rect(x, flow.y - 7, 8, 8, { fill: seriesColour(split, index) });
    flow.page.text(x + 12, flow.y, text, { size: 8, color: INK });
    x += width;
  });
  flow.y += 4;
}

/**
 * A chart cut by a second grouping, drawn from `splitBarLayout` and
 * `splitSeriesLayout`, the same arithmetic the screen's chart places its
 * shapes by, with the legend under it.
 */
function drawSplitChart(flow: Flow, plan: ChartPlan, split: ChartSplit): void {
  const label = (value: string | number | null) => reportCell(plan.dimension, value);
  if (plan.kind === "bars") {
    const layout = splitBarLayout(plan, flow.width, 150);
    flow.ensure(layout.height + 10);
    const top = flow.y;
    const page = flow.page;
    page.line(flow.left + layout.zeroX, top, flow.left + layout.zeroX, top + layout.height - 18, { color: RULE });
    for (const group of layout.groups) {
      page.text(flow.left, top + group.y + Math.min(group.height, 28) / 2 + 3, fit(label(group.point.key), "regular", 8, 140), { size: 8, color: INK });
      for (const box of group.parts) {
        page.rect(flow.left + box.x, top + box.y, Math.max(0.5, box.width), box.height, { fill: seriesColour(split, box.part.series) });
      }
      page.text(flow.left + group.endX + 4, top + group.y + Math.min(group.height, 28) / 2 + 3,
        reportCell(plan.measure, group.point.exact), { size: 8, color: MUTED });
    }
    flow.y = top + layout.height;
  } else {
    const height = 190;
    flow.ensure(height + 10);
    const top = flow.y;
    const page = flow.page;
    const layout = splitSeriesLayout(plan, flow.width, height);
    for (const grid of layout.gridlines) {
      page.line(flow.left + layout.plot.x, top + grid.y, flow.left + layout.plot.x + layout.plot.width, top + grid.y, {
        color: RULE, width: grid.value === 0 ? 0.8 : 0.3,
      });
      page.text(flow.left + layout.plot.x - 6, top + grid.y + 3, reportCell(plan.measure, String(grid.value)), {
        size: 7, color: MUTED, align: "right",
      });
    }
    for (const group of layout.groups) {
      for (const box of group.parts) {
        page.rect(flow.left + box.x, top + box.y, Math.max(0.5, box.width), Math.max(0.5, box.height), {
          fill: seriesColour(split, box.part.series),
        });
      }
    }
    for (const line of layout.lines) {
      page.polyline(line.points.map((p) => ({ x: flow.left + p.x, y: top + p.y })), { color: seriesColour(split, line.series), width: 1.5 });
    }
    const every = labelEvery(layout.groups.length, 8);
    layout.groups.forEach((group, i) => {
      if (i % every !== 0 && i !== layout.groups.length - 1) return;
      page.text(flow.left + group.x, top + layout.plot.y + layout.plot.height + 14, label(group.point.key), {
        size: 7, color: MUTED, align: "center",
      });
    });
    flow.y = top + height;
  }
  drawLegend(flow, split);
}

export interface DashboardPdfTile {
  title: string;
  caption?: string | null | undefined;
  /** A number tile's one value, in words ("$12,400.00", "38"). */
  figure?: string | null | undefined;
  /** A chart tile's chart, planned by `chartFor` exactly as the screen plans it. */
  chart?: ChartPlan | null | undefined;
  /**
   * The rows the tile was drawn from, printed under its chart. On the screen
   * "View as a table" does this; on paper the chart's exact values would
   * otherwise be lost, and a tile has no report table under it.
   */
  table?: { columns: Array<ChartColumn & { type: string }>; rows: ChartRow[] } | null | undefined;
  /** Why there is no chart: a broken tile, or nothing matched. */
  note?: string | null | undefined;
}

export interface DashboardPdfInput {
  company: Company;
  name: string;
  description?: string | null | undefined;
  /** When it was drawn, in words and the company's time: "October 18, 2026 at 7:00 AM". */
  asOf: string;
  /** Whose view it is: every tile is the reader's own run, with their scope. */
  ranAs?: string | null | undefined;
  tiles: DashboardPdfTile[];
  /**
   * The titles of the tiles left out because this reader may not see them.
   * Named, never drawn: a copy that leaves part of a dashboard out without
   * saying so reads as the whole dashboard to whoever it is handed to.
   */
  leftOut: string[];
  generatedAt: Date;
}

/**
 * A WHOLE DASHBOARD ON PAPER
 *
 * Every tile the reader may see, in the dashboard's own order: a number tile
 * as its number, a chart tile as the chart the screen draws (cut by its second
 * grouping when the tile is broken down) with its rows under it, and a broken
 * tile as the sentence the screen shows in its place. The tiles a reader may
 * not see are named at the end and never drawn.
 */
export function dashboardPdf(input: DashboardPdfInput, options: RenderOptions = {}): Uint8Array {
  const accent = accentOf(input.company) ?? { r: 0.15, g: 0.39, b: 0.92 };
  const flow = new Flow({
    company: input.company.name,
    accent: accentOf(input.company),
    logo: input.company.logo ?? null,
    title: fit(input.name, "bold", 14, 300),
    subtitle: `As it stood ${input.asOf}`,
  });

  if (input.description) flow.paragraph(input.description, { color: MUTED });
  flow.facts([["As seen by", input.ranAs]]);
  flow.gap(6);

  if (input.tiles.length === 0) {
    flow.paragraph("There is nothing on this dashboard you may see.");
  }

  /**
   * Number tiles side by side, up to three to a row, the way they sit across
   * the top of the screen: one large figure under four small headings reads
   * as a row of answers, and one a page reads as a document that lost its
   * charts.
   */
  let row: DashboardPdfTile[] = [];
  const flushNumbers = () => {
    if (row.length === 0) return;
    const width = flow.width / 3;
    flow.ensure(58);
    const top = flow.y;
    row.forEach((tile, i) => {
      const x = flow.left + i * width;
      flow.page.text(x, top + 10, fit(tile.title, "bold", 9, width - 10), { font: "bold", size: 9, color: INK });
      flow.page.text(x, top + 34, fit(tile.figure ?? tile.note ?? "", "bold", tile.figure ? 18 : 8, width - 10), {
        font: "bold", size: tile.figure ? 18 : 8, color: tile.figure ? INK : MUTED,
      });
      if (tile.caption) flow.page.text(x, top + 48, fit(tile.caption, "regular", 7, width - 10), { size: 7, color: MUTED });
    });
    flow.y = top + 58;
    row = [];
  };

  for (const tile of input.tiles) {
    if (tile.figure !== undefined && tile.chart === undefined) {
      row.push(tile);
      if (row.length === 3) flushNumbers();
      continue;
    }
    flushNumbers();
    flow.gap(8);
    flow.heading(tile.title, 11);
    if (tile.caption) flow.paragraph(tile.caption, { size: 8, color: MUTED });
    if (tile.chart) {
      flow.gap(4);
      if (tile.chart.split) drawSplitChart(flow, tile.chart, tile.chart.split);
      else drawChart(flow, tile.chart, accent);
      if (tile.chart.omitted > 0) {
        flow.paragraph(`${tile.chart.omitted} more not drawn; every row is in the table.`, { size: 8, color: MUTED });
      }
    } else if (tile.note) {
      flow.paragraph(tile.note, { size: 9, color: tile.figure === undefined ? MUTED : INK });
    }
    if (tile.table && tile.table.rows.length > 0) {
      flow.gap(6);
      const columns: Column[] = tile.table.columns.map((c) => ({
        label: c.label, align: c.role === "measure" ? "right" : "left",
      }));
      flow.table(columns, tile.table.rows.map((r) => tile.table!.columns.map((c) => reportCell(c, r[c.key]))), { size: 8 });
    }
  }
  flushNumbers();

  if (input.leftOut.length > 0) {
    flow.gap(14);
    flow.heading("Not on this copy", 10);
    flow.paragraph(
      `${input.leftOut.length === 1 ? "One tile is" : `${input.leftOut.length} tiles are`} on this dashboard and left out of this copy, `
      + `because ${input.ranAs ? `${input.ranAs} may` : "the person it was made for may"} not see `
      + `${input.leftOut.length === 1 ? "it" : "them"}: ${input.leftOut.join(", ")}.`,
      { size: 9, color: MUTED },
    );
  }

  return flow.finish({
    title: `${input.name}, ${input.asOf}`,
    createdAt: input.generatedAt,
    footer: `${input.company.name}, ${input.name}, ${input.asOf}`,
  }, options);
}
