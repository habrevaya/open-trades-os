import type { ReactNode } from "react";

export interface AccountViewData {
  organizationName: string;
  customerName: string;
  properties: { id: string; line1: string; line2: string | null; city: string; state: string; postalCode: string }[];
  jobs: { id: string; number: number; summary: string; status: string; completedAt: string | null }[];
  visits: {
    id: string; jobNumber: number; summary: string; status: string;
    windowStart: string | null; windowEnd: string | null; technicianName: string | null;
  }[];
  invoices: {
    id: string; number: number; status: string; issuedOn: string | null; dueOn: string | null;
    currency: string; total: string; balance: string; payable: boolean;
    /** A bank payment for it is on its way. */
    bankPaymentPending?: boolean;
    tipping: { available: boolean; presets: { percent: number; amount: string }[]; for: string[] };
  }[];
  estimates: { id: string; number: number; title: string | null; status: string; sentAt: string | null }[];
  agreements: { id: string; planName: string; status: string; startedOn: string; endsOn: string | null }[];
  deposits: { id: string; status: string; amountRequested: string; amountReceived: string; currency: string }[];
  onlinePaymentAvailable: boolean;
  /** Visits asked for from the account and not booked yet. */
  requested?: { id: string; serviceName: string; requestedDate: string; windowName: string | null; technicianName: string | null }[];
  /** Bank payments on their way, and recent ones that failed. */
  bankPayments?: {
    id: string; status: "pending" | "failed"; amount: string; invoiceNumbers: number[];
    startedAt: string; failedAt: string | null; reason: string | null;
  }[];
  /** The work, laid out the way the company's trade pack says. Absent, the page draws what every account shows. */
  extras?: AccountExtrasData;
}

export interface ReportData {
  id: string;
  visitId: string;
  publishedAt: string;
  summary: string | null;
  observations: string | null;
  fields: {
    key: string; label: string; kind: string; unit: string | null; value: string | null; outOfRange: boolean;
    product: { name: string | null; epaRegistrationNumber: string | null; quantity: string | null; unit: string | null; target: string | null } | null;
  }[];
}

export interface AccountExtrasData {
  blocks: { kind: BlockKind; title: string; config: Record<string, unknown>; declared: boolean }[];
  history: {
    visitId: string; jobId: string; jobNumber: number; summary: string; date: string | null; status: string;
    technicianName: string | null; notes: string | null; report: ReportData | null;
  }[];
  equipment: {
    id: string; property: string; name: string; tag: string | null; manufacturer: string | null; model: string | null;
    serialNumber: string | null; installedOn: string | null; warrantyPartsExpiresOn: string | null;
    warrantyLaborExpiresOn: string | null; location: string | null; details: { label: string; value: string }[];
  }[];
  readings: { key: string; label: string; unit: string | null; points: { at: string; value: string; outOfRange: boolean }[] }[];
  checklist: { date: string | null; summary: string; items: { label: string; done: boolean }[] } | null;
  photos: { id: string; takenAt: string; jobNumber: number }[];
  payments: { id: string; receivedAt: string; amount: string; method: string; status: string }[];
  planVisits: { agreementId: string; planName: string; dueOn: string; state: "done" | "booked" | "skipped" | "due" }[];
  recommendations: { date: string; text: string }[];
  contact: { phone: string | null; technicians: string[] };
}

type BlockKind =
  | "visit_timeline" | "service_report" | "readings_trend" | "equipment_register"
  | "checklist_results" | "photo_gallery" | "documents" | "invoices" | "payments"
  | "plan_status" | "next_visit" | "recommended_work" | "referral" | "contact_card";

