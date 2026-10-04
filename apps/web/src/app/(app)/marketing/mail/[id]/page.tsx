import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { directMail } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { Table, Th, Td, PageHeader } from "@/components/Table";
import { Crumb, Facts, Fact } from "@/components/Detail";
import { ActionForm } from "@/components/ActionForm";
import { formatIn } from "@/lib/dates";
import { cancelMailing, sendMailing } from "../actions";

export const dynamic = "force-dynamic";

/**
 * ONE MAILING: WHO, WHAT IT LOOKS LIKE, AND WHAT IT BROUGHT
 *
 * Before it goes: the audience as one sentence, how many can be posted and
 * how many have no address, what it will cost, the return address and the
 * number it will print, and both sides as the first person will get them, in
 * a frame that runs nothing. There is no "are you sure": the sentence and the
 * cost are the confirmation, as they are for texts and emails.
 *
 * After: every piece with its own address and what the printer said, and the
 * results against the cost: people who opened their address, calls to its
 * number, and jobs credited to its tracking campaign.
 */
export default async function MailingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const mailing = await directMail.get(ctx, { id }).catch(() => null);
  if (!mailing) notFound();
  const writes = can(user.actor, "campaign:write");
  const draft = mailing.state === "draft";
  const [preview, pieces] = await Promise.all([
    draft ? directMail.preview(ctx, { id }).catch((error: Error) => ({ error: error.message })) : Promise.resolve(null),
    draft ? Promise.resolve([]) : directMail.pieces(ctx, { id, limit: 500 }),
  ]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/marketing/mail">Direct mail</Crumb>
      <PageHeader title={mailing.name} />
      <p className="mt-1 text-sm text-ink-700">
        {mailing.kind === "letter" ? "A letter" : `A ${mailing.size ?? "4x6"} postcard`}
        {mailing.sentence ? ` to ${mailing.sentence}` : ""}, credited to {mailing.trackingCampaign ?? "its tracking campaign"}.
      </p>

      {preview && "error" in preview ? <p className="mt-4 text-sm text-red-600">{preview.error}</p> : null}
      {preview && !("error" in preview) ? (
        <section className="mt-6" aria-labelledby="before-heading">
          <h2 id="before-heading" className="text-base font-semibold">Before it goes</h2>
          <p className="mt-2 text-sm" role="note">
            {preview.postable} {preview.postable === 1 ? "customer" : "customers"} {preview.sentence}, at an estimated{" "}
            <Money value={preview.estimatedCost} />.
            {preview.noAddress > 0 ? ` ${preview.noAddress} more have no address that can be posted to and will be skipped.` : ""}
            {preview.overflow ? " More are selected than one mailing takes; it goes to the first twenty five thousand by name, which is not a sample." : ""}
          </p>
          <Facts>
            <Fact label="Number it prints">{preview.trackingPhone ?? "No tracking number on its campaign; your main number is printed"}</Fact>
            <Fact label="Return address">
              {preview.returnAddress
                ? [preview.returnAddress.line1, preview.returnAddress.city, preview.returnAddress.state, preview.returnAddress.postalCode].join(", ")
                : "None. Add the company's address under Settings, Company."}
            </Fact>
          </Facts>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {/*
              The design is HTML written in the office, filled with a
              customer's name. Shown in a frame with every permission taken
              away, so nothing in it runs here.
            */}
            <iframe title="Front, as the first person gets it" sandbox="" srcDoc={preview.front}
                    className="h-64 w-full rounded border border-steel-200 bg-canvas" />
            {preview.back !== null ? (
              <iframe title="Back, as the first person gets it" sandbox="" srcDoc={preview.back}
                      className="h-64 w-full rounded border border-steel-200 bg-canvas" />
            ) : null}
          </div>
          {preview.sample.length > 0 ? (
            <Table label="The first on the list" head={<><Th>Who</Th><Th>Posted to</Th></>}>
              {preview.sample.map((s) => (
                <tr key={s.customerId}>
                  <Td>{s.name}</Td>
                  <Td>{s.postable ? s.address : <Chip tone="warning">No address that can be posted to</Chip>}</Td>
                </tr>
              ))}
            </Table>
          ) : null}
          {writes ? (
            <ActionForm action={sendMailing} submit="Send to the printer" hidden={{ id }} className="mt-4" />
          ) : null}
        </section>
      ) : null}

      {!draft ? (
        <>
          <section className="mt-6" aria-labelledby="results-heading">
            <h2 id="results-heading" className="text-base font-semibold">What it brought</h2>
            <Facts>
              <Fact label="Pieces sent">{mailing.pieces.sent} of {mailing.pieces.pieces}</Fact>
              <Fact label="Opened their address">{mailing.results.visited}</Fact>
              <Fact label="Calls to its number">{mailing.results.calls}</Fact>
              <Fact label="Jobs credited to it">{mailing.results.jobs}</Fact>
              <Fact label="Revenue from those jobs"><Money value={mailing.results.revenue} /></Fact>
              <Fact label="What it cost"><Money value={mailing.results.spend} /></Fact>
            </Facts>
            {writes && mailing.state === "sending" ? (
              <div className="mt-4 flex flex-wrap gap-3">
                <ActionForm action={sendMailing} submit="Send the next batch now" tone="quiet" hidden={{ id }} className="" />
                <ActionForm action={cancelMailing} submit="Stop the rest" tone="danger" hidden={{ id }} className="" />
              </div>
            ) : null}
          </section>
          <section className="mt-8">
            <Table label="Pieces" head={<><Th>Who</Th><Th>Posted to</Th><Th>Their address</Th><Th>Where it stands</Th><Th>Visits</Th></>}>
              {pieces.map((p) => (
                <tr key={p.id}>
                  <Td><a href={`/customers/${p.customerId}`} className="underline underline-offset-4">{p.name}</a></Td>
                  <Td>{p.address}</Td>
                  <Td className="font-mono text-xs">{p.url}</Td>
                  <Td>
                    {p.status}
                    {p.expectedDeliveryOn ? <span className="block text-xs text-ink-500">Expected {p.expectedDeliveryOn}</span> : null}
                    {p.reason ? <span className="block text-xs text-ink-700">{p.reason}</span> : null}
                  </Td>
                  <Td>
                    {p.visits}
                    {p.firstVisitedAt ? <span className="block text-xs text-ink-500">First {formatIn(p.firstVisitedAt, user.organizationTimezone)}</span> : null}
                  </Td>
                </tr>
              ))}
            </Table>
          </section>
        </>
      ) : null}
    </div>
  );
}
