import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { directMail, acquisition } from "@opentradesos/api/services";
import { can, directMail as dm } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { ActionForm, TextArea, TextField } from "@/components/ActionForm";
import { LeadSourceSelect } from "@/components/LeadSourceSelect";
import { RuleBoxes } from "../campaigns/RuleBoxes";
import { createMailing } from "./actions";

export const dynamic = "force-dynamic";

/**
 * DIRECT MAIL
 *
 * Every mailing with how many went and how many people opened their own
 * address, and a new one: who (the same rules as texts and emails), what it
 * says on each side, which tracking campaign it is credited to (its tracking
 * number is the one printed), what a piece costs, and what the personal page
 * says to the person who opens it.
 */
const STATE: Record<string, { label: string; tone: "neutral" | "info" | "success" | "warning" }> = {
  draft: { label: "Draft", tone: "neutral" },
  sending: { label: "Going to the printer", tone: "info" },
  sent: { label: "Sent", tone: "success" },
  cancelled: { label: "Cancelled", tone: "warning" },
};

const FRONT = `<div style="padding:0.4in;font-family:sans-serif">
  <h1>{{ customer.firstName }}, is your furnace ready for winter?</h1>
  <p>{{ company.name }} tune ups, this month only.</p>
</div>`;
const BACK = `<div style="padding:0.4in;font-family:sans-serif;width:2.5in">
  <p>Book at {{ mail.url }}</p>
  <p>or call {{ mail.phone }}</p>
</div>`;

export default async function MailPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const [mailings, channels] = await Promise.all([directMail.list(ctx), acquisition.channelOptions(ctx)]);
  const writes = can(user.actor, "campaign:write");

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Direct mail" count={mailings.length} />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Postcards and letters to your own customers, printed and posted by your mail house. Every piece carries the
        mailing&apos;s tracking number and its own web address and QR code, so a call or a visit from it is credited to the
        mailing, and what it cost is recorded as spend.
      </p>

      {mailings.length === 0 ? (
        <Empty title="No mailings yet">Draft one below.</Empty>
      ) : (
        <Table label="Mailings" head={<><Th>Mailing</Th><Th>What</Th><Th>Where it stands</Th><Th>Sent</Th><Th>Opened their address</Th></>}>
          {mailings.map((m) => (
            <tr key={m.id}>
              <Td>
                <a href={`/marketing/mail/${m.id}`} className="font-medium underline underline-offset-4">{m.name}</a>
                {m.trackingCampaign ? <span className="block text-xs text-ink-500">Credited to {m.trackingCampaign}</span> : null}
              </Td>
              <Td>{m.kind === "letter" ? "Letter" : `Postcard, ${m.size ?? "4x6"}`}</Td>
              <Td><Chip tone={STATE[m.state]?.tone ?? "neutral"}>{STATE[m.state]?.label ?? m.state}</Chip></Td>
              <Td>{m.sent}</Td>
              <Td>{m.visited}</Td>
            </tr>
          ))}
        </Table>
      )}

      {writes ? (
        <section className="mt-10 max-w-3xl">
          <h2 className="text-base font-semibold">Draft a mailing</h2>
          <ActionForm action={createMailing} submit="Save the draft" className="mt-3 space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField label="Name" name="name" required placeholder="Fall furnace tune up" />
              <label className="block" htmlFor="mail-kind">
                <span className="text-sm font-medium text-ink-700">Postcard or letter</span>
                <select id="mail-kind" name="kind" className="mt-1 h-9 w-full rounded border border-steel-300 px-2 text-sm">
                  <option value="postcard">Postcard</option>
                  <option value="letter">Letter</option>
                </select>
              </label>
              <label className="block" htmlFor="mail-size">
                <span className="text-sm font-medium text-ink-700">Postcard size</span>
                <select id="mail-size" name="size" className="mt-1 h-9 w-full rounded border border-steel-300 px-2 text-sm">
                  {dm.POSTCARD_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                </select>
              </label>
            </div>
            <RuleBoxes legend="Who it goes to" />
            <LeadSourceSelect options={channels} name="tracking" id="mail-tracking" label="Credit responses to"
                              help="Choose a tracking campaign, whose tracking number is printed on it. Leave it and one is made under Direct mail with this mailing's name." />
            <TextArea label="Front (or the letter), as HTML" name="front" rows={6} required defaultValue={FRONT} />
            <TextArea label="Back, as HTML (postcards only)" name="back" rows={5} defaultValue={BACK} />
            <p className="text-xs text-ink-500">
              It can fill in {dm.MAIL_FIELDS.map((f) => `{{ ${f.key} }}`).join(", ")}. {"{{ mail.url }}"} has to be on it somewhere a
              person can type it; a QR code to the same address is printed on the back as well.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Price per piece, from your mail house's price list" name="pricePerPiece" inputMode="decimal" placeholder="0.72" />
              <TextField label="Headline on their personal page (optional)" name="landingHeadline" />
            </div>
            <TextArea label="What their personal page says (optional)" name="landingBody" rows={3} />
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