/** What every account shows when nothing says otherwise: the same list core adds after a pack's own. */
const DEFAULT_BLOCKS: AccountExtrasData["blocks"] = [
  { kind: "next_visit", title: "Coming up", config: {}, declared: false },
  { kind: "visit_timeline", title: "Service history", config: {}, declared: false },
  { kind: "invoices", title: "Invoices", config: {}, declared: false },
  { kind: "plan_status", title: "Your plan", config: {}, declared: false },
  { kind: "equipment_register", title: "Your equipment", config: {}, declared: false },
];

const EMPTY_EXTRAS: AccountExtrasData = {
  blocks: DEFAULT_BLOCKS, history: [], equipment: [], readings: [], checklist: null, photos: [], payments: [],
  planVisits: [], recommendations: [], contact: { phone: null, technicians: [] },
};

export const money = (value: string, currency: string) =>
  Number(value).toLocaleString("en-US", { style: "currency", currency });

const day = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  });

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

const VISIT: Record<string, string> = {
  unassigned: "Being scheduled", scheduled: "Scheduled", dispatched: "Scheduled",
  en_route: "On the way", working: "In progress", completed: "Done",
  completed_after_cancellation: "Done", cancelled: "Cancelled", no_show: "Missed",
};

const INVOICE: Record<string, string> = {
  open: "Due", partially_paid: "Part paid", paid: "Paid", void: "Cancelled", written_off: "Closed",
};

const ESTIMATE: Record<string, string> = {
  sent: "Waiting for you", viewed: "Waiting for you", approved: "Approved", converted: "Approved",
  declined: "Declined", expired: "Expired",
};

const JOB: Record<string, string> = {
  scheduled: "Booked", in_progress: "Under way", on_hold: "On hold",
  completed: "Done", invoiced: "Done", paid: "Done",
};

const PLAN_VISIT: Record<string, string> = { done: "Done", booked: "Booked", skipped: "Skipped", due: "To book" };

const METHOD: Record<string, string> = {
  card: "Card", card_present: "Card", ach: "Bank account", cash: "Cash", check: "Check",
  financing: "Financing", credit: "Credit", other: "Other",
};

const shortDay = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** A reading as a person reads it: the number, then its unit. */
const reading = (value: string | null, unit: string | null) =>
  value === null ? "" : `${/^-?\d+(\.\d+)?$/.test(value) ? String(Number(value)) : value}${unit ? ` ${unit}` : ""}`;

const AGREEMENT: Record<string, string> = {
  pending: "Starting", active: "Active", past_due: "Payment due", paused: "Paused",
  lapsed: "Lapsed", cancelled: "Cancelled", completed: "Finished",
};

function Section({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section aria-label={title} id={id} className="rounded-md border border-steel-200 bg-canvas p-5">
      <h2 className="text-xs uppercase tracking-[0.08em] text-ink-500">{title}</h2>
      {children}
    </section>
  );
}

