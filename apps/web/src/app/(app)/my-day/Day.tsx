"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  FieldApi, FieldQueue, IndexedDbFiles, UploadQueue, WebStorage, formatAmount, isOffline, isOwing, parseAmount,
  projectDay, recordApproval, recordCashTip, recordDecline, recordEstimate, recordExpense, recordInvoice, recordPayment, tipChoices,
  type DayVisit, type FieldAbilities, type FieldSnapshot, type KeptReceipt, type KeptSignature, type PriceBookEntry,
  type QueuedOperation, type UploadTransport, checkExpenseDraft,
} from "@opentradesos/field-client";
import type { dispatch } from "@opentradesos/api/services";
import { sync, onMyWay, paymentLink, financingLink, askAssistant } from "./actions";
import { punchNotice } from "@/lib/punch-notice";
import { preparePhoto, prepareSignature } from "@/lib/photo";
import { Ask, CashTip, InvoicePanel, SellPanel, TasksPanel, type SellHandlers } from "./Sell";
import { ExpensesPanel } from "./Expenses";
import { InspectionRun, type VisitInspection } from "./InspectionRun";
import { inspectionPayload, type FieldInspectionProgram } from "@opentradesos/field-client";

type Snapshot = Awaited<ReturnType<typeof dispatch.snapshot>>;
type Visit = Snapshot["visits"][number];

/**
 * THE DAY
 *
 * Built for a phone held in one hand, often a gloved one, often in sunlight.
 * Controls are 48px, the type does not go below 16px, and the only colours
 * that carry meaning are also distinguishable by position and label, because
 * a technician's phone screen is frequently unreadable and they are working
 * from memory of where the button is.
 *
 * Every action goes into the local queue FIRST and is sent afterwards. The
 * screen updates from the queue, not from the server, so the difference
 * between one bar and none is a spinner in a corner rather than a button that
 * does nothing.
 */
