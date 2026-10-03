import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  SYSTEM_USER_ID, permissionsFor, reporting, type Actor, type Permission,
} from "@opentradesos/core";
import { ConflictError, type ServiceContext } from "./context";
import * as email from "./email";
import { memberActor } from "./session";
import { run, type ReportResult } from "./reports";
import { CATALOGUE } from "./report-catalogue";
import { BUILT_IN } from "./report-built-in";
import { publicBaseUrl } from "./setup-tokens";
import { companyOf, reportFile } from "./documents";

/**
 * A REPORT, RUN AND EMAILED
 *
 * One function does it, and both of the things that send a report call it: a
 * schedule on the clock, and the "Run and email a report" step in an
 * automation. Two senders would be two places to decide whose authority the
 * report runs under, who may receive it, and what makes it once, and the one
 * that got it wrong would be the one nobody tested that week.
 *
 * WHOSE AUTHORITY. The person who set it up, as they are on the day it runs:
 * their role, their custom role, their scope, read fresh. A report is a read,
 * and a read that ran as the company would hand everybody who can set up a
 * schedule the owner's view of the books, in their inbox, every Monday. A
 * report its owner has since lost the right to see is not sent, and the
 * delivery row says why.
 *
 * WHO MAY RECEIVE IT, AND WHAT THEY SEE. A person in the company only if they
 * could run the same report themselves, checked the same way and on the same
 * day, and what they are sent is the report run again AS THEM, with their own
 * scope. Emailing the margin by technician to a technician, or the company's
 * jobs to somebody who sees only their own, is the report builder's scope hole
 * with a mail server attached. An address outside the company (the
 * accountant) is sent the owner's run: the owner's own decision to send their
 * books to somebody, which is a thing owners do, written down on every
 * delivery.
 *
 * ONCE. The delivery row is inserted FIRST, keyed on the occurrence, in the
 * same transaction as everything that follows. A second worker reaching the
 * same occurrence waits on the unique index, finds the row when the first
 * commits, and sends nothing; a worker that dies halfway rolls the row back
 * with the emails, and the next pass starts clean.
 */

export type ReportSource = { builtIn: string } | { reportId: string };

export interface ReportRecipients {
  userIds: string[];
  addresses: string[];
}

export interface DeliveryRecipient {
  address: string;
  userId?: string;
  messageId?: string;
  refused?: string;
}

export interface DeliverReportInput {
  organizationId: string;
  /** Whose authority it runs under. */
  ownerUserId: string | null;
  source: ReportSource;
  recipients: ReportRecipients;
  period: reporting.Period;
  /** The occurrence: the period is measured back from here. */
  at: Date;
  timezone: string;
  /** What makes it once. */
  key: string;
  scheduleId?: string | undefined;
  workflowRunId?: string | undefined;
}

export interface DeliverReportResult {
  /** False when this occurrence had already been delivered. Nothing was sent. */
  delivered: boolean;
  deliveryId: string | null;
  status: "queued" | "partly_queued" | "refused" | "failed" | "already_delivered";
  error: string | null;
  recipients: DeliveryRecipient[];
}

/** The rows a summary email shows. The rest are in the attachment, and it says so. */
const SUMMARY_ROWS = 20;

/** The two things a background sender may do, and nothing else. See `email.ts`. */
const SENDER_GRANTS: Permission[] = ["message:send", "message:read"];

function senderContext(tx: Database, organizationId: string): ServiceContext {
  const actor: Actor = {
    userId: SYSTEM_USER_ID, organizationId, roles: [], grants: SENDER_GRANTS, agentId: "report-delivery",
  };
  return { actor, db: tx };
}

/** A report a schedule or a step points at, as it is now. Null when it has gone. */
export async function sourceOf(tx: Database, source: ReportSource): Promise<{
  name: string;
  question: string | null;
  definition: reporting.ReportDefinition;
  /** Where it lives in the app, without dates. */
  path: string;
} | null> {
  if ("builtIn" in source) {
    const found = BUILT_IN.find((r) => r.slug === source.builtIn);
    return found
      ? { name: found.name, question: found.question, definition: found.definition, path: `/reports/built-in/${found.slug}` }
      : null;
  }
  const [saved] = await tx.select().from(schema.report)
    .where(and(eq(schema.report.id, source.reportId), isNull(schema.report.deletedAt))).limit(1);
  return saved
    ? {
        name: saved.name,
        question: saved.description,
        definition: saved.definition as unknown as reporting.ReportDefinition,
        path: `/reports/saved/${saved.id}`,
      }
    : null;
}

