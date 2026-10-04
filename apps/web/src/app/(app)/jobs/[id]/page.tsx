import { CustomFieldsPanel } from "@/components/CustomFieldsPanel";
import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  jobs, customers, commercial, entitlements, files, profitability, priceBook, billing, visitChanges, customFields,
  NotFoundError, acquisition, marketing, portalSettings, branches, contracts, jobBilling,
} from "@opentradesos/api/services";
import { can, coverage as cov, money, parties as roles, work } from "@opentradesos/core";
import { Money } from "@opentradesos/ui";
import { Authorize, Coverage } from "./Commercial";
import { BillingPlanView, ContractAndDeadlines, CoverageFromUnit } from "./CommercialBilling";
import { Priority } from "./Priority";
import { Branch } from "./Branch";
import { RequiredSkills } from "./RequiredSkills";
import { Parties } from "./Parties";
import { Costing } from "./Costing";
import { Chip } from "@opentradesos/ui";
import { Facts, Fact, Crumb } from "@/components/Detail";
import { Table, Th, Td, Empty } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { JOB_STATUS, VISIT_STATUS, JOB_TONE, VISIT_TONE, INVOICE_STATUS, INVOICE_TONE, label, tone } from "@/lib/labels";
import { ActionForm, TextArea } from "@/components/ActionForm";
import { VisitFields } from "@/components/VisitFields";
import { technicianChoices } from "@/lib/technicians";
import { todayIn } from "@/lib/dates";
import { addVisit } from "../actions";
import { approveVisitChange, completeVisitFromOffice, declineVisitChange, setJobStatus, shareJobPhoto } from "./actions";
import { shareVisitNotes } from "./notes-actions";
import { VisitChangeDecision } from "@/components/VisitChangeDecision";
import { CompleteVisit, JobLifecycle, UsedOnJob, OPEN_VISIT } from "./Work";
import { Origin } from "./Origin";
import { EstimateDrafts } from "./EstimateDrafts";

