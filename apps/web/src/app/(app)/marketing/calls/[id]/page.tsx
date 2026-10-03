import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { marketingReport, properties, NotFoundError } from "@opentradesos/api/services";
import { assertCan, can } from "@opentradesos/core";
import { Phone } from "@opentradesos/ui";
import { Facts, Fact, Crumb } from "@/components/Detail";
import { ActionForm, Select, TextArea, TextField } from "@/components/ActionForm";
import { formatIn } from "@/lib/dates";
import { bookFromCall } from "../../actions";
import { transcribeNow } from "./actions";

export const dynamic = "force-dynamic";

/** What a removed thing is called, in the singular, for "Removed before it was stored". */
const REDACTED: Record<string, string> = {
  card_number: "card number",
  card_security_code: "card security code",
  ssn: "social security number",
  bank_routing_number: "bank routing number",
  bank_account_number: "bank account number",
};

/**
 * A CALL, INTO A CUSTOMER AND A JOB
 *
 * Prefilled with what the call already says: the number that rang becomes the
 * customer's phone, and the job is credited to the campaign and channel of the
 * number they dialled. Nothing about the attribution is typed here, because
 * the call is better evidence than anybody's memory of it.
 *
 * Two ordinary steps rather than a special path: the customer is created the
 * way the new customer form creates one (and claims this call and any other
 * from that number), then the job is booked the way the new job form books one,
 * naming the call so the two are linked.
 */
