import { Flow, INK, MUTED, RULE, LOSS, longDate, usd, quantity, type Column } from "./layout.js";
import { hex, fit, type RenderOptions, type Rgb } from "./writer.js";
import type { PdfImage } from "./image.js";
import {
  barLayout, seriesLayout, labelEvery, type ChartPlan, type ChartColumn, type ChartRow,
} from "../reporting/chart.js";

/**
 * THE FOUR DOCUMENTS A CUSTOMER OR AN ACCOUNTANT IS HANDED AS A FILE
 *
 * An invoice, a proposal, a statement and a report. Each takes the shape its
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
    title: `Invoice ${input.number}`,
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
    title: `${input.company.name} invoice ${input.number}`,
    createdAt: input.generatedAt,
    footer: `${input.company.name}, invoice ${input.number}`,
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
  openInvoices: Array<{ number: number; issuedOn: string | null; dueOn: string | null; total: string; balance: string; daysOverdue: number }>;
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
        String(inv.number), longDate(inv.issuedOn),
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
