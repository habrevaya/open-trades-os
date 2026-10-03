import type { QueuedOperation } from "./queue";
import type { UploadRecord } from "./uploads";
import type { FieldSnapshot, FieldVisit, ReportField } from "./wire";

/**
 * THE DAY AS THE TECHNICIAN SHOULD SEE IT
 *
 * What the server last said, with everything the phone has done since laid
 * over the top. Computed from the queue rather than kept in screen state, so
 * that killing the app between "On my way" and the next bar of signal does
 * not put the visit back to "Scheduled" when it opens again. The web page
 * keeps its overlay in memory and loses it on a reload; a phone cannot
 * afford to.
 *
 * Pure, and in this package rather than in the app, so it is tested without
 * a phone and could serve the web page too.
 */

/**
 * Where a visit is, as a technician would say it.
 *
 * One more than the server's states: arriving does not move a visit out of
 * `en_route` (core's state machine has no arrived state, and starting work
 * is allowed straight from on the way), so "arrived" is `en_route` with an
 * arrival recorded.
 */
export type Stage = "upcoming" | "en_route" | "arrived" | "working" | "completed" | "closed";

export type StepKind = "visit.en_route" | "visit.arrive" | "visit.start" | "visit.complete";

export function stageOf(status: string, arrivedAt: string | null): Stage {
  switch (status) {
    case "unassigned":
    case "scheduled":
    case "dispatched":
      return "upcoming";
    case "en_route":
      return arrivedAt ? "arrived" : "en_route";
    case "working":
      return "working";
    case "completed":
      return "completed";
    default:
      // cancelled, no_show, completed_after_cancellation: nothing to do here.
      return "closed";
  }
}

export const STAGE_LABEL: Record<Stage, string> = {
  upcoming: "Scheduled",
  en_route: "On the way",
  arrived: "Arrived",
  working: "Working",
  completed: "Done",
  closed: "Closed",
};

/** The status words for a closed visit, which "Closed" alone would hide. */
export function statusLabel(status: string, stage: Stage): string {
  if (stage !== "closed") return STAGE_LABEL[stage];
  if (status === "cancelled") return "Cancelled";
  if (status === "no_show") return "No show";
  if (status === "completed_after_cancellation") return "Done after it was cancelled";
  return status.replace(/_/g, " ");
}

/**
 * The one big button on a visit.
 *
 * The same moves the web page offers, with arriving as its own step because
 * the server records it (it closes the "on the way" notice the customer is
 * looking at). Every one of them is a `fact` in core's rules, so none is ever
 * refused for the visit having moved; the conflict comes back instead.
 * Finishing asks first, because it is the one a thumb can hit by accident
 * and it texts nobody back.
 */
export function nextStep(stage: Stage): { kind: StepKind; label: string; confirm?: string } | null {
  switch (stage) {
    case "upcoming": return { kind: "visit.en_route", label: "On my way" };
    case "en_route": return { kind: "visit.arrive", label: "I have arrived" };
    case "arrived": return { kind: "visit.start", label: "Start work" };
    case "working": return {
      kind: "visit.complete",
      label: "Finish job",
      confirm: "Mark this visit as done? The office sees it as finished.",
    };
    default: return null;
  }
}

/**
 * The status a visit moves to when the server applies an operation.
 *
 * Mirrors core's `field.stateAfter`, and a test holds the two together for
 * every operation and every state. Copied rather than imported so the phone
 * bundle does not carry the whole domain package for one switch statement.
 */
export function statusAfter(kind: string, current: string | undefined): string | null {
  if (current === "cancelled") return kind === "visit.complete" ? "completed_after_cancellation" : null;
  switch (kind) {
    case "visit.en_route": return "en_route";
    case "visit.arrive": return "en_route";
    case "visit.start": return "working";
    case "visit.pause": return "working";
    case "visit.complete": return "completed";
    default: return null;
  }
}

