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
}

export interface FieldSnapshot {
  revision: number;
  unchanged: boolean;
  visits: FieldVisit[];
  openTimeEntry: { id: string; kind: string; startedAt: string } | null;
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