/** One published report: what was done, the readings shown to the customer, and what was applied. */
function Report({ report }: { report: ReportData }) {
  const products = report.fields.filter((f) => f.product);
  const readings = report.fields.filter((f) => !f.product && f.value !== null);
  return (
    <div id={`report-${report.id}`} className="mt-2 space-y-2 rounded border border-steel-200 p-3 text-sm">
      {report.summary && <p>{report.summary}</p>}
      {products.length > 0 && (
        <div>
          <p className="text-xs font-medium text-ink-700">Products used</p>
          <ul className="mt-1 space-y-1">
            {products.map((f, i) => (
              <li key={`${f.key}-${i}`}>
                {f.product!.name ?? f.label}
                {f.product!.quantity ? `, ${reading(f.product!.quantity, f.product!.unit)}` : ""}
                {f.product!.target ? `, for ${f.product!.target}` : ""}
                {f.product!.epaRegistrationNumber && (
                  <span className="block text-xs text-ink-500">EPA registration {f.product!.epaRegistrationNumber}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {readings.length > 0 && (
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
          {readings.map((f, i) => (
            <div key={`${f.key}-${i}`} className="contents">
              <dt className="text-ink-700">{f.label}</dt>
              <dd className={`text-right font-mono tabular-nums ${f.outOfRange ? "text-red-600" : ""}`}>
                {reading(f.value, f.unit)}{f.outOfRange ? " (outside the normal range)" : ""}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {report.observations && <p className="text-ink-700">Noted for next time: {report.observations}</p>}
    </div>
  );
}

/**
 * Everything a customer has with the company, from one link.
 *
 * What is owed comes first, whatever the trade, because it is what most
 * people open the page for. Then the blocks the company's trade pack lays
 * out, in its order and with its headings (a pest control customer's
 * treatment record before a lawn customer's season): the page draws what
 * the layout says and knows nothing about which trade it is drawing for.
 * Then the things every account has that no block covers: the work, the
 * estimates, deposits and the homes.
 *
 * Separate from the page so it renders in a test without a database. `pay`
 * builds the card control for one invoice; it is a client component bound
 * to the token and the invoice on the server.
 */
export function AccountView({
  account, pay, returned = null, statementHref, changeHref, open, top, after, referral, photoHref, bookHref,
  closing = "Questions? Reply to the message that brought you here.",
}: {
  /** The customer's referral link, drawn where the layout puts it, or last. */
  referral?: ReactNode;
  /** Where one of their photographs is served from, when the page can serve them. */
  photoHref?: (photoId: string) => string;
  /** Where a signed in customer asks for a visit. */
  bookHref?: string;
  account: AccountViewData;
  /** Where asking to move or cancel one coming visit opens, when the page offers it. */
  changeHref?: (visitId: string) => string;
  /** Where the customer's statement opens, when there is one to show. */
  statementHref?: string;
  /** Stripe's redirect outcome, which is the browser's account and changes nothing. */
  returned?: string | null;
  pay: (invoice: AccountViewData["invoices"][number]) => ReactNode;
  /**
   * A control that opens one estimate, job or invoice on its own page. Only a
   * signed in customer gets one: an account link must not hand out an
   * approval link, so the link page leaves this out.
   */
  open?: (kind: "estimate" | "job" | "invoice", id: string, label: string) => ReactNode;
  /** Above everything else, under the name: who is signed in, and signing out. */
  top?: ReactNode;
  /** After the history, before the closing line: saved cards, for a signed in customer. */
  after?: ReactNode;
  /** The last line. A signed in customer did not arrive from a message, so is told something else. */
  closing?: string;
}) {
  const now = Date.now();
  const extras = account.extras ?? EMPTY_EXTRAS;
  const upcoming = account.visits
    .filter((v) => v.windowStart && new Date(v.windowStart).getTime() >= now
      && v.status !== "cancelled" && v.status !== "completed")
    .reverse();
  const past = account.visits.filter((v) => !upcoming.includes(v)).slice(0, 10);
  const owed = account.invoices.filter((i) => i.payable || i.bankPaymentPending);
  const settled = account.invoices.filter((i) => !i.payable && !i.bankPaymentPending);
  const bank = account.bankPayments ?? [];
  const requested = account.requested ?? [];
  const reports = extras.history.map((h) => h.report).filter((r): r is ReportData => r !== null);
  const hasReferralBlock = extras.blocks.some((b) => b.kind === "referral");

  const block = (b: AccountExtrasData["blocks"][number]): ReactNode => {
    switch (b.kind) {
      case "next_visit":
        return (
          <Section key={b.kind} title={b.title}>
            {upcoming.length === 0 ? (
              <p className="mt-3 text-sm text-ink-500">Nothing scheduled.</p>
            ) : (
              <ul className="mt-3 space-y-2 text-sm">
                {upcoming.map((v) => (
                  <li key={v.id} className="flex justify-between gap-4">
                    <span>
                      {v.summary}
                      {v.technicianName && <span className="text-ink-500">, with {v.technicianName.split(" ")[0]}</span>}
                    </span>
                    <span className="shrink-0 text-right text-ink-700">
                      {day(v.windowStart!)}
                      <span className="block text-xs text-ink-500">
                        {time(v.windowStart!)}{v.windowEnd ? ` to ${time(v.windowEnd)}` : ""}
                      </span>
                      {changeHref && v.status !== "en_route" && v.status !== "working" ? (
                        <a href={changeHref(v.id)} className="block text-xs text-ink-700 underline underline-offset-4">
                          Change or cancel
                        </a>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {extras.planVisits.some((p) => p.state === "due") && (
              <p className="mt-3 text-xs text-ink-500">
                Your plan has a visit to book{bookHref ? "" : ": reply to any message from us and we will set it up"}.
              </p>
            )}
            {bookHref && (
              <a href={bookHref} className="mt-3 inline-block text-sm text-blue-600 underline underline-offset-4">
                Book a visit
              </a>
            )}
          </Section>
        );
      case "visit_timeline":
        return (
          <Section key={b.kind} title={b.title}>
            {extras.history.length === 0 && past.length === 0 ? (
              <p className="mt-3 text-sm text-ink-500">No visits yet.</p>
            ) : extras.history.length === 0 ? (
              <ul className="mt-3 space-y-2 text-sm">
                {past.map((v) => (
                  <li key={v.id} className="flex justify-between gap-4">
                    <span>{v.summary}</span>
                    <span className="shrink-0 text-ink-700">
                      {v.windowStart ? day(v.windowStart) : ""} · {VISIT[v.status] ?? v.status}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <ol className="mt-3 space-y-4 text-sm">
                {extras.history.map((h) => (
                  <li key={h.visitId}>
                    <div className="flex justify-between gap-4">
                      <span className="font-medium">{h.summary}</span>
                      <span className="shrink-0 text-ink-700">{h.date ? day(h.date) : ""}</span>
                    </div>
                    <p className="text-xs text-ink-500">
                      Job #{h.jobNumber}{h.technicianName ? `, with ${h.technicianName}` : ""}
                    </p>
                    {h.notes && <p className="mt-1 whitespace-pre-line text-ink-700">{h.notes}</p>}
                    {h.report && <Report report={h.report} />}
                  </li>
                ))}
              </ol>
            )}
          </Section>
        );
      case "service_report":
        return reports.length === 0 ? null : (
          <Section key={b.kind} title={b.title}>
            {reports.slice(0, 3).map((r) => (
              <div key={r.id} className="mt-3">
                <p className="text-xs text-ink-500">{day(r.publishedAt)}</p>
                <Report report={r} />
              </div>
            ))}
          </Section>
        );
      case "readings_trend":
        return extras.readings.length === 0 ? null : (
          <Section key={b.kind} title={b.title}>
            <div className="mt-3 space-y-4">
              {extras.readings.map((series) => (
                <div key={series.key}>
                  <p className="text-sm font-medium">{series.label}</p>
                  <table className="mt-1 w-full text-sm">
                    <tbody>
                      {series.points.map((p, i) => (
                        <tr key={`${series.key}-${i}`}>
                          <td className="py-0.5 text-ink-700">{shortDay(p.at)}</td>
                          <td className={`py-0.5 text-right font-mono tabular-nums ${p.outOfRange ? "text-red-600" : ""}`}>
                            {reading(p.value, series.unit)}{p.outOfRange ? " (outside the normal range)" : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </Section>
        );
      case "equipment_register":
        return account.properties.length === 0 && extras.equipment.length === 0 ? null : (
          <Section key={b.kind} title={b.title}>
            {extras.equipment.length === 0 ? (
              <p className="mt-3 text-sm text-ink-500">Nothing recorded at your home yet.</p>
            ) : (
              <ul className="mt-3 space-y-3 text-sm">
                {extras.equipment.map((e) => (
                  <li key={e.id}>
                    <span className="font-medium">{e.tag ? `${e.tag}, ` : ""}{e.name}</span>
                    {(e.manufacturer || e.model) && (
                      <span className="text-ink-700"> · {[e.manufacturer, e.model].filter(Boolean).join(" ")}</span>
                    )}
                    <span className="block text-xs text-ink-500">
                      {[
                        e.location,
                        account.properties.length > 1 ? e.property : null,
                        e.serialNumber ? `Serial ${e.serialNumber}` : null,
                        e.installedOn ? `Installed ${shortDay(e.installedOn)}` : null,
                        e.warrantyPartsExpiresOn ? `Parts warranty to ${shortDay(e.warrantyPartsExpiresOn)}` : null,
                        e.warrantyLaborExpiresOn ? `Labour warranty to ${shortDay(e.warrantyLaborExpiresOn)}` : null,
                      ].filter(Boolean).join(" · ")}
                    </span>
                    {e.details.length > 0 && (
                      <span className="block text-xs text-ink-700">
                        {e.details.map((d) => `${d.label}: ${d.value}`).join(" · ")}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        );
      case "checklist_results":
        return extras.checklist === null ? null : (
          <Section key={b.kind} title={b.title}>
            <p className="mt-3 text-xs text-ink-500">
              {extras.checklist.summary}{extras.checklist.date ? `, ${day(extras.checklist.date)}` : ""}
            </p>
            <ul className="mt-2 space-y-1 text-sm">
              {extras.checklist.items.map((item, i) => (
                <li key={i}>{item.done ? "Done: " : "Not done: "}{item.label}</li>
              ))}
            </ul>
          </Section>
        );
      case "photo_gallery":
        return extras.photos.length === 0 || !photoHref ? null : (
          <Section key={b.kind} title={b.title}>
            <ul className="mt-3 grid grid-cols-3 gap-2">
              {extras.photos.map((p) => (
                <li key={p.id}>
                  <a href={photoHref(p.id)}>
                    <img src={photoHref(p.id)} alt={`Job #${p.jobNumber}, ${shortDay(p.takenAt)}`}
                         className="aspect-square w-full rounded object-cover" loading="lazy" />
                  </a>
                </li>
              ))}
            </ul>
          </Section>
        );
      case "documents":
        return reports.length === 0 && !statementHref ? null : (
          <Section key={b.kind} title={b.title}>
            <ul className="mt-3 space-y-1 text-sm">
              {statementHref && account.invoices.length > 0 && (
                <li><a href={statementHref} className="text-blue-600 underline underline-offset-4">Your statement</a></li>
              )}
              {reports.map((r) => (
                <li key={r.id}>
                  <a href={`#report-${r.id}`} className="text-blue-600 underline underline-offset-4">
                    Service report, {day(r.publishedAt)}
                  </a>
                </li>
              ))}
            </ul>
          </Section>
        );
      case "invoices":
        return settled.length === 0 ? null : (
          <Section key={b.kind} title={b.title}>
            <ul className="mt-3 space-y-2 text-sm">
              {settled.map((i) => (
                <li key={i.id} className="flex justify-between gap-4">
                  <span>Invoice #{i.number}{i.issuedOn ? `, ${day(i.issuedOn)}` : ""}</span>
                  <span className="shrink-0 text-right text-ink-700">
                    <span className="font-mono tabular-nums">{money(i.total, i.currency)}</span>
                    {" · "}{INVOICE[i.status] ?? i.status}
                    {open ? <span className="block">{open("invoice", i.id, "See invoice")}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        );
      case "payments":
        return extras.payments.length === 0 ? null : (
          <Section key={b.kind} title={b.title}>
            <ul className="mt-3 space-y-2 text-sm">
              {extras.payments.map((p) => (
                <li key={p.id} className="flex justify-between gap-4">
                  <span>{shortDay(p.receivedAt)}, {METHOD[p.method] ?? p.method}{p.status === "failed" ? " (returned by the bank)" : ""}</span>
                  <span className="shrink-0 font-mono tabular-nums">{money(p.amount, "USD")}</span>
                </li>
              ))}
            </ul>
          </Section>
        );
      case "plan_status":
        return account.agreements.length === 0 ? null : (
          <Section key={b.kind} title={b.title}>
            <ul className="mt-3 space-y-2 text-sm">
              {account.agreements.map((a) => (
                <li key={a.id}>
                  <div className="flex justify-between gap-4">
                    <span>{a.planName}</span>
                    <span className="shrink-0 text-ink-700">
                      {AGREEMENT[a.status] ?? a.status}
                      {a.endsOn ? `, renews ${day(a.endsOn)}` : ""}
                    </span>
                  </div>
                  {extras.planVisits.some((v) => v.agreementId === a.id) && (
                    <ul className="mt-1 space-y-0.5 text-xs text-ink-700">
                      {extras.planVisits.filter((v) => v.agreementId === a.id).map((v, i) => (
                        <li key={i} className="flex justify-between gap-4">
                          <span>Visit due {shortDay(v.dueOn)}</span>
                          <span>{PLAN_VISIT[v.state]}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        );
      case "recommended_work":
        return extras.recommendations.length === 0 ? null : (
          <Section key={b.kind} title={b.title}>
            <ul className="mt-3 space-y-2 text-sm">
              {extras.recommendations.map((r, i) => (
                <li key={i}>
                  <span className="block text-xs text-ink-500">{day(r.date)}</span>
                  {r.text}
                </li>
              ))}
            </ul>
          </Section>
        );
      case "referral":
        return referral ? <div key={b.kind}>{referral}</div> : null;
      case "contact_card":
        return (
          <Section key={b.kind} title={b.title}>
            <p className="mt-3 text-sm">
              {account.organizationName}
              {extras.contact.phone && (
                <a href={`tel:${extras.contact.phone}`} className="block text-blue-600 underline underline-offset-4">
                  {extras.contact.phone}
                </a>
              )}
            </p>
            {extras.contact.technicians.length > 0 && (
              <p className="mt-2 text-sm text-ink-700">Who has been to see you: {extras.contact.technicians.join(", ")}</p>
            )}
          </Section>
        );
      default:
        return null;
    }
  };

  return (
    <>
      <header className="text-center">
        <p className="text-sm font-medium text-ink-700">{account.organizationName}</p>
        <h1 className="mt-1 text-2xl font-semibold">{account.customerName}</h1>
        {statementHref && account.invoices.length > 0 && (
          <a href={statementHref} className="mt-2 inline-block text-sm text-blue-600 underline underline-offset-4">
            Your statement
          </a>
        )}
        {top}
      </header>

      {(returned === "succeeded" || returned === "processing") && (
        <p className="rounded-md border border-steel-200 bg-canvas p-4 text-center text-sm text-ink-700" role="status">
          {returned === "succeeded"
            ? "Thank you. Your payment went through and will show here in a moment."
            : "Your payment is processing. It will show here once your bank confirms it."}
        </p>
      )}
      {returned === "failed" && (
        <p className="rounded bg-red-tint px-3 py-2 text-center text-sm text-red-600" role="alert">
          That payment did not go through. You have not been charged.
        </p>
      )}

      {bank.filter((p) => p.status === "failed").map((p) => (
        <p key={p.id} role="alert" className="rounded bg-red-tint px-3 py-2 text-sm text-red-600">
          Your bank payment of {money(p.amount, "USD")}
          {p.invoiceNumbers.length > 0 ? ` for invoice #${p.invoiceNumbers.join(", #")}` : ""} on {shortDay(p.startedAt)} did
          not go through{p.reason ? `: ${p.reason}` : "."} Nothing was taken. Please pay another way.
        </p>
      ))}

      {owed.length > 0 && (
        <Section title="To pay">
          <ul className="mt-3 space-y-4">
            {owed.map((invoice) => (
              <li key={invoice.id}>
                <div className="flex justify-between gap-4 text-sm">
                  <span>
                    Invoice #{invoice.number}
                    {invoice.dueOn && <span className="text-ink-500">, due {day(invoice.dueOn)}</span>}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums">{money(invoice.balance, invoice.currency)}</span>
                </div>
                {invoice.bankPaymentPending ? (
                  <p role="status" className="mt-2 text-sm text-ink-700">
                    Your bank payment is on its way. Bank payments take a few business days; this will show paid
                    once your bank confirms it.
                  </p>
                ) : account.onlinePaymentAvailable && <div className="mt-2">{pay(invoice)}</div>}
              </li>
            ))}
          </ul>
          {!account.onlinePaymentAvailable && owed.some((i) => i.payable) && (
            <p className="mt-3 text-sm text-ink-700">
              {account.organizationName} does not take card payments online yet. Reply to the message
              that brought you here and they will tell you how to pay.
            </p>
          )}
        </Section>
      )}

      {requested.length > 0 && (
        <Section title="Visits you asked for">
          <ul className="mt-3 space-y-2 text-sm">
            {requested.map((r) => (
              <li key={r.id} className="flex justify-between gap-4">
                <span>
                  {r.serviceName}
                  {r.technicianName && <span className="text-ink-500">, with {r.technicianName} if they can</span>}
                </span>
                <span className="shrink-0 text-right text-ink-700">
                  {day(r.requestedDate)}{r.windowName ? <span className="block text-xs text-ink-500">{r.windowName}</span> : null}
                  <span className="block text-xs text-ink-500">Waiting for us to confirm</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {extras.blocks.map(block)}

      {account.jobs.length > 0 && (
        <Section title="Your work">
          <ul className="mt-3 space-y-2 text-sm">
            {account.jobs.slice(0, 20).map((j) => (
              <li key={j.id} className="flex items-start justify-between gap-4">
                <span>
                  {j.summary}
                  <span className="block text-xs text-ink-500">
                    Job #{j.number}{j.completedAt ? `, done ${day(j.completedAt)}` : ""}
                  </span>
                </span>
                <span className="shrink-0 text-right text-ink-700">
                  {JOB[j.status] ?? "In progress"}
                  {open ? <span className="block">{open("job", j.id, "Details and photos")}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {account.estimates.length > 0 && (
        <Section title="Estimates">
          <ul className="mt-3 space-y-2 text-sm">
            {account.estimates.map((e) => (
              <li key={e.id} className="flex justify-between gap-4">
                <span>Estimate #{e.number}{e.title ? `, ${e.title}` : ""}</span>
                <span className="shrink-0 text-right text-ink-700">
                  {ESTIMATE[e.status] ?? e.status}
                  {open ? (
                    <span className="block">
                      {open("estimate", e.id, e.status === "sent" || e.status === "viewed" ? "Look and approve" : "See estimate")}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {account.deposits.some((d) => d.status === "held") && (
        <Section title="Deposits held">
          <ul className="mt-3 space-y-2 text-sm">
            {account.deposits.filter((d) => d.status === "held").map((d) => (
              <li key={d.id} className="flex justify-between gap-4">
                <span>Held against upcoming work</span>
                <span className="shrink-0 font-mono tabular-nums">{money(d.amountReceived, d.currency)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {account.properties.length > 0 && (
        <Section title={account.properties.length === 1 ? "Your home" : "Your homes"}>
          <ul className="mt-3 space-y-2 text-sm">
            {account.properties.map((p) => (
              <li key={p.id}>
                {p.line1}{p.line2 ? `, ${p.line2}` : ""}
                <span className="block text-ink-500">{p.city}, {p.state} {p.postalCode}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {!hasReferralBlock && referral}

      {after}

      <p className="text-center text-sm text-ink-700">{closing}</p>
    </>
  );
}