/** Everybody in the company, by user, with the address a colleague can already see. */
export async function companyPeople(tx: Database): Promise<Map<string, { name: string | null; email: string }>> {
  const rows = await tx.execute<{ user_id: string; name: string | null; email: string }>(
    sql`select user_id, name, email from app.organization_people()`,
  );
  return new Map(rows.map((row) => [row.user_id, { name: row.name, email: row.email }]));
}

/**
 * Whether this person could run this report themselves, today.
 *
 * Null when they may, the reason in words when they may not. The same
 * `resolveReport` the reports screen runs, against the same permissions their
 * session would carry.
 */
export async function mayReceive(
  tx: Database, organizationId: string, userId: string, definition: reporting.ReportDefinition,
): Promise<string | null> {
  const actor = await memberActor(tx, organizationId, userId);
  if (!actor) return "is no longer an active member of the company";
  const held = permissionsFor(actor);
  if (!held.has("report:read")) return "may not read reports";
  const decision = reporting.resolveReport(definition, CATALOGUE, held);
  return decision.ok ? null : `may not see this report (${reporting.explainRefusal(decision)})`;
}

/** Plain addresses, lower cased and deduplicated, or a refusal naming the bad one. */
export function cleanAddresses(addresses: string[]): string[] {
  const out = new Set<string>();
  for (const raw of addresses) {
    const address = email.normalizeAddress(raw);
    if (address === "") continue;
    // Deliberately loose. The provider is the authority on what is
    // deliverable; this only catches a name typed into the address box.
    if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(address)) {
      throw new ConflictError(`"${raw.trim()}" is not an email address.`);
    }
    out.add(address);
  }
  return [...out];
}

