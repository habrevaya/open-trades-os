import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { contracts, contractEscalation, contractBilling, rateCards, jobs, properties, billing } from "@opentradesos/api/services";
import { can, rates, deadlines, contractBilling as cb } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { Crumb } from "@/components/Detail";
import { Table, Th, Td } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { ActionForm, TextField, TextArea, Select } from "@/components/ActionForm";
import { LABOUR_ROWS, MARKUP_ROWS, RISE_ROWS, clockOf, percentOf } from "@/lib/contract-forms";
import { ContractTermFields } from "../ContractTerms";
import {
  addSite, applyEscalation, changeContractBilling, createCard, issuePayerLink, setCardLines, setCardTerms, setContractBilling,
  setContractRises, updateContractTerms,
} from "../actions";

export const dynamic = "force-dynamic";

/** The contract's own first day as the billing day, so there is no part month to start with, when it can be. */
const billingDayFor = (startsOn: string | null) => {
  const day = startsOn ? Number(startsOn.slice(8, 10)) : 1;
  return day >= 1 && day <= 28 ? day : 1;
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const AUTHORITY_OPTIONS = [
  { value: "contract", label: "Client contract" },
  { value: "warranty_network", label: "Warranty network schedule" },
  { value: "manufacturer_allowance", label: "Manufacturer allowance" },
  { value: "insurance", label: "Insurance price list" },
  { value: "brand", label: "Brand schedule" },
];

/**
 * ONE CONTRACT: ITS TERMS, ITS SITES, ITS CARDS, AND ITS PAYER'S INVOICES
 *
 * Everything that decides what this client is charged and when, on one
 * page, because the person setting it up is reading one document: the
 * client's agreement and the schedule stapled to the back of it. The terms
 * at the top (the limit, the clocks, the file they take), the sites with
 * their own limits, then each card with its prices and its rules.
 *
 * The payer's invoices close the page, with the two ways to hand them over
 * that are not email: a link they keep, and a file for their own system.
 */
export default async function ContractPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };
  const contract = (await contracts.overview(ctx)).find((row) => row.id === id);
  if (!contract) notFound();
  const [full] = (await contracts.listContracts(ctx, { customerId: contract.customerId })).filter((c) => c.id === id);
  const writes = can(user.actor, "contract:write");
  const prices = can(user.actor, "pricebook:write");
  const reads = can(user.actor, "pricebook:read");

  const cards = reads
    ? await Promise.all(contract.cards.map(async (card) => ({
        ...card,
        terms: await rateCards.terms(ctx, { rateCardId: card.id }),
        lines: await contracts.rateCardLines(ctx, card.id),
      })))
    : [];
  const types = (await jobs.listTypes(ctx, { includeInactive: false })).data;
  const tradeOptions = [{ value: "", label: "Any kind of work" }, ...types.map((t) => ({ value: t.id, label: t.name }))];
  const bandOptions = rates.BANDS.map((b) => ({ value: b, label: rates.BAND_LABEL[b] }));
  const addresses = writes
    ? (await properties.list(ctx, { limit: 100, customerId: contract.customerId })).data
    : [];
  const rise = reads ? await contractEscalation.preview(ctx, { contractId: id }) : null;
  const riseYearOptions = [{ value: "", label: "Every year" },
    ...Array.from({ length: 9 }, (_, n) => ({ value: String(n + 2), label: `Year ${n + 2}` }))];
  /** A card that has ended has been followed by its next version, which is the one a rise names. */
  const riseCardOptions = [{ value: "", label: "Every card" }, ...contract.cards
    .filter((c) => c.inForce || !c.effectiveTo || rise?.rises.some((r) => r.rateCardId === c.id))
    .map((c) => ({ value: c.id, label: c.name }))];
  const riseTradeOptions = [{ value: "", label: "Every price" }, ...types.map((t) => ({ value: t.id, label: `${t.name} hourly rates` }))];
  const fee = await contractBilling.view(ctx, { contractId: id });
  const raises = can(user.actor, "invoice:write");
  const open = can(user.actor, "invoice:read")
    ? (await billing.list(ctx, { limit: 100, customerId: contract.customerId, status: ["open", "partially_paid"] })).data
    : [];

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/contracts">Contracts</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline gap-2">
        <h1 className="text-xl font-semibold">{contract.name}</h1>
        <a href={`/customers/${contract.customerId}`} className="text-sm text-ink-700 hover:underline">{contract.customerName}</a>
        {contract.inForce ? <Chip tone="success">In force</Chip> : <Chip tone="neutral">Not in force today</Chip>}
      </div>

      <section aria-label="Terms" className="mt-8">
        <h2 className="text-base font-semibold">Terms</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          The limit holds an invoice over it until the client raises it, or lets
          it through with a warning. The clocks run on every job under this
          contract, and a task is raised in the office queue before one runs out.
        </p>
        {full && (
          writes ? (
            <ActionForm action={updateContractTerms} submit="Save terms" hidden={{ contractId: id }} done="Saved.">
              <ContractTermFields values={full} />
            </ActionForm>
          ) : (
            <p className="mt-2 text-sm text-ink-700">
              {full.defaultNotToExceed ? <>Limit <Money value={full.defaultNotToExceed} />, {full.notToExceedAction === "hold" ? "held" : "warned"} when exceeded. </> : "No limit. "}
              {full.slaTerms.map((t) => `${deadlines.deadlineLabel(`sla.${t.kind}`)} ${t.minutes / 60} h${t.priority ? ` (${t.priority})` : ""}`).join(", ")}
            </p>
          )
        )}
      </section>

      <section aria-label="Billed on a schedule" className="mt-10">
        <h2 className="text-base font-semibold">Billed on a schedule</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          A fixed fee every month, three months or year, whether or not anybody
          visited. An invoice goes to {contract.customerName} for each period,
          at its start or after it ends, on their payment terms, with the PO
          number above. Work done on jobs is still billed as usual.
        </p>
        {fee.schedule ? (
          <div className="mt-3 space-y-1 text-sm">
            <p>
              <Money value={fee.schedule.amount} /> {cb.FREQUENCY_LABEL[fee.schedule.frequency].toLowerCase()},
              billed on day {fee.schedule.billingDay}, from {fee.schedule.startsOn}
              {fee.schedule.lastDay ? `, until ${fee.schedule.lastDay}` : ""}.
              {fee.schedule.timing === "arrears"
                ? " Billed after each period ends, for the period just gone. A period cut short by a pause or an end is charged by the day for the days it ran."
                : " Billed at the start of each period, for the period ahead."}
              {fee.schedule.prorate ? " A part period is charged by the day." : " A part period at the start is charged as a whole one."}
              {fee.schedule.taxable ? " Sales tax is added." : " No sales tax."}
              {fee.schedule.risesWithEscalation
                ? " The fee rises with the contract's yearly rise, when a person applies it."
                : " The fee does not rise with the contract's yearly rise."}
            </p>
            {fee.schedule.fees.map((risen) => (
              <p key={risen.from} className="text-ink-700">
                From {risen.from} the fee is <Money value={risen.amount} />, up from <Money value={risen.previousAmount} /> by {percentOf(risen.rate)}%.
              </p>
            ))}
            {fee.standing ? <p className="text-ink-700">{fee.standing}</p> : null}
            {fee.next ? (
              <p className="text-ink-700">
                Next: <Money value={fee.next.amount} /> on {fee.next.billOn}, for {cb.periodWords(fee.next.start, fee.next.end)}
                {fee.next.prorated ? ` (${fee.next.days} of ${fee.next.fullDays} days)` : ""}.
              </p>
            ) : null}
            {fee.due > 0 ? (
              <p className="text-ink-700">
                {fee.due === 1 ? "One period is" : `${fee.due} periods are`} owed now. They go out on the next pass, or now:
              </p>
            ) : null}
          </div>
        ) : (
          <p className="mt-2 text-sm text-ink-500">Not billed on a schedule.</p>
        )}
        <div className="mt-3 flex flex-wrap items-start gap-3">
          {raises && fee.due > 0 && (
            <ActionForm action={changeContractBilling} submit="Raise what is owed now" hidden={{ contractId: id, step: "raise" }}
                        className="space-y-2" />
          )}
          {writes && fee.schedule?.state === "active" && (
            <ActionForm action={changeContractBilling} submit="Pause billing" tone="quiet" hidden={{ contractId: id, step: "pause" }}
                        className="space-y-2" />
          )}
          {writes && fee.schedule?.state === "paused" && (
            <ActionForm action={changeContractBilling} submit="Start billing again" tone="quiet" hidden={{ contractId: id, step: "resume" }}
                        className="space-y-2" />
          )}
          {writes && fee.schedule && fee.schedule.state !== "ended" && (
            <ActionForm action={changeContractBilling} submit="End billing" tone="danger" hidden={{ contractId: id, step: "end" }}
                        className="flex flex-wrap items-end gap-3">
              <TextField label="Last day billed for" name="lastDay" type="date" />
            </ActionForm>
          )}
        </div>
        {writes && (
          <details className="mt-3" open={!fee.schedule}>
            <summary className="cursor-pointer text-sm font-medium">{fee.schedule ? "Change the fee" : "Bill a fixed fee"}</summary>
            <ActionForm action={setContractBilling} submit="Save the fee" hidden={{ contractId: id }} done="Saved."
                        className="mt-3 space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <TextField label="Fee each time" name="amount" inputMode="decimal" required placeholder="1200.00"
                           defaultValue={fee.schedule ? Number(fee.schedule.amount).toFixed(2) : ""} />
                <Select label="How often" name="frequency" defaultValue={fee.schedule?.frequency ?? "monthly"}
                        options={cb.FREQUENCIES.map((f) => ({ value: f, label: cb.FREQUENCY_LABEL[f] }))} />
                <TextField label="Billing day of the month (1 to 28)" name="billingDay" inputMode="numeric" required
                           defaultValue={String(fee.schedule?.billingDay ?? billingDayFor(contract.startsOn))} />
                <Select label="When it bills" name="timing" defaultValue={fee.schedule?.timing ?? "advance"}
                        options={cb.TIMINGS.map((t) => ({ value: t, label: cb.TIMING_LABEL[t] }))} />
                <TextField label="First day billed for" name="startsOn" type="date"
                           defaultValue={fee.schedule?.startsOn ?? contract.startsOn ?? ""} />
                <TextField label="What the invoice says" name="description" required placeholder="Planned maintenance, all sites"
                           defaultValue={fee.schedule?.description ?? ""} />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="prorate" value="1" className="h-4 w-4" defaultChecked={fee.schedule?.prorate ?? false} />
                Charge a part month by the day. Without this, a part month at the start or end is charged in full.
                Billed at the end of each period, a month cut short by a pause or an end is always charged by the day.
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="taxable" value="1" className="h-4 w-4" defaultChecked={fee.schedule?.taxable ?? false} />
                Add sales tax
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="risesWithEscalation" value="1" className="h-4 w-4"
                       defaultChecked={fee.schedule?.risesWithEscalation ?? false} />
                The fee rises with the contract&rsquo;s yearly rise. It is shown with next year&rsquo;s prices and changes only when somebody applies them.
              </label>
              {fee.schedule && fee.schedule.fees.length > 0 && (
                <p className="text-xs text-ink-500">
                  Saving a different fee here replaces the risen fee for every period not yet billed.
                </p>
              )}
            </ActionForm>
          </details>
        )}
        {fee.periods.length > 0 && (
          <Table label="Periods billed" head={<><Th>Period</Th><Th>Billed on</Th><Th className="text-right">Amount</Th><Th>Invoice</Th></>}>
            {fee.periods.map((period) => (
              <tr key={period.id}>
                <Td>
                  {cb.periodWords(period.start, period.end)}{period.prorated ? `, ${period.days} of ${period.fullDays} days` : ""}
                  {period.status === "invoiced" && period.prorated && period.note
                    ? <span className="block text-xs text-ink-500">{period.note}</span> : null}
                </Td>
                <Td>{period.billOn}</Td>
                <Td className="text-right"><Money value={period.amount} /></Td>
                <Td>
                  {period.invoiceId
                    ? <a href={`/invoices/${period.invoiceId}`} className="hover:underline">Invoice {period.invoiceNumber}</a>
                    : <span className="text-ink-500">{period.status === "skipped" ? "Skipped while paused" : "Not billed"}</span>}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      {rise && (rise.rate || rise.rises.length > 0 || writes) && (
        <section aria-label="Annual escalation" className="mt-10">
          <h2 className="text-base font-semibold">Annual escalation</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-700">
            {rise.anniversary
              ? <>{rise.rises.length > 0
                  ? "Rates rise on each anniversary by the rises below, and by the contract's yearly rate where none of them applies."
                  : <>Rates rise by {percentOf(rise.rate ?? "0")}% on each anniversary.</>}
                {" "}Year {rise.contractYear} starts on {rise.anniversary}
                {rise.daysAway !== null && rise.daysAway >= 0 ? `, in ${rise.daysAway} days` : `, ${Math.abs(rise.daysAway ?? 0)} days ago`}.
                Applying it writes a new version of each card from that day; the current prices stay in force until the day before.</>
              : null}
            {rise.escalatedThrough ? ` Last risen on ${rise.escalatedThrough}.` : ""}
          </p>
          {rise.problem && (rise.rate || rise.rises.length > 0) && <p className="mt-2 text-sm text-ink-700">{rise.problem}</p>}
          {rise.drafts && rise.drafts.length > 0 && (
            <div className="mt-2 rounded border border-steel-200 bg-steel-100 p-3 text-sm text-ink-700" role="note" aria-label="Draft prices">
              <p>
                Year {rise.contractYear} prices are ready as a draft, made {formatIn(rise.drafts[0]!.preparedAt, user.organizationTimezone, { dateStyle: "medium" })}:
                {" "}{rise.drafts.map((d) => d.name).join(", ")}. A draft prices nothing. Nothing changes until somebody presses
                {" "}Apply year {rise.contractYear} prices below, which writes the cards from today&rsquo;s prices and closes the task in the office queue.
              </p>
            </div>
          )}
          {rise.feeDraft && (
            <p className="mt-2 text-sm text-ink-700" role="note" aria-label="Draft fee">
              The draft also has the fixed fee at <Money value={rise.feeDraft.amount} /> from {rise.anniversary}. It is billed at
              that only once somebody applies year {rise.contractYear} prices.
            </p>
          )}
          {rise.fee && (
            <Table label={`Fixed fee from ${rise.anniversary}`}
                   head={<><Th>Fixed fee</Th><Th className="text-right">Now</Th><Th className="text-right">From {rise.anniversary}</Th><Th>Rise</Th></>}>
              <tr>
                <Td>Billed {rise.fee.per}. A period already billed keeps its invoice; a period that starts before {rise.anniversary} is billed at the fee now.</Td>
                <Td className="text-right"><Money value={rise.fee.before} /></Td>
                <Td className="text-right"><Money value={rise.fee.after} /></Td>
                <Td>{percentOf(rise.fee.rate)}%, {rise.fee.because}</Td>
              </tr>
            </Table>
          )}
          {rise.cards.map((card) => (
            <Table key={card.rateCardId} label={`${card.name} from ${rise.anniversary}`}
                   head={<><Th>{card.name}</Th><Th className="text-right">Now</Th><Th className="text-right">From {rise.anniversary}</Th><Th>Rise</Th></>}>
              {card.lines.map((line) => (
                <tr key={line.id}>
                  <Td>{line.description}</Td>
                  <Td className="text-right"><Money value={line.before} /></Td>
                  <Td className="text-right"><Money value={line.after} /></Td>
                  <Td>{percentOf(line.rate)}%, {line.because}</Td>
                </tr>
              ))}
              {card.labourRates.map((rate) => (
                <tr key={rate.id}>
                  <Td>{rates.BAND_LABEL[rate.band as rates.LabourBand] ?? rate.band} labour{rate.jobTypeName ? `, ${rate.jobTypeName}` : ""}, per hour</Td>
                  <Td className="text-right"><Money value={rate.before} /></Td>
                  <Td className="text-right"><Money value={rate.after} /></Td>
                  <Td>{percentOf(rate.rate)}%, {rate.because}</Td>
                </tr>
              ))}
              {card.tripCharge && (
                <tr>
                  <Td>Trip charge</Td>
                  <Td className="text-right"><Money value={card.tripCharge.before} /></Td>
                  <Td className="text-right"><Money value={card.tripCharge.after} /></Td>
                  <Td>{percentOf(card.tripCharge.rate)}%, {card.tripCharge.because}</Td>
                </tr>
              )}
            </Table>
          ))}
          {prices && rise.ready && rise.anniversary && rise.key && (
            <ActionForm action={applyEscalation} submit={`Apply year ${rise.contractYear} prices`}
                        hidden={{ contractId: id, anniversary: rise.anniversary, key: rise.key }}
                        className="mt-3 flex flex-wrap items-center gap-3" />
          )}
          {writes && (
            <details className="mt-4" open={rise.rises.length > 0}>
              <summary className="cursor-pointer text-sm font-medium">Rises that differ by year, card or trade</summary>
              <p className="mt-2 max-w-2xl text-sm text-ink-700">
                For a contract that says &ldquo;year two 3%, year three 4%&rdquo;, or rises one trade&rsquo;s hourly rates
                differently, or keeps one card fixed. Each price rises by the closest match: the trade on that card, then the
                trade, then the card, then the year. Anything none of these covers rises by the yearly rate in the terms above.
                A trade&rsquo;s rise is for its hourly rates only. A rise of 0 keeps those prices as they are.
              </p>
              <ActionForm action={setContractRises} submit="Save the rises" hidden={{ contractId: id }} className="mt-3 space-y-2">
                {Array.from({ length: Math.max(RISE_ROWS, rise.rises.length) }, (_, i) => {
                  const row = rise.rises[i];
                  return (
                    <div key={i} className="grid gap-2 sm:grid-cols-4">
                      <Select label="Year" name={`riseYear${i}`} options={riseYearOptions} defaultValue={row?.contractYear ? String(row.contractYear) : ""} />
                      <Select label="Card" name={`riseCard${i}`} options={riseCardOptions} defaultValue={row?.rateCardId ?? ""} />
                      <Select label="Prices" name={`riseTrade${i}`} options={riseTradeOptions} defaultValue={row?.jobTypeId ?? ""} />
                      <TextField label="Rise, per cent" name={`riseRate${i}`} inputMode="decimal" defaultValue={row ? percentOf(row.rate) : ""} />
                    </div>
                  );
                })}
              </ActionForm>
            </details>
          )}
        </section>
      )}

      <section aria-label="Sites" className="mt-10">
        <h2 className="text-base font-semibold">Sites</h2>
        {contract.sites.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">No sites listed, so the contract&rsquo;s own limit applies everywhere it is used.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {contract.sites.map((site) => (
              <li key={site.id} className="flex flex-wrap gap-3">
                <span className="text-ink-900">{site.siteNumber ? `${site.siteNumber} · ` : ""}{site.address}</span>
                <span className="tabular-nums text-ink-700">
                  {site.notToExceed ? <>limit <Money value={site.notToExceed} /> ({site.fromSite ? "site" : "contract"})</> : "no limit"}
                </span>
              </li>
            ))}
          </ul>
        )}
        {writes && addresses.length > 0 && (
          <ActionForm action={addSite} submit="Add the site" hidden={{ contractId: id }} tone="quiet"
                      className="mt-3 grid gap-3 sm:grid-cols-4 sm:items-end">
            <Select label="Address" name="propertyId"
                    options={addresses.map((a) => ({ value: a.id, label: `${a.address.line1}, ${a.address.city}` }))} />
            <TextField label="Their site number" name="siteNumber" />
            <TextField label="Limit at this site" name="notToExceed" inputMode="decimal" placeholder="300.00" />
          </ActionForm>
        )}
      </section>

      <section aria-label="Rate cards" className="mt-10">
        <h2 className="text-base font-semibold">Rate cards</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          A card prices this client&rsquo;s work in order: a listed price for the
          exact item, then an hourly rate for the trade and the time the work
          was done, then a markup on what the part cost us, then a trip charge
          per visit. Anything it does not price falls back to your price book
          and is flagged on the invoice, so it is agreed before it goes out.
        </p>

        {cards.map((card) => (
          <div key={card.id} className="mt-6 rounded-md border border-steel-200 p-4">
            <div className="flex flex-wrap items-baseline gap-2">
              <h3 className="font-medium">{card.name}</h3>
              <span className="text-xs text-ink-500">{rates.authorityLabel(card.authority)}</span>
              {!card.inForce && <Chip tone="neutral">Not in force today</Chip>}
            </div>

            {card.lines.length > 0 && (
              <Table label={`Prices on ${card.name}`} head={<><Th>Code</Th><Th>What</Th><Th className="text-right">Price</Th><Th>Allows</Th></>}>
                {card.lines.map((line) => (
                  <tr key={line.id}>
                    <Td className="font-mono text-xs">{line.externalCode ?? "our item"}</Td>
                    <Td>{line.description}</Td>
                    <Td className="text-right"><Money value={line.price} /></Td>
                    <Td className="text-ink-500">{line.allowedMinutes ? `${line.allowedMinutes} min` : ""}</Td>
                  </tr>
                ))}
              </Table>
            )}

            {prices && (
              <>
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm font-medium">Load the price list</summary>
                  <ActionForm action={setCardLines} submit="Load prices" hidden={{ contractId: id, rateCardId: card.id }}>
                    <TextArea label="One per line: code, description, price, and minutes allowed if the card says" name="lines" rows={5}
                              placeholder={"CAP-45, Run capacitor supplied and fitted, 175.00\nAH-DIAG, After hours diagnostic, 210.00, 60"} />
                    <p className="text-xs text-ink-500">Replaces the list. A code matching one of your items is mapped to it.</p>
                  </ActionForm>
                </details>

                <details className="mt-3" open={card.terms.labourRates.length === 0}>
                  <summary className="cursor-pointer text-sm font-medium">Labour rates, markup and hours</summary>
                  <ActionForm action={setCardTerms} submit="Save the card's rules" hidden={{ contractId: id, rateCardId: card.id }}>
                    <fieldset>
                      <legend className="text-sm font-medium text-ink-700">Hourly rates</legend>
                      <div className="mt-2 space-y-2">
                        {Array.from({ length: LABOUR_ROWS }, (_, i) => {
                          const rate = card.terms.labourRates[i];
                          return (
                            <div key={i} className="grid gap-2 sm:grid-cols-5">
                              <Select label="Trade" name={`trade${i}`} options={tradeOptions} defaultValue={rate?.jobTypeId ?? ""} />
                              <Select label="When" name={`band${i}`} options={bandOptions} defaultValue={rate?.band ?? "standard"} />
                              <TextField label="Per hour" name={`rate${i}`} inputMode="decimal" defaultValue={rate ? Number(rate.hourlyRate).toFixed(2) : ""} />
                              <TextField label="Minimum, minutes" name={`minimum${i}`} inputMode="numeric" defaultValue={rate?.minimumMinutes ?? ""} />
                              <TextField label="In steps of, minutes" name={`increment${i}`} inputMode="numeric" defaultValue={rate?.incrementMinutes ?? ""} />
                            </div>
                          );
                        })}
                      </div>
                    </fieldset>
                    <fieldset>
                      <legend className="text-sm font-medium text-ink-700">Markup on materials, by what the part cost us</legend>
                      <div className="mt-2 grid gap-2 sm:grid-cols-4">
                        {Array.from({ length: MARKUP_ROWS }, (_, i) => {
                          const tier = card.terms.materialMarkup[i];
                          return (
                            <div key={i} className="space-y-1">
                              <TextField label="Cost up to (empty for above)" name={`upTo${i}`} inputMode="decimal"
                                         defaultValue={tier?.upToCost ? Number(tier.upToCost).toFixed(2) : ""} />
                              <TextField label="Markup, per cent" name={`markup${i}`} inputMode="decimal"
                                         defaultValue={tier ? String(Number(tier.percent) * 100) : ""} />
                            </div>
                          );
                        })}
                      </div>
                    </fieldset>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <TextField label="Trip charge per visit" name="tripCharge" inputMode="decimal"
                                 defaultValue={card.terms.tripCharge ? Number(card.terms.tripCharge).toFixed(2) : ""} />
                      <TextField label="Their standard hours start" name="standardStart" type="time" defaultValue={clockOf(card.terms.standardStartMinute)} />
                      <TextField label="and end" name="standardEnd" type="time" defaultValue={clockOf(card.terms.standardEndMinute)} />
                    </div>
                    <fieldset>
                      <legend className="text-sm font-medium text-ink-700">Their standard days</legend>
                      <div className="mt-1 flex flex-wrap gap-3 text-sm">
                        {DAY_NAMES.map((day, d) => (
                          <label key={day} className="inline-flex items-center gap-1">
                            <input type="checkbox" name={`day${d}`} defaultChecked={card.terms.standardDays.includes(d)} /> {day}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <TextArea label="Their holidays, as dates" name="holidays" rows={2} placeholder="2026-12-25"
                              defaultValue={card.terms.holidays.join("\n")} />
                  </ActionForm>
                </details>
              </>
            )}
          </div>
        ))}

        {prices && (
          <details className="mt-4 rounded-md border border-steel-200 p-4">
            <summary className="cursor-pointer text-sm font-medium">Add a rate card</summary>
            <ActionForm action={createCard} submit="Add the card" hidden={{ contractId: id }} className="mt-3 grid gap-3 sm:grid-cols-2">
              <TextField label="Name" name="name" required placeholder="2026 schedule" />
              <Select label="Whose schedule" name="authority" options={AUTHORITY_OPTIONS} />
              <TextField label="In force from" name="effectiveFrom" type="date" />
              <TextField label="Until" name="effectiveTo" type="date" />
            </ActionForm>
          </details>
        )}
      </section>

      <section aria-label="Their invoices" className="mt-10">
        <h2 className="text-base font-semibold">What {contract.customerName} owes</h2>
        {open.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">Nothing open.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {open.map((invoice) => (
              <li key={invoice.id as string} className="flex gap-3">
                <a href={`/invoices/${invoice.id}`} className="font-mono tabular-nums hover:underline">Invoice {invoice.number as number}</a>
                <Money value={invoice.balance as string} />
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-wrap items-start gap-4">
          {can(user.actor, "portal:grant") && (
            <ActionForm action={issuePayerLink} submit="Make a link to their invoices" hidden={{ customerId: contract.customerId }}
                        tone="quiet" className="space-y-2" />
          )}
          {can(user.actor, "invoice:send") && open.length > 0 && (
            <form method="post" action={`/contracts/payers/${contract.customerId}/export`} className="flex items-end gap-2">
              {full?.invoiceFormat ? (
                <input type="hidden" name="format" value={full.invoiceFormat} />
              ) : (
                <Select label="File" name="format" options={[{ value: "csv", label: "CSV" }, { value: "xml", label: "XML" }]} />
              )}
              <button type="submit" className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100">
                Download their open invoices{full?.invoiceFormat ? ` as ${full.invoiceFormat.toUpperCase()}` : ""}
              </button>
            </form>
          )}
        </div>
        <p className="mt-2 max-w-2xl text-xs text-ink-500">
          The file is for somebody to upload to their system. Nothing here
          connects to an EDI network or a facilities portal.
        </p>
      </section>
    </div>
  );
}
