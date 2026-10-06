/**
 * WHAT THE SERVER SENDS, AS THE PHONE READS IT
 *
 * Written out by hand rather than imported from the API package, because a
 * phone bundle that imported the contracts would carry zod, drizzle and the
 * server's types into a JavaScript engine that cannot run half of them.
 *
 * Hand written types drift, so they are checked: the API package's test
 * `field-client-wire.test.ts` assigns each contract's output to the type
 * here, and a field the server stops sending, or starts sending as null, is
 * a type error in the server's own typecheck rather than a blank on a
 * technician's screen.
 */

export interface FieldVisit {
  id: string;
  jobId: string;
  jobNumber: number;
  sequence: number;
  status: string;
  summary: string;
  description: string | null;
  customerComplaint: string | null;
  technicianNotes: string | null;
  arrivedAt: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  routeOrder: number | null;
  estimatedDurationMinutes: number;
  customer: { id: string; name: string; phone: string | null };
  property: {
    id: string;
    addressLine1: string;
    city: string;
    state: string;
    postalCode: string;
    gateCode: string | null;
    accessNotes: string | null;
    hazardNotes: string | null;
    hasDog: boolean;
  };
  checklist: Array<{ id: string; label: string; required: boolean; doneAt: string | null }>;
  /** Owed on the job's invoices, a decimal string. Null when nothing is invoiced. */
  amountDue: string | null;
  report: {
    /** Null until a report exists; the phone makes its own id then. */
    id: string | null;
    submitted: boolean;
    fields: ReportField[];
  };
  parts: Array<{ id: string; name: string; quantity: string }>;
  /** Inspections filed against this visit. Absent from servers older than the field inspection. */
  inspections?: FiledInspection[] | undefined;
  /**
   * The plan this customer is a member on here today, which prices what the
   * phone shows the way the server will. Absent from older servers and null
   * for a customer who is not a member.
   */
  member?: MemberTerms | null | undefined;
  /**
   * The sales tax a sale on this visit is charged today, worked out by the
   * server from the company's rates. Absent from older servers, which
   * charged none on recorded work.
   */
  tax?: VisitTax | undefined;
  /** Estimates to show the customer. Absent from older servers. */
  estimates?: FieldEstimate[] | undefined;
  /** Parts and charges on the job not yet billed. Absent from older servers. */
  billable?: BillableLine[] | undefined;
  /** The job's invoices, other than void ones. Absent from older servers. */
  invoices?: FieldInvoice[] | undefined;
  /**
   * The company's own records on this visit's job or a unit on it (a permit,
   * a warranty registration), read only. Absent from older servers.
   */
  records?: FieldRecord[] | undefined;
}

export interface FieldRecord {
  id: string;
  /** What one of them is called: "Permit". */
  kind: string;
  title: string;
  fields: Array<{ label: string; value: string }>;
}

export interface VisitTax {
  /** A fraction, "0.0825". "0" when nothing is charged. */
  rate: string;
  /** As typed on the builder: "8.25". */
  percent: string;
  /** "Travis County 8.25%", or null when it is none of the company's rates. */
  label: string | null;
  source: string;
  /** Why, in a sentence. */
  note: string;
}

export interface MemberTerms {
  planName: string;
  /** The discount as a fraction, "0.15". */
  rate: string;
  waivesDiagnosticFee: boolean;
  waivesAfterHoursRate: boolean;
  /** The price book items the plan's discount leaves out. Absent from older servers. */
  excludedItemIds?: string[] | undefined;
}

export interface FieldEstimateLine {
  id: string;
  name: string;
  description: string | null;
  quantity: string;
  unitPrice: string;
  /** Every discount on the line, the member's included. */
  discountAmount: string;
  memberDiscountAmount: string;
  taxable: boolean;
  taxRate: string;
  isOptional: boolean;
  isSelected: boolean;
}

export interface FieldEstimateOption {
  id: string;
  name: string;
  description: string | null;
  isRecommended: boolean;
  total: string;
  lines: FieldEstimateLine[];
}

/** An estimate as the phone presents it: prices only, never a cost or a margin. */
export interface FieldEstimate {
  id: string;
  number: number;
  status: string;
  title: string | null;
  jobId: string | null;
  selectedOptionId: string | null;
  signerName: string | null;
  terms: string | null;
  options: FieldEstimateOption[];
}

export interface BillableLine {
  id: string;
  name: string;
  quantity: string;
  unitPrice: string;
  taxable: boolean;
  itemKind: string | null;
  feeRole: string | null;
  /** The price book item, for what the plan's discount leaves out. Absent from older servers. */
  itemId?: string | null | undefined;
}

export interface FieldInvoice {
  id: string;
  number: number;
  status: string;
  total: string;
  balance: string;
}

/** A task from the office queue: this person's, or one nobody has taken. */
export interface FieldTask {
  id: string;
  title: string;
  body: string | null;
  priority: string;
  status: string;
  mine: boolean;
  dueAt: string | null;
  overdue: boolean;
  checklistTotal: number;
  checklistDone: number;
}

/** A toolbox talk this person is on the sheet for: their own line and nothing about anybody else's. */
export interface FieldTalk {
  meetingId: string;
  topic: string;
  /** What the talk covered, which the person reads before signing. */
  notes: string | null;
  heldAt: string;
  location: string | null;
  ledBy: string | null;
  signedAt: string | null;
  /** Why it cannot be signed now, in the server's words, or null when it can. */
  cannotSign: string | null;
}