export async function deliverReport(tx: Database, input: DeliverReportInput): Promise<DeliverReportResult> {
  const named = await sourceOf(tx, input.source);

  /**
   * The claim. Nothing in this transaction happens before it, so a second
   * attempt at the same occurrence has nothing to repeat.
   */
  const [claimed] = await tx.insert(schema.reportDelivery).values({
    organizationId: input.organizationId,
    scheduleId: input.scheduleId ?? null,
    workflowRunId: input.workflowRunId ?? null,
    idempotencyKey: input.key,
    reportName: named?.name ?? "A deleted report",
    builtInReport: "builtIn" in input.source ? input.source.builtIn : null,
    reportId: "reportId" in input.source ? input.source.reportId : null,
    status: "failed",
    ranAsUserId: input.ownerUserId,
  }).onConflictDoNothing().returning({ id: schema.reportDelivery.id });

  if (!claimed) {
    return { delivered: false, deliveryId: null, status: "already_delivered", error: null, recipients: [] };
  }

  const fail = async (error: string): Promise<DeliverReportResult> => {
    await tx.update(schema.reportDelivery).set({ status: "failed", error })
      .where(eq(schema.reportDelivery.id, claimed.id));
    return { delivered: true, deliveryId: claimed.id, status: "failed", error, recipients: [] };
  };

  if (!named) return fail("The report this sends has been deleted, so there was nothing to run.");

  const owner = input.ownerUserId ? await memberActor(tx, input.organizationId, input.ownerUserId) : null;
  if (!owner) {
    return fail(
      "The person who set this up is no longer an active member of the company, so it has nobody's "
      + "authority to run under. Somebody who can see the report can set it up again.",
    );
  }

  const range = reporting.periodFor(input.period, input.at, input.timezone);
  /**
   * The period replaces the report's own dates rather than narrowing them.
   * A built-in report has none, and a saved one carrying a fixed range would
   * send the same March every Monday, which is a report that looks like it is
   * arriving and says nothing new.
   */
  const { from: _from, to: _to, ...rest } = named.definition;
  const definition: reporting.ReportDefinition = {
    ...rest,
    ...(range.from ? { from: range.from } : {}),
    ...(range.to ? { to: range.to } : {}),
  };
  await tx.update(schema.reportDelivery).set({
    periodFrom: range.from ?? null, periodTo: range.to ?? null,
  }).where(eq(schema.reportDelivery.id, claimed.id));

  let result: ReportResult;
  try {
    result = await run({ actor: owner, db: tx }, definition);
  } catch (error) {
    if (error instanceof ConflictError) {
      return fail(`It did not run as the person who set it up: ${error.message}`);
    }
    throw error;
  }

  /**
   * Who it goes to, decided now. A person who has left, or whose role no
   * longer covers this report, is written down as refused rather than quietly
   * dropped, so the list on the screen explains the inbox that stayed empty.
   */
  const people = await companyPeople(tx);
  const recipients: DeliveryRecipient[] = [];
  /**
   * What each person in the company is sent is the report AS THEY WOULD SEE
   * IT, run again under their own role and scope. Being allowed to run a
   * report is not the same as being allowed to see the owner's run of it: a
   * technician who may run "jobs by customer" sees their own jobs on their
   * screen, and the owner's company wide version in their inbox would be the
   * scope hole the report builder exists to close. An outside address gets
   * the run of the person who set it up, which is what they chose to send.
   */
  const runs = new Map<string, ReportResult>();
  const seen = new Set<string>();
  for (const userId of [...new Set(input.recipients.userIds)]) {
    const person = people.get(userId);
    if (!person) {
      recipients.push({ address: "", userId, refused: "is no longer in the company" });
      continue;
    }
    const address = email.normalizeAddress(person.email);
    const refusal = await mayReceive(tx, input.organizationId, userId, definition);
    if (refusal) {
      recipients.push({ address, userId, refused: `${person.name ?? address} ${refusal}` });
      continue;
    }
    if (seen.has(address)) continue;
    seen.add(address);
    const actor = userId === input.ownerUserId ? owner : await memberActor(tx, input.organizationId, userId);
    try {
      runs.set(userId, userId === input.ownerUserId ? result : await run({ actor: actor!, db: tx }, definition));
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      recipients.push({ address, userId, refused: `${person.name ?? address} may not see this report (${error.message})` });
      continue;
    }
    recipients.push({ address, userId });
  }
  for (const address of input.recipients.addresses.map(email.normalizeAddress)) {
    if (address === "" || seen.has(address)) continue;
    seen.add(address);
    recipients.push({ address });
  }

  const filename = `${slugify(named.name)}${range.from ? `-${range.from}` : ""}.csv`;
  /**
   * THE SAME RUN AS A PDF, WITH ITS CHART, beside the CSV. The CSV is for the
   * accountant's spreadsheet and the PDF is for everybody else, who wanted
   * the picture the screen draws and would never open a CSV. Both are made
   * from the run each recipient is sent, so a technician's PDF is their own
   * jobs exactly as their CSV is.
   */
  const pdfName = filename.replace(/\.csv$/, ".pdf");
  const company = await companyOf(tx, input.organizationId);
  const dataset = CATALOGUE.find((d) => d.key === definition.dataset);
  const kinds = new Map((dataset?.measures ?? []).map((measure) => [measure.key, measure.kind]));
  const additive = (key: string) => kinds.get(key) === "count" || kinds.get(key) === "sum";
  /** A person by name, or by their address when they have not set one. */
  const nameOf = (userId: string | null | undefined) => {
    const person = userId ? people.get(userId) : undefined;
    return person ? person.name ?? person.email : null;
  };
  const base = publicBaseUrl();
  const query = new URLSearchParams();
  if (definition.from) query.set("from", definition.from);
  if (definition.to) query.set("to", definition.to);
  const dates = query.toString();
  const link = base ? `${base}${named.path}${dates ? `?${dates}` : ""}` : null;

  const sender = senderContext(tx, input.organizationId);
  for (const recipient of recipients) {
    if (recipient.refused) continue;
    const theirs = (recipient.userId ? runs.get(recipient.userId) : undefined) ?? result;
    const composed = composeReportEmail({
      name: named.name,
      question: named.question,
      period: range.label,
      result: theirs,
      // A link only for somebody who can sign in to follow it. An accountant
      // handed a sign in page they have no account for is a support call.
      link: recipient.userId ? link : null,
      filename,
      pdfName,
    });
    const csv = reporting.toCsv(theirs.columns, theirs.rows);
    const printed = reportFile({
      company,
      name: named.name,
      question: named.question,
      period: range.label,
      ranAs: nameOf(recipient.userId ?? input.ownerUserId),
      result: theirs,
      additive,
      filename: pdfName,
    });
    const outcome = await email.queue(sender, {
      to: recipient.address,
      subject: composed.subject,
      text: composed.text,
      html: composed.html,
      purpose: "transactional",
      attachments: [
        { filename, contentType: "text/csv; charset=utf-8", content: Buffer.from(csv, "utf8") },
        { filename: pdfName, contentType: "application/pdf", content: Buffer.from(printed.bytes) },
      ],
    });
    if (outcome.queued) recipient.messageId = outcome.messageId;
    else recipient.refused = outcome.explanation;
  }

  const sent = recipients.filter((r) => r.messageId).length;
  const status = recipients.length === 0
    ? "refused"
    : sent === recipients.length ? "queued" : sent === 0 ? "refused" : "partly_queued";
  const error = recipients.length === 0 ? "There is nobody to send it to." : null;

  await tx.update(schema.reportDelivery).set({
    status,
    rowCount: result.rows.length,
    recipients,
    error,
  }).where(eq(schema.reportDelivery.id, claimed.id));

  return { delivered: true, deliveryId: claimed.id, status, error, recipients };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "report";
}