export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;

  const ctx = { actor: user.actor, db: getDb() };

  const job = await jobs.get(ctx, { id })
    .catch((error: unknown) => {
      // Out of scope reads as missing, not as forbidden. "You may not see
      // this job" answers a question the caller was not allowed to ask.
      if (error instanceof NotFoundError) notFound();
      throw error;
    });

  /**
   * Cost against revenue, for whoever may read both. The statement asks for
   * the financial reports permission and job costing together; checking
   * them here keeps the section absent rather than present and refusing.
   */
  const costing = can(user.actor, "report.financial:read") && can(user.actor, "job.cost:read")
    ? await profitability.statement(ctx, { jobId: id })
    : null;

  const [parties, authorization, entitlement, customer, sources, branchOptions] = await Promise.all([
    commercial.parties(ctx, { jobId: id }),
    commercial.authorizationFor(ctx, { jobId: id }),
    entitlements.forJob(ctx, { jobId: id }),
    customers.get(ctx, { id: job.customerId }),
    acquisition.channelOptions(ctx),
    branches.options(ctx),
  ]);
  /**
   * WHO PAYS FOR OTHER PEOPLE'S WORK: customers with a contract, offered by
   * name on the parties form, and the contracts the job could run under,
   * which are the ones held by somebody on the job.
   */
  const allContracts = can(user.actor, "contract:read") ? await contracts.listContracts(ctx) : [];
  const accounts = [...new Map([
    ...allContracts.map((c) => [c.customerId, c.customerName] as const),
    ...parties.filter((row) => row.party.customerId && row.party.customerId !== job.customerId)
      .map((row) => [row.party.customerId!, row.customerName ?? ""] as const),
  ]).entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  const involved = new Set([job.customerId, ...parties.map((row) => row.party.customerId).filter(Boolean)]);
  const contractOptions = allContracts.filter((c) => involved.has(c.customerId))
    .map((c) => ({ id: c.id, label: `${c.name}, ${c.customerName}` }));
  const clocks = await jobBilling.clocks(ctx, { jobId: id });
  const plan = can(user.actor, "invoice:read") ? await jobBilling.preview(ctx, { jobId: id }) : null;

  /** The evidence behind the source, for whoever reads the marketing figures. */
  const attribution = can(user.actor, "adspend:read")
    ? await marketing.handlers.getJobAttribution(ctx, { jobId: id })
    : null;

  /**
   * What a technician photographed, and what is still on their phone.
   *
   * Both halves matter and only together. `field_upload` wrote a row per
   * photograph the moment a visit synced, under a comment saying a report
   * "should say so the moment it syncs, with the images following behind";
   * the images never followed and nothing showed the promise either. A
   * screen that showed only what arrived would say two photographs where
   * there were three, and nobody would know to ask for the third.
   */
  const visitIds = job.visits.map((visit) => visit.id);
  const photos = (await Promise.all(visitIds.map((visitId) =>
    files.attachmentsFor(ctx, { entityType: "visit", entityId: visitId })
      .then((rows) => rows.map((row) => ({ ...row, visitId }))),
  ))).flat();
  const outstanding = (await Promise.all(visitIds.map((visitId) =>
    files.outstandingFor(ctx, { subjectType: "visit", subjectId: visitId }),
  ))).reduce(
    (total, one) => ({
      stored: total.stored + one.stored,
      pending: total.pending + one.pending,
      abandoned: total.abandoned + one.abandoned,
    }),
    { stored: 0, pending: 0, abandoned: 0 },
  );
  /**
   * Whether a photograph is shown to the customer is decided one by one, by
   * whoever may publish a service report, unless the company shows every
   * photograph on its portal (its portal settings). Somebody who cannot read
   * settings is shown the per photograph state and no switch.
   */
  const photoSharing = (await portalSettings.get(ctx).catch(() => null))?.jobPhotos ?? "chosen";
  const sharesPhotos = can(user.actor, "servicereport:publish");
  const writes = can(user.actor, "job:write");
  const schedules = can(user.actor, "visit:write") && job.status !== "cancelled" && job.status !== "paid";
  const technicians = await technicianChoices(ctx, user.organizationTimezone);
  const nameOf = new Map(technicians.map((t) => [t.id, t.displayName]));
  const completes = can(user.actor, "job:complete");
  const openVisits = job.visits.filter((v) => (OPEN_VISIT as readonly string[]).includes(v.status));
  const used = (await jobs.lines(ctx, { id })).data;
  /** A customer asking from their link to move or cancel one of these visits. */
  const changeRequests = can(user.actor, "visit:read")
    ? await visitChanges.list(ctx, { status: "pending", jobId: id })
    : [];
  const invoices = can(user.actor, "invoice:read")
    ? (await billing.list(ctx, { limit: 50, jobId: id })).data
    : [];
  const canInvoice = can(user.actor, "invoice:write") && job.status !== "cancelled";
  const items = completes && openVisits.length > 0 && can(user.actor, "pricebook:read")
    ? (await priceBook.list(ctx, { limit: 200, includeInactive: false })).data
      .map((item) => ({ id: item.id, name: item.name, price: item.price }))
      .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/jobs">Jobs</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">
          <span className="font-mono tabular-nums text-ink-500">{job.number}</span>{" "}
          {job.summary ?? "Untitled"}
        </h1>
        <Chip tone={tone(JOB_TONE, job.status)}>
          {label(JOB_STATUS, job.status)}
        </Chip>
      </div>

      <Facts>
        {/*
          Hidden when it is normal. Normal is the absence of urgency rather
          than a choice, and a line on every job saying so is a line nobody
          reads. An integer with no scale was worse: this rendered a bare
          "0" for every job in the company.
        */}
        <Fact label="Priority">
          {job.priority === work.NORMAL_PRIORITY ? null : work.priorityLabel(job.priority)}
        </Fact>
        <Fact label="Description">{job.description}</Fact>
        <Fact label="Customer said">{job.customerComplaint}</Fact>
        <Fact label="PO number">{job.purchaseOrderNumber}</Fact>
        <Fact label="Unit">
          {job.equipmentId ? <a href={`/equipment/${job.equipmentId}`} className="hover:underline">The unit this job is about</a> : null}
        </Fact>
      </Facts>

      {writes ? <Priority jobId={id} current={job.priority} /> : null}
      <Branch jobId={id} current={job.businessUnitId ?? null} options={branchOptions} writes={writes} />
      <RequiredSkills jobId={id} actor={user.actor} writes={writes} />

      <Origin jobId={id} job={job} sources={sources} attribution={attribution} writes={writes}
              timezone={user.organizationTimezone} />

      {/*
        WHO IS INVOLVED, WHO IS PAYING, AND WHAT THEY AUTHORISED.
        All three are decided before anybody invoices and usually by somebody
        else, and whoever raises the invoice finds out about them by being
        refused, which is the wrong moment unless the job says so first.
      */}
      <h2 className="mt-10 text-base font-semibold">Who is involved</h2>
      {parties.length === 0 ? (
        <p className="mt-2 text-sm text-ink-500">
          Nobody named, so the customer is all of them. That is the ordinary
          residential case and nothing about it is missing.
        </p>
      ) : null}

      {/*
        The list or the form, never both. The form carries the same names in
        its own boxes, and a screen that states the same fact twice in two
        shapes is one where the two eventually disagree.
      */}
      {!writes ? (
        parties.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink-700">
            {parties.map((row) => (
              <li key={row.party.id}>
                <span className="text-ink-500">{roles.roleLabel(row.party.role)}</span>{" "}
                {row.customerName ?? row.party.externalName}
                {row.party.externalReference ? (
                  <span className="text-ink-500"> ({row.party.externalReference})</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null
      ) : (
        <Parties
          jobId={id}
          customerId={job.customerId}
          customerName={customer.name}
          accounts={accounts}
          roles={roles.PARTY_ROLES.map((role) => {
            const held = parties.find((row) => row.party.role === role.key);
            return {
              key: role.key,
              label: role.label,
              meaning: role.meaning,
              current: held
                ? {
                    isCustomer: held.party.customerId !== null,
                    name: held.customerName ?? held.party.externalName ?? "",
                    reference: held.party.externalReference ?? "",
                    accountId: held.party.customerId && held.party.customerId !== job.customerId ? held.party.customerId : null,
                    share: held.party.sharePercent
                      ? `${Number(held.party.sharePercent) * 100}%`
                      : held.party.shareAmount ? money.edit(money.money(held.party.shareAmount, "USD")) : "",
                  }
                : null,
            };
          })}
        />
      )}

      <h2 className="mt-10 text-base font-semibold">Who is paying, and why</h2>
      {entitlement ? (
        <p className="mt-2 text-sm text-ink-700">
          {entitlement.profile.description}
        </p>
      ) : (
        <p className="mt-2 text-sm text-ink-500">
          Nobody decided, so the customer is billed for it.
        </p>
      )}

      {writes ? (
        <Coverage
          jobId={id}
          sources={cov.SOURCES.map((key) => ({
            key, label: cov.COVERAGE[key].label, description: cov.COVERAGE[key].description,
          }))}
          current={entitlement
            ? {
                source: entitlement.source,
                externalReference: entitlement.externalReference,
                customerResponsibility: entitlement.customerResponsibility
                  ? money.edit(money.money(entitlement.customerResponsibility, "USD")) : null,
              }
            : null}
        />
      ) : null}
      {writes && job.equipmentId ? <CoverageFromUnit jobId={id} /> : null}

      <h2 className="mt-10 text-base font-semibold">Authorised</h2>
      {authorization ? (
        <p className="mt-2 flex flex-wrap items-baseline gap-x-4 text-sm text-ink-700">
          <span>
            {authorization.amount
              ? <>Up to <Money value={authorization.amount} /></>
              : "No stated limit"}
          </span>
          <span>Billed <Money value={authorization.consumed} /></span>
          {authorization.remaining ? (
            <span className={authorization.remaining === "0.0000" ? "text-red-600" : undefined}>
              <Money value={authorization.remaining} /> left
            </span>
          ) : null}
          {authorization.externalReference ? (
            <span className="text-ink-500">{authorization.externalReference}</span>
          ) : null}
          {authorization.state !== "granted" ? (
            <span className="text-red-600">{authorization.state}</span>
          ) : null}
        </p>
      ) : (
        <p className="mt-2 text-sm text-ink-500">
          Nobody set a ceiling, so this job bills what it costs. A commercial
          client who authorised an amount will dispute anything above it.
        </p>
      )}

      {writes ? <Authorize jobId={id} current={authorization
        ? {
            /**
             * Trimmed for the box. The column keeps four decimal places
             * because allocation needs them, and "2500.0000" in an input a
             * person is about to retype is the storage format leaking onto
             * a form.
             */
            amount: authorization.amount ? money.edit(money.money(authorization.amount, "USD")) : null,
            grantedByName: authorization.grantedByName,
            externalReference: authorization.externalReference,
          }
        : null} /> : null}

      <ContractAndDeadlines jobId={id} clocks={clocks} options={contractOptions} writes={writes}
                            timezone={user.organizationTimezone} />

      {costing && <Costing data={costing} />}

      <h2 className="mt-10 text-base font-semibold">Visits</h2>
      {job.visits.length === 0 ? (
        <Empty title="Not scheduled yet">
          A job becomes work when it has a visit on the board.
        </Empty>
      ) : (
        <Table head={<><Th className="w-16">#</Th><Th>Window</Th><Th>Who</Th><Th>Status</Th></>}>
          {job.visits.map((visit) => (
            <tr key={visit.id}>
              <Td className="font-mono tabular-nums text-ink-700">
                <a href={`/visits/${visit.id}`} className="hover:underline" aria-label={`Open visit ${visit.sequence}`}>{visit.sequence}</a>
              </Td>
              <Td className="text-ink-700">
                {/*
                  In the company's timezone, always. A dispatcher in Denver
                  looking at a Texas company has to see the window the Texas
                  customer was given, and formatting in the viewer's zone
                  silently shows them a different appointment.
                */}
                {visit.windowStart
                  ? formatIn(visit.windowStart, user.organizationTimezone)
                  : "Unscheduled"}
                {visit.technicianNotes ? (
                  <p className="mt-1 whitespace-pre-line text-xs text-ink-500">{visit.technicianNotes}</p>
                ) : null}
                {visit.customerNotesSharedAt && visit.customerNotes ? (
                  <p className="mt-1 whitespace-pre-line text-xs text-ink-700">
                    <span className="font-medium">The customer reads:</span> {visit.customerNotes}
                  </p>
                ) : null}
                {/*
                  The notes are the technician's own and stay private. What the
                  customer reads on their account is a copy somebody here chose,
                  edited if it needs to be, and it does not change when the phone
                  adds to the notes later.
                */}
                {can(user.actor, "servicereport:publish") && (visit.technicianNotes || visit.customerNotes) ? (
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-ink-700 underline underline-offset-4">
                      {visit.customerNotesSharedAt ? "Change what the customer reads" : "Show the customer these notes"}
                    </summary>
                    <ActionForm action={shareVisitNotes} submit="Show on their account" tone="quiet"
                                hidden={{ jobId: job.id, visitId: visit.id }} className="mt-2 space-y-2">
                      <TextArea label={`What the customer reads about visit ${visit.sequence}`} name="notes"
                                defaultValue={visit.customerNotes ?? visit.technicianNotes ?? ""} maxLength={4000} />
                    </ActionForm>
                    {visit.customerNotesSharedAt && (
                      <ActionForm action={shareVisitNotes} submit="Stop showing the customer" tone="quiet"
                                  hidden={{ jobId: job.id, visitId: visit.id, stop: "yes" }} className="mt-2" />
                    )}
                  </details>
                ) : null}
              </Td>
              <Td className="text-ink-700">
                {visit.technicianIds.length === 0
                  ? <span className="text-ink-500">Nobody yet</span>
                  : visit.technicianIds.map((t) => nameOf.get(t) ?? "A technician").join(", ")}
              </Td>
              <Td>
                <Chip tone={tone(VISIT_TONE, visit.status)}>
                  {label(VISIT_STATUS, visit.status)}
                </Chip>
              </Td>
            </tr>
          ))}
        </Table>
      )}

      {changeRequests.length > 0 && (
        <div className="mt-4 space-y-3">
          {changeRequests.map((request) => (
            <VisitChangeDecision
              key={request.id}
              request={{
                ...request,
                assigned: (job.visits.find((v) => v.id === request.visitId)?.technicianIds ?? [])
                  .map((t) => nameOf.get(t) ?? "A technician"),
              }}
              timezone={user.organizationTimezone}
              approve={approveVisitChange}
              decline={declineVisitChange}
              canDecide={can(user.actor, "visit:reschedule")}
            />
          ))}
        </div>
      )}

      {completes && openVisits.map((visit) => (
        <CompleteVisit key={visit.id} action={completeVisitFromOffice} jobId={id}
                       visit={{ id: visit.id, sequence: visit.sequence }} items={items} />
      ))}

      {writes && <JobLifecycle action={setJobStatus} jobId={id} status={job.status} openVisits={openVisits.length} />}

      {schedules && (
        <details className="mt-4 rounded-md border border-steel-200 p-4">
          <summary className="cursor-pointer text-sm font-medium">Add a visit</summary>
          <ActionForm action={addVisit} submit="Add visit" hidden={{ jobId: id }} className="mt-3 space-y-4">
            <VisitFields technicians={technicians} defaultDate={todayIn(user.organizationTimezone)}
                         legend="Next visit" />
          </ActionForm>
        </details>
      )}

      <UsedOnJob lines={used} />

      <EstimateDrafts ctx={ctx} jobId={id} />
      {plan && (plan.lines.length > 0 || plan.existing.length === 0) && job.status !== "cancelled" && (
        <BillingPlanView jobId={id} plan={plan} canBill={canInvoice} />
      )}

      {(invoices.length > 0 || canInvoice) && (
        <section aria-label="Invoices">
          <div className="mt-10 flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-base font-semibold">Invoices</h2>
            {canInvoice && (
              <a href={`/invoices/new?job=${id}`}
                 className="inline-flex h-9 items-center rounded bg-ink-900 px-3 text-sm font-medium text-white">
                Invoice this job
              </a>
            )}
          </div>
          {invoices.length === 0 ? (
            <p className="mt-2 text-sm text-ink-500">Not invoiced yet.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {invoices.map((inv) => (
                <li key={inv.id} className="flex flex-wrap items-center gap-3">
                  <a href={`/invoices/${inv.id}`} className="font-mono tabular-nums hover:underline">Invoice {inv.number}</a>
                  <Money value={inv.total} />
                  <Chip tone={tone(INVOICE_TONE, inv.status)}>{label(INVOICE_STATUS, inv.status)}</Chip>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {(photos.length > 0 || outstanding.pending > 0 || outstanding.abandoned > 0) && (
        <>
          <h2 className="mt-10 text-base font-semibold">Photos</h2>
          <p className="mt-1 text-sm text-ink-700">
            {outstanding.pending > 0 && (
              <span>
                {outstanding.pending} still uploading from the van.{" "}
              </span>
            )}
            {outstanding.abandoned > 0 && (
              /*
                Said out loud, and said differently from "still uploading".
                A photograph that will never arrive and one that is on its
                way are different things to tell somebody, and only one of
                them is worth waiting for.
              */
              <span className="text-red-600">
                {outstanding.abandoned} never arrived and the device has
                stopped trying.
              </span>
            )}
          </p>

          {photos.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-3">
              {photos.map((photo) => (
                <li key={photo.id}>
                  <a href={`/files/${photo.storageKey}`} className="block">
                    {photo.contentType?.startsWith("image/") ? (
                      /*
                        A plain img rather than next/image. The optimizer
                        would fetch this URL from the server side, where it
                        has no session, so every photograph would come back
                        a 404. A job photo is behind a login by design.
                      */
                      <img
                        src={`/files/${photo.storageKey}`}
                        alt={photo.fileName ?? "Job photo"}
                        className="h-32 w-32 rounded border border-steel-200 object-cover"
                      />
                    ) : (
                      <span className="flex h-32 w-32 items-center justify-center rounded border border-steel-200 text-sm text-ink-700">
                        {photo.fileName ?? "File"}
                      </span>
                    )}
                  </a>
                  {photo.phase && (
                    <span className="mt-1 block text-xs text-ink-500">{photo.phase}</span>
                  )}
                  {photo.kind === "photo" && photo.contentType?.startsWith("image/") && (
                    photoSharing === "all" ? (
                      <span className="mt-1 block text-xs text-ink-500">Shown to the customer</span>
                    ) : sharesPhotos ? (
                      <ActionForm
                        action={shareJobPhoto}
                        submit={photo.sharedWithCustomerAt ? "Stop showing the customer" : "Show the customer"}
                        hidden={{ jobId: id, attachmentId: photo.id, shared: photo.sharedWithCustomerAt ? "no" : "yes" }}
                        tone="quiet"
                        className="mt-1 w-32"
                      />
                    ) : photo.sharedWithCustomerAt ? (
                      <span className="mt-1 block text-xs text-ink-500">Shown to the customer</span>
                    ) : null
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <CustomFieldsPanel
        entityType="job" id={id}
        definitions={await customFields.formFields(ctx, "job")}
        values={(job.customFields ?? {}) as Record<string, unknown>}
        canWrite={can(user.actor, "job:write")}
      />
    </div>
  );
}