/** What this person may do on site, as the server said with the day. */
export interface FieldAbilities {
  writeEstimates: boolean;
  presentEstimates: boolean;
  raiseInvoices: boolean;
  takePayments: boolean;
  tasks: boolean;
  tipping: { enabled: boolean; presets: number[] };
  financing: boolean;
  assistant: boolean;
  /** Whether this person may record what they paid for the company. Absent from older servers, which is read as no. */
  expenses?: boolean | undefined;
}

/** One of this person's own expenses and what the office said, as the server last said. */
export interface FieldExpense {
  id: string;
  amount: string;
  spentOn: string;
  description: string;
  jobNumber: number | null;
  status: "pending" | "approved" | "refused";
  /** Why it was refused, in the office's words. */
  decisionReason: string | null;
  receipts: number;
}

export interface FiledInspection {
  id: string;
  programId: string | null;
  programName: string;
  /** The server's verdict: pass, pass_with_deficiencies, fail or partial. */
  result: string | null;
  performedOn: string | null;
}

/** A programme as the phone runs it. Only sent to somebody who may file inspections. */
export interface FieldInspectionProgram {
  id: string;
  name: string;
  standard: string | null;
  version: number;
  checkpoints: Array<{
    key: string;
    label: string;
    requiresReading: boolean;
    unit: string | null;
    min: number | null;
    max: number | null;
  }>;
}

export interface ReportField {
  key: string;
  label: string;
  /** numeric, measurement, text, boolean, select or chemical. */
  kind: string;
  unit: string | null;
  options: string[];
  required: boolean;
  min: number | null;
  max: number | null;
  /** The newest value recorded, as text. */
  value: string | null;
}

export interface PriceBookEntry {
  id: string;
  versionId: string;
  code: string | null;
  name: string;
  unitPrice: string;
  taxable: boolean;
  /** What the customer reads under the line. Absent from older servers. */
  description?: string | null | undefined;
  /** service, material, equipment, labor, fee or discount. Absent from older servers. */
  kind?: string | undefined;
  /** A fee a plan may waive. Absent from older servers. */
  feeRole?: string | null | undefined;
  /** What a kit includes, by name. Absent from older servers and empty for anything else. */
  components?: Array<{ name: string; quantity: number }> | undefined;
}

/**
 * Whether this phone may share where its person is, as the server said with
 * the day. Absent from older servers, which is read as off.
 */
export interface LocationSharing {
  companyEnabled: boolean;
  personEnabled: boolean;
  intervalSeconds: number;
  retentionDays: number;
}

export interface FieldSnapshot {
  revision: number;
  unchanged: boolean;
  visits: FieldVisit[];
  /** What the technician can pick from when recording a part. */
  priceBook: PriceBookEntry[];
  openTimeEntry: { id: string; kind: string; startedAt: string } | null;
  /** Absent from older servers, and empty for somebody who may not file inspections. */
  inspectionPrograms?: FieldInspectionProgram[] | undefined;
  /** Absent from older servers, which is read as sharing off. */
  locationSharing?: LocationSharing | undefined;
  /** The office queue. Absent from older servers. */
  tasks?: FieldTask[] | undefined;
  /** Toolbox talks on this person's sheet. Absent from older servers. */
  talks?: FieldTalk[] | undefined;
  /** What this person may do on site. Absent from older servers, which is read as nothing new. */
  abilities?: FieldAbilities | undefined;
  /** This person's own expenses from the last sixty days. Absent from older servers. */
  expenses?: FieldExpense[] | undefined;
}

export interface CodeRequestResult {
  ok: true;
  /** What to tell the person. It never says whether the address exists. */
  message: string;
}

export interface PaymentLinkResult {
  url: string;
  invoiceId: string;
  invoiceNumber: number;
  amountDue: string;
  texted: boolean;
  reason: string | null;
}

export interface FinancingLinkResult {
  url: string;
  invoiceId: string;
  invoiceNumber: number;
  amount: string;
  lender: string;
  texted: boolean;
  reason: string | null;
}

/** The field assistant's answer, and what it came from. */
export interface AssistantAnswer {
  answered: boolean;
  text: string;
  sources: Array<{ kind: string; title: string }>;
}

export interface SignInResult {
  token: string;
  expiresAt: string;
  user: { id: string; name: string | null; email: string };
  organization: { id: string; name: string; timezone: string };
}

export interface RegisterResult {
  deviceId: string;
  lastSequence: number;
}

export interface OwedUpload {
  clientId: string;
}

export interface StoreUploadResult {
  stored: boolean;
  storageKey: string | null;
  reason: string | null;
  alreadyStored: boolean;
  attempts: number;
  willRetry: boolean;
}

export interface ArrivalNoticeResult {
  sent: boolean;
  alreadySent: boolean;
  reason: string | null;
}

/**
 * The Android notification channels the app creates and the server sends to:
 * one that rings for a change to somebody's day, and one with no sound for
 * the same change inside the company's quiet hours. Named once here, and the
 * server's own list is held to it by a test in the API package, because a
 * notice sent to a channel the app never made is shown with Android's
 * defaults, which is loud.
 */
export const PUSH_CHANNELS = { normal: "visits", quiet: "visits-quiet" } as const;