/* ---------------------------------------------------------------- the email */

const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** One cell, as a person reads it in an email. */
function shown(column: ReportResult["columns"][number], value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "Not set";
  if (column.type === "money") return MONEY.format(Number(value));
  if (column.type === "number") return NUMBER.format(Number(value));
  const text = String(value);
  if (column.type === "status") {
    return text.split("_").map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");
  }
  if (column.type === "date" && /^\d{4}-\d{2}$/.test(text)) {
    return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
      .format(new Date(`${text}-01T12:00:00Z`));
  }
  return column.sortPrefix ? text.replace(/^\d+\s+/, "") : text;
}

const escapeHtml = (value: string) => value
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * WHAT THE EMAIL SAYS
 *
 * A readable summary in the body and every row in the CSV. The body is for
 * reading on a phone at a red light: the question, the period, the first rows
 * as a table. The attachment is for the accountant, who wants the whole thing
 * in a spreadsheet and will not read a table in an email at all.
 *
 * Plain text first and HTML beside it, because the outbox refuses HTML alone
 * and a plain text reader is somebody too.
 */
export function composeReportEmail(input: {
  name: string;
  question: string | null;
  period: string;
  result: ReportResult;
  link: string | null;
  filename: string;
  /** The PDF beside the CSV, with the chart, when one is attached. */
  pdfName?: string | undefined;
}): { subject: string; text: string; html: string } {
  const { result } = input;
  const shownRows = result.rows.slice(0, SUMMARY_ROWS);
  const more = result.rows.length - shownRows.length;
  const subject = `${input.name}: ${input.period}`;

  const empty = result.rows.length === 0;
  const files = input.pdfName ? `${input.filename}, and with its chart in ${input.pdfName}` : input.filename;
  const tail = empty
    ? "Nothing fell inside this report for these dates."
    : more > 0
      ? `The first ${shownRows.length} of ${result.rows.length} rows. Every row is in the attached file, ${files}.`
      : `Every row is also in the attached file, ${files}.`;

  const text = [
    input.name,
    input.question ?? "",
    `Dates: ${input.period}.`,
    "",
    ...(empty ? [] : shownRows.map((row) =>
      result.columns.map((c) => `${c.label}: ${shown(c, row[c.key])}`).join(", "))),
    "",
    tail,
    ...(result.truncated ? ["The report stops at a thousand rows, and this one reached it."] : []),
    ...(input.link ? ["", `Open it, and the records behind each number: ${input.link}`] : []),
  ].filter((line, i, all) => !(line === "" && all[i - 1] === "")).join("\n").trim();

  const cell = "padding:4px 8px;border-bottom:1px solid #e5e7eb;font-size:14px";
  const html = [
    `<div style="font-family:system-ui,sans-serif;color:#111827;max-width:680px">`,
    `<h1 style="font-size:18px;margin:0 0 4px">${escapeHtml(input.name)}</h1>`,
    input.question ? `<p style="margin:0 0 4px;color:#374151">${escapeHtml(input.question)}</p>` : "",
    `<p style="margin:0 0 16px;color:#4b5563">Dates: ${escapeHtml(input.period)}.</p>`,
    empty ? "" : [
      `<table style="border-collapse:collapse;width:100%">`,
      `<tr>${result.columns.map((c) =>
        `<th style="${cell};text-align:${c.role === "measure" ? "right" : "left"}">${escapeHtml(c.label)}</th>`).join("")}</tr>`,
      ...shownRows.map((row) => `<tr>${result.columns.map((c) =>
        `<td style="${cell};text-align:${c.role === "measure" ? "right" : "left"}">${escapeHtml(shown(c, row[c.key]))}</td>`).join("")}</tr>`),
      `</table>`,
    ].join(""),
    `<p style="margin:16px 0 0;font-size:14px;color:#4b5563">${escapeHtml(tail)}</p>`,
    input.link
      ? `<p style="margin:12px 0 0;font-size:14px"><a href="${escapeHtml(input.link)}">Open it, and the records behind each number</a></p>`
      : "",
    `</div>`,
  ].join("");

  return { subject, text, html };
}