export interface DayChecklistItem {
  id: string;
  label: string;
  required: boolean;
  doneAt: string | null;
  /** Ticked or unticked on this phone and not sent yet. */
  waiting: boolean;
}

export interface DayReportField extends ReportField {
  waiting: boolean;
}

export interface DayPart {
  /** The server's line id, or the operation's client id for one still on the phone. */
  id: string;
  name: string;
  quantity: string;
  waiting: boolean;
}

export interface DayPayment {
  clientId: string;
  method: "cash" | "check";
  amount: string;
  checkNumber: string | null;
  waiting: boolean;
}

export interface DayInspection {
  id: string;
  programName: string;
  /** Null until the server has filed it and said what it came to. */
  result: string | null;
  waiting: boolean;
}

export interface DayVisit extends Omit<FieldVisit, "checklist" | "report" | "parts" | "inspections"> {
  checklist: DayChecklistItem[];
  report: { id: string | null; submitted: boolean; submitWaiting: boolean; fields: DayReportField[] };
  parts: DayPart[];
  /** Cash and checks recorded on this phone since the day was last fetched. */
  payments: DayPayment[];
  /** Inspections filed on this visit, from the server and from this phone. */
  inspections: DayInspection[];
  stage: Stage;
  /**
   * Notes written on this phone since the day was last fetched, with whether
   * each is still waiting to send. The next fetch carries them in
   * `technicianNotes` and they leave this list.
   */
  newNotes: Array<{ text: string; waiting: boolean }>;
  photos: { waiting: number; sent: number; failed: number };
  /** A signature taken on this phone, sent or not. */
  signed: boolean;
  /** Anything about this visit still on the phone. */
  waiting: number;
}

export interface DayView {
  visits: DayVisit[];
  clock: { open: boolean; since: string | null; waiting: boolean };
}

/**
 * Lay the phone's own work over the server's last word.
 *
 * Rejected operations are left out, because the server refused them and the
 * day should not pretend they happened. Conflicted ones stay in: the server
 * applied them and the visit really did move.
 */
export function projectDay(input: {
  snapshot: FieldSnapshot | null;
  /** Still on the phone. */
  operations: QueuedOperation[];
  /** Applied by the server since the snapshot was fetched. Shown, not waiting. */
  applied?: QueuedOperation[] | undefined;
  uploads?: UploadRecord[] | undefined;
}): DayView {
  const visits = new Map<string, DayVisit>();
  for (const visit of input.snapshot?.visits ?? []) {
    visits.set(visit.id, {
      ...visit,
      checklist: visit.checklist.map((item) => ({ ...item, waiting: false })),
      /**
       * Older servers sent no report, parts or balance. Read as empty rather
       * than crashing the day on a phone that updated before its server did.
       */
      report: {
        id: visit.report?.id ?? null,
        submitted: visit.report?.submitted ?? false,
        submitWaiting: false,
        fields: (visit.report?.fields ?? []).map((f) => ({ ...f, waiting: false })),
      },
      parts: (visit.parts ?? []).map((part) => ({ ...part, waiting: false })),
      amountDue: visit.amountDue ?? null,
      payments: [],
      inspections: (visit.inspections ?? []).map((i) => ({
        id: i.id, programName: i.programName, result: i.result, waiting: false,
      })),
      stage: stageOf(visit.status, visit.arrivedAt),
      newNotes: [],
      photos: { waiting: 0, sent: 0, failed: 0 },
      signed: false,
      waiting: 0,
    });
  }

  const open = input.snapshot?.openTimeEntry ?? null;
  const clock = { open: open !== null, since: open?.startedAt ?? null, waiting: false };

  const landed = new Set((input.applied ?? []).map((op) => op.clientId));
  const ordered = [...(input.applied ?? []), ...input.operations]
    .filter((op) => op.status !== "rejected")
    .sort((a, b) => a.sequence - b.sequence);

  for (const op of ordered) {
    const waiting = !landed.has(op.clientId) && op.status !== "conflicted";
    if (op.kind === "timeclock.punch_in") {
      clock.open = true;
      clock.since = op.occurredAt;
      clock.waiting = waiting;
      continue;
    }
    if (op.kind === "timeclock.punch_out") {
      clock.open = false;
      clock.since = null;
      clock.waiting = waiting;
      continue;
    }

    const visitId = visitOf(op);
    const visit = visitId ? visits.get(visitId) : undefined;
    if (!visit) continue;
    if (waiting) visit.waiting += 1;

    const next = statusAfter(op.kind, visit.status);
    if (next) visit.status = next;
    if (op.kind === "visit.arrive" && !visit.arrivedAt) visit.arrivedAt = op.occurredAt;
    if (op.kind === "visit.note" && typeof op.payload["text"] === "string") {
      visit.newNotes.push({ text: op.payload["text"], waiting });
    }
    overlay(visit, op, waiting);
    visit.stage = stageOf(visit.status, visit.arrivedAt);
  }

  for (const upload of input.uploads ?? []) {
    const visit = visits.get(upload.visitId);
    if (!visit) continue;
    if (upload.kind === "signature") {
      if (upload.status !== "failed") visit.signed = true;
      continue;
    }
    visit.photos[upload.status === "waiting" ? "waiting" : upload.status] += 1;
  }

  return {
    visits: [...visits.values()].sort(byRoute),
    clock,
  };
}