export default async function CallPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  assertCan(user.actor, "job:write");
  const ctx = { actor: user.actor, db: getDb() };
  const { id } = await params;
  const call = await marketingReport.getCall(ctx, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const addresses = call.customerId
    ? (await properties.list(ctx, { limit: 50, customerId: call.customerId })).data
    : [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <Crumb href="/marketing/calls">Calls</Crumb>
      <h1 className="mt-1 text-xl font-semibold">
        A call from <Phone value={call.from} />
      </h1>
      <Facts>
        <Fact label="When">{formatIn(call.startedAt, user.organizationTimezone)}</Fact>
        <Fact label="Number dialled">{call.receivedOn ? <Phone value={call.receivedOn} /> : null}</Fact>
        <Fact label="Campaign">{call.campaignName}</Fact>
        <Fact label="Channel">{call.channelName}</Fact>
        <Fact label="What it was">{call.outcomeLabel}</Fact>
        <Fact label="Caller">{call.firstTimeCaller === true ? "First time" : call.firstTimeCaller === false ? "Called before" : null}</Fact>
        {call.menuChoices.length > 0 ? (
          <Fact label="What they pressed">
            {call.menuChoices.map((c) => `${c.key ? `${c.key} for ${c.label}` : c.label} in the ${c.menu} menu`).join(", then ")}
          </Fact>
        ) : null}
        {call.routedBecause ? <Fact label="Where it went">{call.routedBecause}</Fact> : null}
      </Facts>

      {/*
        The audio, when this product keeps it. A recording appears only for a
        call the recording check allowed and nobody has deleted; when one was
        asked for and refused, the refusal says so rather than leaving a gap.
      */}
      {call.hasRecording || call.hasVoicemail || call.recordingRefusal ? (
        <section className="mt-6 space-y-3" aria-label="Recording">
          {call.hasRecording ? (
            <div>
              <h2 className="text-sm font-medium">Recording</h2>
              <audio controls preload="none" src={`/marketing/calls/${call.id}/recording`} className="mt-1 w-full" />
            </div>
          ) : call.recordingRefusal ? (
            <p className="text-sm text-ink-700">Not recorded: {call.recordingRefusal.replace(/_/g, " ")}.</p>
          ) : null}
          {call.hasVoicemail ? (
            <div>
              <h2 className="text-sm font-medium">Voicemail</h2>
              <audio controls preload="none" src={`/marketing/calls/${call.id}/voicemail`} className="mt-1 w-full" />
            </div>
          ) : null}
        </section>
      ) : null}

      {/*
        The words, already redacted: a card number read out on the call was
        removed before they were stored, and the screen says how many were.
        Said plainly when the speech to text was unsure, because a transcript
        reads as fact and a misheard address is a van at the wrong house.
      */}
      {call.transcript.length > 0 || call.transcriptStatus || call.hasRecording || call.hasVoicemail ? (
        <section className="mt-6" aria-label="Transcript">
          <h2 className="text-sm font-medium">
            Transcript{call.transcriptSource === "voicemail" ? " of the voicemail" : call.transcriptSource === "recording" ? " of the recording" : ""}
          </h2>
          {call.transcript.length > 0 ? (
            <>
              {call.transcriptReliable === false ? (
                <p className="mt-1 text-sm text-amber-700">
                  The speech to text was unsure of parts of this. Listen before acting on an address or a number in it.
                </p>
              ) : null}
              {Object.keys(call.transcriptRedactions).length > 0 ? (
                <p className="mt-1 text-sm text-ink-500">
                  Removed before it was stored: {Object.entries(call.transcriptRedactions)
                    .map(([kind, n]) => `${n} ${REDACTED[kind] ?? kind.replace(/_/g, " ")}${n === 1 ? "" : "s"}`).join(", ")}.
                </p>
              ) : null}
              <ol className="mt-2 space-y-1.5 text-sm">
                {call.transcript.map((line, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="w-12 shrink-0 tabular-nums text-ink-500">{line.at}</span>
                    <span className="whitespace-pre-wrap">{line.text}</span>
                  </li>
                ))}
              </ol>
            </>
          ) : call.transcriptStatus === "pending" || call.transcriptStatus === "working" ? (
            <p className="mt-1 text-sm text-ink-700">Being written out. It appears here in a minute or two.</p>
          ) : call.transcriptStatus === "failed" ? (
            <p className="mt-1 text-sm text-ink-700">It could not be written out: {call.transcriptError}</p>
          ) : (
            <p className="mt-1 text-sm text-ink-700">Not written out.</p>
          )}
          {can(user.actor, "message:send") && (call.hasRecording || call.hasVoicemail)
            && call.transcriptStatus !== "pending" && call.transcriptStatus !== "working" && call.transcript.length === 0 ? (
              <ActionForm action={transcribeNow} submit="Write it out now" tone="quiet" hidden={{ id: call.id }} className="mt-2" />
            ) : null}
        </section>
      ) : null}

      {call.jobId ? (
        <p className="mt-6 text-sm">
          Already booked: <a href={`/jobs/${call.jobId}`} className="underline underline-offset-4">the job from this call</a>.
        </p>
      ) : (
        <section className="mt-8">
          <h2 className="text-base font-semibold">
            {call.customerId ? `Book a job for ${call.customerName}` : "Create customer and job from this call"}
          </h2>
          <p className="mt-1 text-sm text-ink-700">
            The job is credited to {[call.channelName, call.campaignName].filter(Boolean).join(", ") || "what this call is credited to"},
            from the call itself.
          </p>
          <ActionForm action={bookFromCall} submit={call.customerId ? "Book job" : "Create customer and job"}
                      hidden={{ callId: call.id, ...(call.customerId ? { customerId: call.customerId } : {}) }}
                      className="mt-4 space-y-4">
            {call.customerId ? (
              addresses.length === 0 ? (
                <p className="text-sm text-ink-700">
                  {call.customerName} has no address. <a href={`/customers/${call.customerId}`} className="underline underline-offset-4">Add one</a> first.
                </p>
              ) : (
                <Select label="Address" name="propertyId"
                        options={addresses.map((p) => ({ value: p.id, label: [p.addressLine1, p.city].filter(Boolean).join(", ") }))} />
              )
            ) : (
              <>
                <TextField label="Name" name="name" required autoComplete="off" />
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField label="Phone" name="phone" defaultValue={call.from} />
                  <TextField label="Email" name="email" type="email" />
                </div>
                <fieldset className="space-y-4 rounded-md border border-steel-200 p-3">
                  <legend className="px-1 text-sm font-medium">Where the work is</legend>
                  <TextField label="Street" name="line1" required />
                  <div className="grid gap-4 sm:grid-cols-3">
                    <TextField label="City" name="city" required />
                    <TextField label="State" name="state" required />
                    <TextField label="ZIP" name="postalCode" required inputMode="numeric" />
                  </div>
                </fieldset>
              </>
            )}
            <TextField label="Summary" name="summary" required maxLength={300} placeholder="AC tune up" />
            <TextArea label="Customer said" name="customerComplaint" maxLength={5000} />
          </ActionForm>
        </section>
      )}
    </div>
  );
}