/* ------------------------------------------------------- the automation step */

/**
 * The step's settings, read from a workflow definition.
 *
 * `report` is `builtIn:{slug}` or `saved:{id}`, the same pair a dashboard tile
 * points at, so the canvas offers one list of reports for both.
 */
export function readReportStep(config: Record<string, unknown>): {
  source: ReportSource | null;
  userIds: string[];
  addresses: string[];
  period: reporting.Period;
} {
  const report = typeof config["report"] === "string" ? config["report"] : "";
  const source: ReportSource | null = report.startsWith("builtIn:")
    ? { builtIn: report.slice("builtIn:".length) }
    : report.startsWith("saved:") ? { reportId: report.slice("saved:".length) } : null;
  const list = (value: unknown) => (Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [])
    .map((v) => String(v).trim()).filter((v) => v !== "");
  const period = typeof config["period"] === "string" && reporting.isPeriod(config["period"])
    ? config["period"] : "all";
  return { source, userIds: list(config["userIds"]), addresses: list(config["addresses"]), period };
}

/**
 * Whether an "email a report" step can be published by this author, in words.
 *
 * The same checks a schedule gets at its save: the report exists, the author
 * can run it, there is somebody to send it to, and every person picked could
 * open it themselves. Refused at publish because that is the moment somebody
 * is looking; at run time the same checks run again against the publisher as
 * they are that day.
 */
export async function checkReportStep(
  tx: Database, ctx: ServiceContext, config: Record<string, unknown>,
): Promise<string | null> {
  const step = readReportStep(config);
  if (!step.source) return "Pick the report this step emails.";
  const named = await sourceOf(tx, step.source);
  if (!named) return "The report this step emails does not exist.";
  const decision = reporting.resolveReport(named.definition, CATALOGUE, permissionsFor(ctx.actor));
  if (!decision.ok) return `You cannot email a report you cannot run yourself. ${reporting.explainRefusal(decision)}`;
  let addresses: string[];
  try {
    addresses = cleanAddresses(step.addresses);
  } catch (error) {
    return (error as Error).message;
  }
  if (step.userIds.length === 0 && addresses.length === 0) return "Pick somebody to email the report to.";
  const people = await companyPeople(tx);
  for (const userId of step.userIds) {
    const person = people.get(userId);
    if (!person) return "One of the people picked is not in this company.";
    const refusal = await mayReceive(tx, ctx.actor.organizationId, userId, named.definition);
    if (refusal) return `${person.name ?? person.email} ${refusal}, so it cannot be sent to them.`;
  }
  return null;
}