/**
 * The visit an operation is about. A report's operations name the report and
 * carry the visit in their payload, because the report is the record they
 * change; everything else names the visit itself.
 */
export function visitOf(op: Pick<QueuedOperation, "kind" | "subjectId" | "payload">): string | undefined {
  if (op.kind === "service_report.set_field" || op.kind === "service_report.submit"
    || op.kind === "inspection.record") {
    const visitId = op.payload["visitId"];
    return typeof visitId === "string" ? visitId : undefined;
  }
  return op.subjectId;
}

/** The rest of what a technician records on a visit, laid over the server's last word. */
function overlay(visit: DayVisit, op: QueuedOperation, waiting: boolean): void {
  const p = op.payload;
  switch (op.kind) {
    case "visit.checklist_item": {
      const item = visit.checklist.find((i) => i.id === p["itemId"]);
      if (!item) return;
      item.doneAt = p["done"] === false ? null : op.occurredAt;
      item.waiting = waiting;
      return;
    }
    case "service_report.set_field": {
      if (op.subjectId && !visit.report.id) visit.report.id = op.subjectId;
      const key = typeof p["field"] === "string" ? p["field"] : null;
      if (!key) return;
      const value = p["value"];
      const text = value === null || value === undefined ? null
        : typeof value === "boolean" ? (value ? "yes" : "no")
        : String(value);
      const existing = visit.report.fields.find((f) => f.key === key);
      if (existing) {
        existing.value = text;
        existing.waiting = waiting;
        return;
      }
      visit.report.fields.push({
        key,
        label: typeof p["label"] === "string" ? p["label"] : key,
        kind: typeof p["kind"] === "string" ? p["kind"] : "text",
        unit: typeof p["unit"] === "string" ? p["unit"] : null,
        options: [], required: false, min: null, max: null,
        value: text, waiting,
      });
      return;
    }
    case "service_report.submit":
      if (op.subjectId && !visit.report.id) visit.report.id = op.subjectId;
      visit.report.submitted = true;
      visit.report.submitWaiting = waiting;
      return;
    case "visit.add_line":
      visit.parts.push({
        id: op.clientId,
        name: typeof p["name"] === "string" ? p["name"] : "Part",
        quantity: typeof p["quantity"] === "string" ? p["quantity"] : "1",
        waiting,
      });
      return;
    case "payment.collect":
      if (p["method"] !== "cash" && p["method"] !== "check") return;
      visit.payments.push({
        clientId: op.clientId,
        method: p["method"],
        amount: typeof p["amount"] === "string" ? p["amount"] : "0",
        checkNumber: typeof p["checkNumber"] === "string" ? p["checkNumber"] : null,
        waiting,
      });
      return;
    case "inspection.record": {
      if (!op.subjectId) return;
      /** The server's copy wins once it has one: it carries the verdict. */
      if (visit.inspections.some((i) => i.id === op.subjectId)) return;
      visit.inspections.push({
        id: op.subjectId,
        programName: typeof p["programName"] === "string" ? p["programName"] : "Inspection",
        result: null,
        waiting,
      });
      return;
    }
    default:
      return;
  }
}

