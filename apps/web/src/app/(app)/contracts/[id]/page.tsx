import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { contracts, contractEscalation, rateCards, jobs, properties, billing } from "@opentradesos/api/services";
import { can, rates, deadlines } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { Crumb } from "@/components/Detail";
import { Table, Th, Td } from "@/components/Table";
import { ActionForm, TextField, TextArea, Select } from "@/components/ActionForm";
import { LABOUR_ROWS, MARKUP_ROWS, clockOf, percentOf } from "@/lib/contract-forms";
import { ContractTermFields } from "../ContractTerms";
import { addSite, applyEscalation, createCard, issuePayerLink, setCardLines, setCardTerms, updateContractTerms } from "../actions";

export const dynamic = "force-dynamic";

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

      {rise && rise.rate && (
        <section aria-label="Annual escalation" className="mt-10">
          <h2 className="text-base font-semibold">Annual escalation</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-700">
            {rise.anniversary
              ? <>Rates rise by {percentOf(rise.rate)}% on each anniversary. Year {rise.contractYear} starts on {rise.anniversary}
                {rise.daysAway !== null && rise.daysAway >= 0 ? `, in ${rise.daysAway} days` : `, ${Math.abs(rise.daysAway ?? 0)} days ago`}.
                Applying it writes a new version of each card from that day; the current prices stay in force until the day before.</>
              : null}
            {rise.escalatedThrough ? ` Last risen on ${rise.escalatedThrough}.` : ""}
          </p>
          {rise.problem && <p className="mt-2 text-sm text-ink-700">{rise.problem}</p>}
          {rise.cards.map((card) => (
            <Table key={card.rateCardId} label={`${card.name} from ${rise.anniversary}`}
                   head={<><Th>{card.name}</Th><Th className="text-right">Now</Th><Th className="text-right">From {rise.anniversary}</Th></>}>
              {card.lines.map((line) => (
                <tr key={line.id}>
                  <Td>{line.description}</Td>
                  <Td className="text-right"><Money value={line.before} /></Td>
                  <Td className="text-right"><Money value={line.after} /></Td>
                </tr>
              ))}
              {card.labourRates.map((rate) => (
                <tr key={rate.id}>
                  <Td>{rates.BAND_LABEL[rate.band as rates.LabourBand] ?? rate.band} labour{rate.jobTypeName ? `, ${rate.jobTypeName}` : ""}, per hour</Td>
                  <Td className="text-right"><Money value={rate.before} /></Td>
                  <Td className="text-right"><Money value={rate.after} /></Td>
                </tr>
              ))}
              {card.tripCharge && (
                <tr>
                  <Td>Trip charge</Td>
                  <Td className="text-right"><Money value={card.tripCharge.before} /></Td>
                  <Td className="text-right"><Money value={card.tripCharge.after} /></Td>
                </tr>
              )}
            </Table>
          ))}
          {prices && rise.ready && rise.anniversary && (
            <ActionForm action={applyEscalation} submit={`Apply year ${rise.contractYear} prices`}
                        hidden={{ contractId: id, anniversary: rise.anniversary, rate: rise.rate }}
                        className="mt-3 flex flex-wrap items-center gap-3" />
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
