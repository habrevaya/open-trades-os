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
}

export interface FieldSnapshot {
  revision: number;
  unchanged: boolean;
  visits: FieldVisit[];
  /** What the technician can pick from when recording a part. */
  priceBook: PriceBookEntry[];
  openTimeEntry: { id: string; kind: string; startedAt: string } | null;
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