export function Day({
  date, deviceId, lastSequence, visits, openTimeEntry, technicianName, timezone, inspectionPrograms = [],
  priceBook = [], abilities, tasks = [], expenses = [], today,
}: {
  date: string;
  deviceId: string;
  lastSequence: number;
  visits: Visit[];
  openTimeEntry: Snapshot["openTimeEntry"];
  technicianName: string;
  /** The company's timezone. Every time on this screen is rendered in it. */
  timezone: string;
  /** What this person may run an inspection against. Empty for somebody who may not file one. */
  inspectionPrograms?: FieldInspectionProgram[];
  /** What an estimate is built from, prices and never a cost. */
  priceBook?: PriceBookEntry[];
  /** What this person may do on site, so the page offers only what the server would accept. */
  abilities?: FieldAbilities;
  /** The office's queue: this person's tasks and the ones nobody has taken. */
  tasks?: Snapshot["tasks"];
  /** What this person paid for the company in the last sixty days, and what the office said. */
  expenses?: Snapshot["expenses"];
  /** The company's date today, which a receipt defaults to. */
  today: string;
}) {
  const queueRef = useRef<FieldQueue | null>(null);
  /**
   * Photographs, in the same upload queue the phone app uses: the record
   * through the operation queue, the bytes from IndexedDB once the server
   * says it is waiting for them. Null where the browser keeps nothing.
   */
  const uploadsRef = useRef<UploadQueue | null>(null);
  const filesRef = useRef<IndexedDbFiles | null>(null);
  const [photos, setPhotos] = useState<Record<string, { waiting: number; sent: number; failed: number }>>({});
  /** Client ids still on this phone, so a payment recorded here can say whether it has gone. */
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  /** Cash and checks recorded on this page, until the next load shows them in what is owed. */
  const [payments, setPayments] = useState<Record<string, RecordedPayment[]>>({});
  /** Inspections filed on this page, until the next load carries the server's verdict. */
  const [inspections, setInspections] = useState<Record<string, Array<{ id: string; clientId: string; programName: string }>>>({});
  const [queued, setQueued] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** Why the punch beside the clock did not take, in the server's words. */
  const [punchProblem, setPunchProblem] = useState<string | null>(null);
  /**
   * The server answered the last send and refused it as a whole. Not set
   * when there was no answer at all, which is lost signal, not a refusal.
   */
  const refusalRef = useRef<string | null>(null);
  /** The sequence of the punch pressed on this screen, which the clock reports on. */
  const punchRef = useRef<number | null>(null);
  const [storageBroken, setStorageBroken] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  // Optimistic, keyed by visit. The server is the truth and the queue is what
  // the technician has done since it last agreed.
  const [localStatus, setLocalStatus] = useState<Record<string, string>>({});
  /**
   * What is still on this page's queue, for the sale: an estimate built, a
   * signature, an invoice raised, laid over what the server sent by the
   * field client's own `projectDay`, so the page shows what the phone app
   * would and keeps showing it with no signal.
   */
  const [pendingOps, setPendingOps] = useState<QueuedOperation[]>([]);
  /**
   * What the server has just applied, kept on the page until the day it
   * sends back has it. The queue lets go of an operation the moment it is
   * applied, and the refreshed day arrives a beat later; without this an
   * estimate the customer is looking at would vanish and come back in that
   * gap, losing their choice. Kept against the day it was laid over, so it
   * is never counted twice once the fresh day is here.
   */
  const [landed, setLanded] = useState<{ basis: Visit[]; operations: QueuedOperation[] } | null>(null);
  const visitsRef = useRef(visits);
  useEffect(() => { visitsRef.current = visits; }, [visits]);

  useEffect(() => {
    if (!WebStorage.available()) {
      /**
       * Private browsing, or site data blocked. Everything still works while
       * there is a connection, and nothing survives losing one. Saying so is
       * the whole point: a technician who believes their taps are being kept
       * will stop checking.
       */
      setStorageBroken(true);
      return;
    }

    const storage = new WebStorage("otos:");
    const queue = new FieldQueue({ storage, deviceId });
    queueRef.current = queue;
    if (IndexedDbFiles.available()) {
      filesRef.current = new IndexedDbFiles();
      uploadsRef.current = new UploadQueue({ storage, queue, files: filesRef.current });
    }
    /*
      And send whatever is still on the phone from before the page was
      opened, rather than leaving it for the half minute timer: a punch kept
      from a refused or signal-less attempt should go the moment the day is
      opened again.
    */
    void queue.adoptSequence(lastSequence).then(() => refresh(queue)).then(() => flush());
  }, [deviceId, lastSequence]);

  async function refresh(queue: FieldQueue) {
    const pending = await queue.pending();
    setPendingOps(pending);
    setQueued(pending.length);
    setPendingIds(new Set(pending.map((op) => op.clientId)));
    const uploads = uploadsRef.current;
    if (uploads) {
      const counts: Record<string, { waiting: number; sent: number; failed: number }> = {};
      for (const file of await uploads.list()) {
        if (file.kind !== "photo") continue;
        const count = counts[file.visitId] ?? { waiting: 0, sent: 0, failed: 0 };
        count[file.status] += 1;
        counts[file.visitId] = count;
      }
      setPhotos(counts);
    }
    const problems = await queue.problems();
    setProblem(problems[0]?.conflict ?? problems[0]?.lastError ?? refusalRef.current);
    setPunchProblem(punchNotice(pending, punchRef.current, refusalRef.current));
  }

  async function record(kind: Parameters<FieldQueue["enqueue"]>[0]["kind"], visitId?: string, payload?: Record<string, unknown>) {
    const queue = queueRef.current;
    if (!queue) return;

    const queued = await queue.enqueue({
      kind,
      ...(visitId ? { subjectId: visitId } : {}),
      ...(payload ? { payload } : {}),
    });

    if (kind === "timeclock.punch_in" || kind === "timeclock.punch_out") punchRef.current = queued.sequence;
    if (kind === "payment.collect" && visitId && payload) {
      const entry: RecordedPayment = {
        clientId: queued.clientId,
        method: payload["method"] === "check" ? "check" : "cash",
        amount: String(payload["amount"] ?? "0"),
      };
      setPayments((all) => ({ ...all, [visitId]: [...(all[visitId] ?? []), entry] }));
    }

    if (visitId) {
      const next =
        kind === "visit.en_route" ? "en_route"
        : kind === "visit.arrive" ? "en_route"
        : kind === "visit.start" ? "working"
        : kind === "visit.complete" ? "completed"
        : null;
      if (next) setLocalStatus((s) => ({ ...s, [visitId]: next }));
    }

    await refresh(queue);
    void flush();
  }

  /**
   * One send at a time. Work recorded while one is going out is not left for
   * the half minute timer: it goes in a second send the moment the first is
   * done, so a payment taken just after a signature is not sat waiting.
   */
  const sendingRef = useRef(false);
  const againRef = useRef(false);
  async function flush() {
    const queue = queueRef.current;
    if (!queue) return;
    if (sendingRef.current) {
      againRef.current = true;
      return;
    }
    sendingRef.current = true;
    setSyncing(true);
    try {
      const basis = visitsRef.current;
      const before = new Map((await queue.pending()).map((op) => [op.clientId, op]));
      const applied: QueuedOperation[] = [];
      await queue.flush({
        async send(input) {
          let result: Awaited<ReturnType<typeof sync>>;
          try {
            result = await sync({
              deviceId: input.deviceId,
              operations: input.operations as never,
            });
          } catch (error) {
            // No answer: no signal. The queue keeps it and nothing is refused.
            refusalRef.current = null;
            throw error;
          }
          // A server error is thrown so the queue keeps the operations. It
          // must not treat a failed request as a rejection. It IS said,
          // straight away, because the server answered and said why.
          if (!result.ok) {
            refusalRef.current = result.message;
            throw new Error(result.message);
          }
          refusalRef.current = null;
          for (const outcome of result.results as Array<{ clientId: string; status: string }>) {
            const op = before.get(outcome.clientId);
            if (op && (outcome.status === "applied" || outcome.status === "conflicted")) applied.push(op);
          }
          return { results: result.results as never, awaiting: [], snapshotRevision: 0 };
        },
      });
      if (applied.length > 0) {
        setLanded((kept) => ({
          basis,
          operations: kept && kept.basis === basis ? [...kept.operations, ...applied] : applied,
        }));
      }
      /**
       * Then the bytes of any photograph whose record has just landed, which
       * is the order the server needs them in. Over the API with this page's
       * own sign in, the same calls the phone app makes.
       */
      const uploads = uploadsRef.current;
      if (uploads) {
        await uploads.drain(uploadTransport(deviceId));
        await uploads.prune();
      }
      await refresh(queue);
    } finally {
      sendingRef.current = false;
      setSyncing(false);
    }
    if (againRef.current) {
      againRef.current = false;
      await flush();
    }
  }

  /**
   * A photograph from the camera, into the upload queue. The bytes are kept
   * on the phone before the technician is told it worked, and sent when the
   * signal allows; a problem is said under the button that was pressed.
   */
  async function takePhoto(visitId: string, file: File): Promise<string | null> {
    const kept = await keepPhoto(visitId, file);
    return "problem" in kept ? kept.problem : null;
  }

  /** The same, answering with the photo's id, which an inspection checkpoint names. */
  async function keepPhoto(visitId: string, file: File): Promise<{ uploadId: string } | { problem: string }> {
    const queue = queueRef.current;
    const uploads = uploadsRef.current;
    const files = filesRef.current;
    if (!queue || !uploads || !files) {
      return { problem: "This browser cannot keep photos while there is no signal. Use the phone app, or turn off private browsing." };
    }
    const uploadId = crypto.randomUUID();
    try {
      const photo = await preparePhoto(file);
      const localUri = await files.keep(uploadId, photo.base64);
      await uploads.add({
        uploadId, visitId, kind: "photo", contentType: photo.contentType,
        byteSize: photo.byteSize, contentHash: photo.contentHash, localUri,
      });
    } catch {
      return { problem: "The photo could not be kept on this phone. Try again, or use the phone app." };
    }
    await refresh(queue);
    void flush();
    return { uploadId };
  }

  /**
   * An inspection, filed whole into the queue. Its id is made here, so a
   * retry names the same inspection and the server files it once.
   */
  async function fileInspection(visitId: string, input: Parameters<Parameters<typeof InspectionRun>[0]["onFile"]>[0]) {
    const queue = queueRef.current;
    if (!queue) return;
    const inspectionId = crypto.randomUUID();
    const queued = await queue.enqueue({
      kind: "inspection.record",
      subjectId: inspectionId,
      payload: inspectionPayload({
        visitId, program: input.program, built: input.built,
        inspectorName: input.inspectorName, inspectorLicense: input.inspectorLicense, signedByName: input.signedByName,
      }),
    });
    setInspections((all) => ({
      ...all,
      [visitId]: [...(all[visitId] ?? []), { id: inspectionId, clientId: queued.clientId, programName: input.program.name }],
    }));
    await refresh(queue);
    void flush();
  }

  // A background attempt every half minute, and one whenever the browser says
  // the connection is back. Neither is enough alone: the online event does not
  // fire for a connection that is technically up and carrying nothing.
  useEffect(() => {
    const timer = setInterval(() => void flush(), 30_000);
    const onOnline = () => void flush();
    window.addEventListener("online", onOnline);
    return () => { clearInterval(timer); window.removeEventListener("online", onOnline); };
  });

  const ordered = useMemo(
    () => [...visits].sort((a, b) => (a.routeOrder ?? 99) - (b.routeOrder ?? 99)),
    [visits],
  );

  const projected = useMemo(() => projectDay({
    snapshot: { revision: 0, unchanged: false, visits, priceBook, openTimeEntry, tasks, expenses } as FieldSnapshot,
    operations: pendingOps,
    applied: landed && landed.basis === visits ? landed.operations : [],
  }), [visits, priceBook, openTimeEntry, tasks, expenses, pendingOps, landed]);
  const projectedVisit = (id: string) => projected.visits.find((v) => v.id === id);
  const can: FieldAbilities = abilities ?? {
    writeEstimates: false, presentEstimates: false, raiseInvoices: false, takePayments: true, tasks: false,
    tipping: { enabled: false, presets: [] }, financing: false, assistant: false, expenses: false,
  };

  /** A step of the sale into the queue, then the page redrawn from it and a send tried. */
  async function perform(step: (phone: { queue: FieldQueue; uploads: UploadQueue }) => Promise<unknown>): Promise<string | null> {
    const queue = queueRef.current;
    const uploads = uploadsRef.current;
    if (!queue || !uploads) {
      return "This browser cannot keep work while there is no signal. Use the phone app, or turn off private browsing.";
    }
    await step({ queue, uploads });
    await refresh(queue);
    void flush();
    return null;
  }

  /** A receipt photograph, kept in this browser and hashed, ready to be recorded with its expense. */
  async function keepReceipt(file: File): Promise<KeptReceipt | { problem: string }> {
    const files = filesRef.current;
    if (!files) return { problem: "This browser cannot keep a photo while there is no signal. Use the phone app, or turn off private browsing." };
    const uploadId = crypto.randomUUID();
    try {
      const photo = await preparePhoto(file);
      const localUri = await files.keep(uploadId, photo.base64);
      return { uploadId, localUri, contentType: photo.contentType, byteSize: photo.byteSize, contentHash: photo.contentHash };
    } catch {
      return { problem: "The photo could not be kept on this page. Try again, or use the phone app." };
    }
  }

  /** The customer's drawn signature, kept in this browser and hashed, ready for the queue. */
  async function keepSignature(dataUrl: string): Promise<KeptSignature | { problem: string }> {
    const files = filesRef.current;
    if (!files) return { problem: "This browser cannot keep a signature. Use the phone app, or turn off private browsing." };
    const uploadId = crypto.randomUUID();
    try {
      const prepared = await prepareSignature(dataUrl);
      const localUri = await files.keep(uploadId, prepared.base64);
      return { uploadId, localUri, byteSize: prepared.byteSize, contentHash: prepared.contentHash };
    } catch {
      return { problem: "The signature could not be kept in this browser. Ask them to sign again." };
    }
  }

  function sellHandlers(visitId: string): SellHandlers {
    return {
      saveEstimate: async (builder) => {
        const estimateId = crypto.randomUUID();
        const failed = await perform((phone) => recordEstimate(phone, { visitId, estimateId, builder }));
        return failed ? { problem: failed } : { estimateId };
      },
      approve: async ({ estimateId, option, ticked, signerName, signature }) => {
        const kept = await keepSignature(signature);
        if ("problem" in kept) return kept.problem;
        return perform((phone) => recordApproval(phone, { visitId, estimateId, option, ticked, signerName, signature: kept }));
      },
      decline: async (estimateId, reason) => {
        await perform((phone) => recordDecline(phone, { visitId, estimateId, reason }));
      },
      raiseInvoice: async (input) => {
        let signature: KeptSignature | null = null;
        if (input.signature) {
          const kept = await keepSignature(input.signature);
          if ("problem" in kept) return kept.problem;
          signature = kept;
        }
        const invoiceId = crypto.randomUUID();
        return perform((phone) => recordInvoice(phone, { ...input, visitId, invoiceId, signature }));
      },
    };
  }

  const statusOf = (v: Visit) => localStatus[v.id] ?? v.status;
  const done = ordered.filter((v) => statusOf(v) === "completed").length;

  return (
    <div className="mx-auto max-w-lg pb-24">
      <header className="sticky top-14 z-30 border-b border-steel-200 bg-canvas px-4 py-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">
            {new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
              timeZone: "UTC",
              weekday: "long", month: "short", day: "numeric",
            })}
          </h1>
          <span className="text-sm tabular-nums text-ink-500">
            {done} of {ordered.length} done
          </span>
        </div>

        <div className="mt-1 flex items-center gap-2 text-sm">
          <span className="text-ink-500">{technicianName}</span>
          {queued > 0 && (
            <span className="rounded bg-amber-tint px-2 py-0.5 text-xs font-medium text-amber-700">
              {queued} waiting to send{syncing ? "…" : ""}
            </span>
          )}
          {queued === 0 && !syncing && (
            <span className="text-xs text-ink-500">All sent</span>
          )}
        </div>
      </header>

      {storageBroken && (
        <p className="border-b border-red-600 bg-red-tint px-4 py-3 text-sm text-red-600">
          This browser is not saving anything locally, so work recorded here is lost if
          you lose signal. Turn off private browsing, or use the app.
        </p>
      )}

      {problem && (
        <p className="border-b border-amber-700 bg-amber-tint px-4 py-3 text-sm text-amber-700">
          {problem}
        </p>
      )}

      <div className="px-4 py-4">
        <TimeClock openEntry={openTimeEntry} zone={timezone} onPunch={(kind) => void record(kind)}
                   problem={punchProblem} />
      </div>

      {can.tasks && (
        <div className="px-4 pb-4">
          <TasksPanel tasks={projected.tasks} zone={timezone}
                      onClaim={(taskId) => void perform((phone) => phone.queue.enqueue({ kind: "task.claim", subjectId: taskId }))}
                      onDone={(taskId, outcome) => void perform((phone) => phone.queue.enqueue({
                        kind: "task.close", subjectId: taskId, payload: outcome.trim() ? { outcome: outcome.trim() } : {},
                      }))} />
        </div>
      )}

      {can.expenses && (
        <div className="px-4 pb-4">
          <ExpensesPanel
            expenses={projected.expenses}
            today={today}
            jobs={[...new Map(ordered.map((v) => [v.jobId, v])).values()]
              .map((v) => ({ jobId: v.jobId, jobNumber: v.jobNumber, customerName: v.customer.name }))}
            onSave={async (input) => {
              const checked = checkExpenseDraft(
                { amount: input.amount, spentOn: input.spentOn, description: input.description, jobId: input.jobId }, today,
              );
              if (!checked.ok) return checked.reason;
              let receipt: KeptReceipt | undefined;
              if (input.receipt) {
                const kept = await keepReceipt(input.receipt);
                if ("problem" in kept) return kept.problem;
                receipt = kept;
              }
              return perform((phone) => recordExpense(phone, {
                expenseId: crypto.randomUUID(), expense: checked, jobNumber: input.jobNumber, ...(receipt ? { receipt } : {}),
              }));
            }}
          />
        </div>
      )}

      {ordered.length === 0 ? (
        <p className="px-4 py-10 text-center text-ink-500">Nothing on today.</p>
      ) : (
        <ol className="space-y-3 px-4">
          {ordered.map((v, i) => (
            <li key={v.id}>
              <VisitCard
                visit={v}
                index={i + 1}
                status={statusOf(v)}
                expanded={open === v.id}
                onToggle={() => setOpen(open === v.id ? null : v.id)}
                onRecord={(kind, payload) => void record(kind, v.id, payload)}
                onPhoto={(file) => takePhoto(v.id, file)}
                inspection={(
                  <InspectionRun
                    programs={inspectionPrograms}
                    inspectorName={technicianName}
                    filed={[
                      ...(v.inspections ?? []).map((i) => ({ id: i.id, programName: i.programName, result: i.result, waiting: false })),
                      ...(inspections[v.id] ?? [])
                        .filter((i) => !(v.inspections ?? []).some((s) => s.id === i.id))
                        .map((i): VisitInspection => ({ id: i.id, programName: i.programName, result: null, waiting: pendingIds.has(i.clientId) })),
                    ]}
                    onFile={(input) => fileInspection(v.id, input)}
                    onPhoto={(file) => keepPhoto(v.id, file)}
                  />
                )}
                photos={photos[v.id] ?? { waiting: 0, sent: 0, failed: 0 }}
                payments={(payments[v.id] ?? []).map((p) => ({ ...p, waiting: pendingIds.has(p.clientId) }))}
                timezone={timezone}
                projected={projectedVisit(v.id)}
                abilities={can}
                onPay={async (payload) => {
                  let queued: QueuedOperation | null = null;
                  const failed = await perform(async (phone) => { queued = await recordPayment(phone, { visitId: v.id, ...payload }); });
                  if (failed || !queued) return failed ?? "It could not be kept on this page.";
                  const entry: RecordedPayment = {
                    clientId: (queued as QueuedOperation).clientId, method: payload.method, amount: payload.amount, tip: payload.tip,
                  };
                  setPayments((all) => ({ ...all, [v.id]: [...(all[v.id] ?? []), entry] }));
                  return null;
                }}
                sale={projectedVisit(v.id) ? (
                  <>
                    {can.assistant && (
                      <Ask onAsk={(question) => askAssistant({ question, visitId: v.id })} />
                    )}
                    <SellPanel visit={projectedVisit(v.id)!} priceBook={priceBook} abilities={can} handlers={sellHandlers(v.id)} />
                    <InvoicePanel visit={projectedVisit(v.id)!} abilities={can} handlers={sellHandlers(v.id)} />
                  </>
                ) : null}
                cashTip={projectedVisit(v.id) ? (
                  <CashTip visit={projectedVisit(v.id)!} onRecord={async (amount) => {
                    await perform((phone) => recordCashTip(phone, { visitId: v.id, amount, tipId: crypto.randomUUID() }));
                  }} />
                ) : null}
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function TimeClock({
  openEntry, onPunch, zone, problem,
}: {
  openEntry: Snapshot["openTimeEntry"];
  onPunch: (kind: "timeclock.punch_in" | "timeclock.punch_out") => void;
  zone: string;
  /** Why the last punch did not take, said under the button that made it. */
  problem: string | null;
}) {
  const since = openEntry
    ? new Date(openEntry.startedAt).toLocaleTimeString("en-US", {
        timeZone: zone,
        hour: "numeric", minute: "2-digit",
      })
    : null;

  return (
    <div className="rounded-md border border-steel-200 p-3">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <p className="text-sm font-medium">
            {openEntry ? "On the clock" : "Not clocked in"}
          </p>
          {since && <p className="text-sm text-ink-500">Since {since}</p>}
        </div>
        <button
          type="button"
          onClick={() => onPunch(openEntry ? "timeclock.punch_out" : "timeclock.punch_in")}
          className={`h-12 rounded px-5 text-base font-medium ${
            openEntry
              ? "border border-steel-300 bg-canvas text-ink-900"
              : "bg-ink-900 text-white"
          }`}
        >
          {openEntry ? "Clock out" : "Clock in"}
        </button>
      </div>
      {problem && (
        <p role="alert" className="mt-2 rounded bg-red-tint px-3 py-2 text-base text-red-600">
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * The window as a technician reads it off a card at a glance.
 *
 * Formatted in the COMPANY's timezone, which is passed in, rather than in
 * whatever the device happens to be set to.
 *
 * It is tempting to use the technician's own device zone, and it is wrong: a
 * window is a promise made to a customer at a particular address, and a phone
 * that has not caught up after a drive across a state line would quietly show
 * a different hour than the one the customer was given. The company's zone is
 * the one both of them agreed on.
 *
 * It also has to be explicit because this component renders on the server and
 * then hydrates. With no zone named, the server formats in the server's and
 * the browser reformats in the browser's, and any deployment where those
 * differ rewrites every time on the screen after the technician has read it.
 */
function arrivalWindow(start: string | null, end: string | null, zone: string): string | null {
  if (!start) return null;
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit", timeZone: zone,
    });
  const from = time(start);
  return end ? `${from} to ${time(end)}` : from;
}

const NEXT_ACTION: Record<string, { kind: "visit.en_route" | "visit.arrive" | "visit.start" | "visit.complete"; label: string } | null> = {
  unassigned: { kind: "visit.en_route", label: "On my way" },
  scheduled: { kind: "visit.en_route", label: "On my way" },
  dispatched: { kind: "visit.en_route", label: "On my way" },
  en_route: { kind: "visit.start", label: "Start work" },
  working: { kind: "visit.complete", label: "Finish" },
  completed: null,
  cancelled: null,
  no_show: null,
  completed_after_cancellation: null,
};

function VisitCard({
  visit, index, status, expanded, onToggle, onRecord, onPhoto, photos, payments, timezone, inspection,
  projected, abilities, onPay, sale, cashTip,
}: {
  visit: Visit;
  index: number;
  status: string;
  timezone: string;
  expanded: boolean;
  onToggle: () => void;
  onRecord: (
    kind: "visit.en_route" | "visit.arrive" | "visit.start" | "visit.complete" | "visit.note" | "visit.add_line"
      | "payment.collect",
    payload?: Record<string, unknown>,
  ) => void;
  onPhoto: (file: File) => Promise<string | null>;
  photos: { waiting: number; sent: number; failed: number };
  payments: Array<RecordedPayment & { waiting: boolean }>;
  /** Running an inspection on this visit, when the person may. */
  inspection?: React.ReactNode;
  /** The visit with what this page has queued laid over it: estimates, invoices, tips. */
  projected?: DayVisit | undefined;
  abilities: FieldAbilities;
  /** Cash or a check, with a tip, against the invoice it pays, into the queue. */
  onPay: (payload: { method: "cash" | "check"; amount: string; tip: string | null; checkNumber: string | null; invoiceId: string | null }) => Promise<string | null>;
  /** Selling and closing: the assistant, the estimates and the invoice. */
  sale?: React.ReactNode;
  cashTip?: React.ReactNode;
}) {
  const [note, setNote] = useState("");
  const [sendingEta, setSendingEta] = useState(false);
  /**
   * What the customer will be told, chosen rather than assumed.
   *
   * This screen used to send a flat twenty minutes on every tap. Nobody typed
   * it and nobody checked it, and it went to a customer as "about 20 minutes
   * away" in a text they then planned an hour around. A guess presented to
   * somebody else as a fact is the same defect as a row recording a message
   * that was never sent.
   */
  const [eta, setEta] = useState(20);
  const [etaResult, setEtaResult] = useState<string | null>(null);
  const next = NEXT_ACTION[status] ?? null;
  const address = `${visit.property.addressLine1}, ${visit.property.city} ${visit.property.postalCode}`;
  const window = arrivalWindow(visit.windowStart, visit.windowEnd, timezone);

  return (
    <article className={`rounded-md border ${
      status === "completed" ? "border-steel-200 bg-steel-100" : "border-steel-300 bg-canvas"
    }`}>
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-3 p-4 text-left">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink-900 text-sm font-medium tabular-nums text-white">
          {index}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{visit.customer.name}</span>
          <span className="block text-ink-700">{visit.summary}</span>
          <span className="block text-sm text-ink-500">{address}</span>
          {/*
            The window goes under the address rather than in the corner beside
            the status. "When am I due there" is the first question a
            technician asks of this list, so it has to be on the collapsed
            card. Putting it in the corner cost the summary enough width to
            wrap onto three lines at phone width, and the summary is the
            second question.
          */}
          {window && (
            <span className="mt-1 block text-sm font-medium tabular-nums text-ink-900">{window}</span>
          )}
        </span>
        <span className="shrink-0 text-right text-sm capitalize text-ink-500">
          {status.replace(/_/g, " ")}
        </span>
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-steel-200 p-4">
          {/*
            Before anything else. A technician needs the gate code and the dog
            before they get out of the truck, not after, and these ship with
            the schedule rather than being fetched at the exact moment there
            is no signal.
          */}
          {(visit.property.gateCode || visit.property.accessNotes ||
            visit.property.hazardNotes || visit.property.hasDog) && (
            <div className="rounded border border-amber-700 bg-amber-tint p-3 text-sm">
              {visit.property.hasDog && <p className="font-medium text-amber-700">There is a dog.</p>}
              {visit.property.gateCode && (
                <p className="text-amber-700">
                  Gate code <span className="font-mono font-medium">{visit.property.gateCode}</span>
                </p>
              )}
              {visit.property.accessNotes && <p className="mt-1 text-amber-700">{visit.property.accessNotes}</p>}
              {visit.property.hazardNotes && (
                <p className="mt-1 font-medium text-amber-700">{visit.property.hazardNotes}</p>
              )}
            </div>
          )}

          {visit.customerComplaint && (
            <div>
              <p className="text-xs uppercase tracking-[0.08em] text-ink-500">What they said</p>
              <p className="mt-1 text-ink-700">{visit.customerComplaint}</p>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {visit.customer.phone && (
              <a href={`tel:${visit.customer.phone}`}
                 className="flex h-12 flex-1 items-center justify-center rounded border border-steel-300 px-4 text-base font-medium">
                Call
              </a>
            )}
            <a href={`https://maps.google.com/?q=${encodeURIComponent(address)}`}
               className="flex h-12 flex-1 items-center justify-center rounded border border-steel-300 px-4 text-base font-medium">
              Directions
            </a>
          </div>

          {(status === "dispatched" || status === "scheduled") && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <label className="flex h-12 items-center gap-2 rounded border border-steel-300 px-3">
                  <span className="text-sm text-ink-500">Minutes</span>
                  <select
                    value={eta}
                    onChange={(e) => setEta(Number(e.target.value))}
                    className="bg-transparent text-base font-medium"
                  >
                    {[5, 10, 15, 20, 30, 45, 60].map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={sendingEta}
                  onClick={async () => {
                    setSendingEta(true);
                    setEtaResult(null);
                    const result = await onMyWay({ visitId: visit.id, etaMinutes: eta });
                    setEtaResult(
                      result.sent
                        ? `Texted: about ${eta} minutes away.`
                        : result.message ?? "Not sent.",
                    );
                    setSendingEta(false);
                  }}
                  className="h-12 flex-1 rounded border border-steel-300 text-base font-medium"
                >
                  {sendingEta ? "Sending…" : "Text the customer I am on my way"}
                </button>
              </div>
              {/*
                The refusal stays on the screen. A technician who is told
                nothing assumes it went, and the one thing they could have done
                about a STOP on file is pick up the phone instead.
              */}
              {etaResult && (
                <p className="text-sm text-ink-500" role="status">{etaResult}</p>
              )}
            </div>
          )}

          <div>
            <label className="block">
              <span className="text-sm font-medium">Note</span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                className="mt-1 w-full rounded border border-steel-300 p-3 text-base"
                placeholder="What you found"
              />
            </label>
            {note.trim() && (
              <button
                type="button"
                onClick={() => { onRecord("visit.note", { text: note.trim() }); setNote(""); }}
                className="mt-2 h-12 w-full rounded border border-steel-300 text-base font-medium"
              >
                Save note
              </button>
            )}
          </div>

          <Photos photos={photos} onPhoto={onPhoto} />

          {inspection}

          {sale}

          <Payment visit={visit} projected={projected} abilities={abilities} payments={payments} onPay={onPay} />

          {cashTip}

          {next && (
            <button
              type="button"
              onClick={() => onRecord(next.kind)}
              className="h-14 w-full rounded bg-ink-900 text-lg font-medium text-white"
            >
              {next.label}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

interface RecordedPayment {
  clientId: string;
  method: "cash" | "check";
  amount: string;
  /** The tip on top, for the crew. */
  tip?: string | null;
}

/**
 * THE CAMERA, ON THE PAGE
 *
 * A file input that asks the phone for its rear camera, labelled as the
 * button it looks like. On a phone it opens the camera; on a laptop it opens
 * the file picker, which is the right thing there too. What happens to the
 * picture is `takePhoto` above: kept on the phone first, then sent.
 */
function Photos({ photos, onPhoto }: {
  photos: { waiting: number; sent: number; failed: number };
  onPhoto: (file: File) => Promise<string | null>;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const parts: string[] = [];
  if (photos.sent > 0) parts.push(`${photos.sent} sent`);
  if (photos.waiting > 0) parts.push(`${photos.waiting} waiting to send`);
  if (photos.failed > 0) parts.push(`${photos.failed} could not be sent`);

  return (
    <div>
      <p className="text-xs uppercase tracking-[0.08em] text-ink-500">Photos</p>
      <p className="mt-1 text-sm text-ink-500" aria-live="polite">
        {parts.length > 0 ? `Taken here: ${parts.join(", ")}.` : "No photos taken here yet."}
      </p>
      <label className={`mt-2 flex h-12 w-full cursor-pointer items-center justify-center rounded border border-steel-300 text-base font-medium ${busy ? "opacity-60" : ""}`}>
        {busy ? "Keeping the photo" : "Take a photo"}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          aria-label="Take a photo"
          className="sr-only"
          disabled={busy}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            setBusy(true);
            setProblem(await onPhoto(file));
            setBusy(false);
          }}
        />
      </label>
      {problem && <p role="alert" className="mt-2 rounded bg-red-tint px-3 py-2 text-sm text-red-600">{problem}</p>}
    </div>
  );
}

/**
 * MONEY TAKEN ON SITE
 *
 * Cash and checks go into the queue like everything else, because the money
 * is in the technician's hand whether or not there is a signal, and they land
 * in the books dated when they were handed over, against the invoice raised
 * here first. A tip on top, when the company takes tips, is split between
 * everybody on the job the way a tip on the portal is. A card goes through
 * the invoice's own payment link (where the customer can add a tip), and
 * financing through the lender's: both need a signal and the customer stood
 * there, texted to them or shown here to open on their phone.
 */
function Payment({ visit, projected, abilities, payments, onPay }: {
  visit: Visit;
  projected: DayVisit | undefined;
  abilities: FieldAbilities;
  payments: Array<RecordedPayment & { waiting: boolean }>;
  onPay: (payload: { method: "cash" | "check"; amount: string; tip: string | null; checkNumber: string | null; invoiceId: string | null }) => Promise<string | null>;
}) {
  const due = projected?.amountDue ?? visit.amountDue;
  const owing = isOwing(due);
  const invoice = (projected?.invoices ?? []).find((i) => i.status !== "paid" && i.status !== "draft" && isOwing(i.balance)) ?? null;
  const [method, setMethod] = useState<"cash" | "check" | "card" | "finance">("cash");
  const [amount, setAmount] = useState(owing ? formatAmount(due!).replace(/[$,]/g, "") : "");
  const [tip, setTip] = useState("");
  const [checkNumber, setCheckNumber] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; said: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const name = `method-${visit.id}`;
  const tipping = abilities.tipping.enabled;

  /** The amount follows an invoice raised on this page, until somebody types their own. */
  const [typed, setTyped] = useState(false);
  const shown = typed ? amount : owing ? formatAmount(due!).replace(/[$,]/g, "") : amount;
  /** Tips suggested on what is in the box, so an invoice raised a moment ago gets them too. */
  const paying = parseAmount(shown);
  const suggested = tipping && paying ? tipChoices(paying, abilities.tipping.presets) : [];

  const recordMoney = async () => {
    const parsed = parseAmount(shown);
    if (!parsed) {
      setProblem("Enter the amount they paid, like 120 or 120.50.");
      return;
    }
    const tipAmount = tip.trim() === "" ? null : parseAmount(tip);
    if (tip.trim() !== "" && !tipAmount) {
      setProblem("Enter the tip in dollars and cents, like 15 or 12.50.");
      return;
    }
    if (method === "check" && checkNumber.trim() === "") {
      setProblem("Enter the check number, so the office can match it to the bank.");
      return;
    }
    setProblem(await onPay({
      method: method === "check" ? "check" : "cash", amount: parsed, tip: tipAmount,
      checkNumber: method === "check" ? checkNumber.trim() : null, invoiceId: invoice?.id ?? null,
    }));
    setCheckNumber("");
    setTip("");
  };

  const askForLink = async (text: boolean) => {
    setBusy(true);
    setProblem(null);
    setLink(null);
    try {
      if (method === "finance") {
        const result = await financingLink({ visitId: visit.id, text });
        if (!result.ok) setProblem(result.message);
        else setLink({
          url: result.url,
          said: text && result.texted
            ? `Texted them a link to apply with ${result.lender} for ${formatAmount(result.amount)}.`
            : result.message ?? `A link to apply with ${result.lender} for ${formatAmount(result.amount)}. Open it on their phone.`,
        });
        return;
      }
      const result = await paymentLink({ visitId: visit.id, text });
      if (!result.ok) {
        setProblem(result.message);
      } else {
        setLink({
          url: result.url,
          said: text && result.texted
            ? `Texted them a link to pay ${formatAmount(result.amountDue)} by card.`
            : result.message ?? `A link to pay ${formatAmount(result.amountDue)} by card. Open it on their phone.`,
        });
      }
    } catch {
      setProblem("No signal, so no link. Take cash or a check, or try again when you have a signal.");
    } finally {
      setBusy(false);
    }
  };

  const methods = ["cash", "check", "card", ...(abilities.financing ? ["finance"] : [])] as Array<"cash" | "check" | "card" | "finance">;
  return (
    <div className="space-y-2">
      <p className="text-xs uppercase tracking-[0.08em] text-ink-500">Payment</p>
      <p className="text-sm text-ink-700">
        {due === null
          ? "Nothing invoiced for this job yet. Cash or a check is held for the customer until the office applies it."
          : owing ? `Owed on this job: ${formatAmount(due)}` : "Nothing owed on this job."}
      </p>

      <fieldset className="flex gap-2">
        <legend className="sr-only">How they paid</legend>
        {methods.map((m) => (
          <label key={m}
                 className={`flex h-12 flex-1 cursor-pointer items-center justify-center rounded border text-base font-medium ${
                   method === m ? "border-ink-900 bg-ink-900 text-white" : "border-steel-300"}`}>
            <input type="radio" name={name} value={m} checked={method === m} className="sr-only"
                   onChange={() => { setMethod(m); setProblem(null); setLink(null); }} />
            {m === "cash" ? "Cash" : m === "check" ? "Check" : m === "card" ? "Card" : "Finance"}
          </label>
        ))}
      </fieldset>

      {method === "card" || method === "finance" ? (
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={() => void askForLink(true)}
                  className="h-12 flex-1 rounded border border-steel-300 text-base font-medium disabled:opacity-60">
            {busy ? "Asking" : method === "card" ? "Text them a card link" : "Text them a financing link"}
          </button>
          <button type="button" disabled={busy} onClick={() => void askForLink(false)}
                  className="h-12 flex-1 rounded border border-steel-300 text-base font-medium disabled:opacity-60">
            Show the link
          </button>
        </div>
      ) : (
        <>
          <div className="flex gap-2">
            <label className="flex h-12 flex-1 items-center gap-2 rounded border border-steel-300 px-3">
              <span className="text-sm text-ink-500">Amount</span>
              <input value={shown} onChange={(e) => { setTyped(true); setAmount(e.target.value); }} inputMode="decimal"
                     aria-label="Amount" className="w-full bg-transparent text-base" placeholder="0.00" />
            </label>
            {method === "check" && (
              <label className="flex h-12 flex-1 items-center gap-2 rounded border border-steel-300 px-3">
                <span className="text-sm text-ink-500">Check no.</span>
                <input value={checkNumber} onChange={(e) => setCheckNumber(e.target.value)} inputMode="numeric"
                       aria-label="Check number" className="w-full bg-transparent text-base" />
              </label>
            )}
          </div>
          {tipping && (
            <div className="space-y-2">
              <p className="text-sm text-ink-500">A tip on top, for everybody on this job:</p>
              <div className="flex gap-2">
                {suggested.map((choice) => (
                  <button key={choice.percent} type="button" aria-label={`Tip ${choice.percent} per cent`}
                          onClick={() => setTip(formatAmount(choice.amount).replace(/[$,]/g, ""))}
                          className="h-12 flex-1 rounded border border-steel-300 text-base font-medium">
                    {choice.percent}%
                  </button>
                ))}
              </div>
              <label className="flex h-12 items-center gap-2 rounded border border-steel-300 px-3">
                <span className="text-sm text-ink-500">Tip</span>
                <input value={tip} onChange={(e) => setTip(e.target.value)} inputMode="decimal" aria-label="Tip"
                       className="w-full bg-transparent text-base" placeholder="None" />
              </label>
            </div>
          )}
          <button type="button" onClick={() => void recordMoney()}
                  className="h-12 w-full rounded border border-steel-300 text-base font-medium">
            {method === "cash" ? "Record cash payment" : "Record check payment"}
          </button>
        </>
      )}

      {problem && <p role="alert" className="rounded bg-red-tint px-3 py-2 text-sm text-red-600">{problem}</p>}
      {link && (
        <p className="text-sm text-ink-700" role="status">
          {link.said}{" "}
          {link.url && <a href={link.url} target="_blank" rel="noreferrer" className="break-all underline underline-offset-4">{link.url}</a>}
        </p>
      )}
      {payments.length > 0 && (
        <ul className="space-y-1 text-sm">
          {payments.map((p) => (
            <li key={p.clientId} className="text-ink-700">
              {p.method === "cash" ? "Cash" : "Check"} {formatAmount(p.amount)}{p.tip ? `, tip ${formatAmount(p.tip)}` : ""},{" "}
              {p.waiting ? <span className="text-amber-700">waiting to send</span> : "sent"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The bytes of a photograph, over the API with this page's own sign in. The
 * same three calls the phone app makes, so the server cannot tell the two
 * apart and does not need to.
 */
function uploadTransport(deviceId: string): UploadTransport {
  const api = new FieldApi({ serverUrl: window.location.origin });
  return {
    owed: async () => (await api.owedUploads(deviceId)).map((u) => u.clientId),
    store: (uploadId, base64, caption) => api.storeUpload(uploadId, base64, caption),
    fail: async (uploadId, error) => {
      try {
        await api.failUpload(uploadId, error);
      } catch (cause) {
        if (!isOffline(cause)) throw cause;
      }
    },
  };
}