/**
 * What a reading box holds, made into what the server stores: a number for
 * a numeric reading, true or false for a yes or no, and the words otherwise.
 * Null for something that is not a value of that kind, so a letter typed into
 * a pressure is caught on the phone rather than stored as a pressure of
 * nothing.
 */
export function readingValue(field: Pick<ReportField, "kind" | "options">, typed: string): string | number | boolean | null {
  const text = typed.trim();
  if (text === "") return null;
  switch (field.kind) {
    case "numeric":
    case "measurement": {
      const normalised = text.replace(/,/g, "");
      return /^-?\d+(\.\d+)?$/.test(normalised) ? Number(normalised) : null;
    }
    case "boolean":
      return /^(y|yes|true)$/i.test(text) ? true : /^(n|no|false)$/i.test(text) ? false : null;
    case "select":
      return field.options.includes(text) ? text : null;
    default:
      return text.slice(0, 2000);
  }
}

/** Whether a numeric reading falls outside the range the template gives, said before it is saved. */
export function outOfRange(field: Pick<ReportField, "min" | "max">, value: string | number | boolean | null): boolean {
  if (typeof value !== "number") return false;
  return (field.min !== null && value < field.min) || (field.max !== null && value > field.max);
}

/**
 * Route order first, as the web page does, then the window. A visit the
 * dispatcher has not placed goes after the ones they have.
 */
function byRoute(a: Pick<FieldVisit, "routeOrder" | "windowStart">, b: Pick<FieldVisit, "routeOrder" | "windowStart">): number {
  const order = (a.routeOrder ?? 99) - (b.routeOrder ?? 99);
  if (order !== 0) return order;
  return (a.windowStart ?? "").localeCompare(b.windowStart ?? "");
}

/**
 * The window as a technician reads it off a card at a glance, in the
 * COMPANY's timezone. A window is a promise made to a customer at an address,
 * and a phone that has not caught up after crossing a state line must not
 * quietly show a different hour than the one the customer was given.
 */
export function arrivalWindow(start: string | null, end: string | null, zone: string): string | null {
  if (!start) return null;
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone });
  const from = time(start);
  return end ? `${from} to ${time(end)}` : from;
}

/** Today's date in the company's timezone, as the snapshot route wants it. */
export function todayIn(zone: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which is the one shape the route accepts.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/** The local date a visit falls on, for splitting today from tomorrow. */
export function dateOf(iso: string | null, zone: string): string | null {
  return iso ? todayIn(zone, new Date(iso)) : null;
}

export function addressOf(visit: FieldVisit): string {
  const p = visit.property;
  return `${p.addressLine1}, ${p.city}, ${p.state} ${p.postalCode}`;
}

/**
 * Directions, in whatever the phone uses for maps.
 *
 * Apple Maps on an iPhone and the `geo:` intent on Android, which offers the
 * technician's own choice of app rather than ours. A query on the address
 * rather than coordinates, because the snapshot carries the address and an
 * address is what the customer gave.
 */
export function mapsUrl(address: string, platform: "ios" | "android" | "web"): string {
  const q = encodeURIComponent(address);
  if (platform === "ios") return `http://maps.apple.com/?daddr=${q}`;
  if (platform === "android") return `geo:0,0?q=${q}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${q}`;
}
