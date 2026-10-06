import type { ReactNode } from "react";
import { Chip } from "@opentradesos/ui";
import { Table, Th, Td, Empty } from "@/components/Table";

/**
 * The shapes this screen draws. Written out rather than imported, so a case the
 * service has not produced yet (a campaign cancelled mid-send, an audience that
 * overflowed, a recipient skipped for a reason nobody has seen) can be staged in
 * a test.
 */
export interface CampaignRow {
  id: string;
  name: string;
  channel: string;
  state: string;
  audienceInWords: string;
  utmCampaign: string | null;
  abTest?: boolean;
  scheduledFor: string | null;
  startedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  result: { selected: number; queued: number; skipped: number; skippedBy: Record<string, number> };
}

export interface RecipientRow {
  id: string;
  customerName: string | null;
  address: string;
  /** The half of an A/B test this person was given. */
  variant?: string;
  state: string;
  skipReason: string | null;
}

export interface Preview {
  count: number;
  overflow: boolean;
  inWords: string;
  pace: { firstBatch: number; days: number; secondsBetween: number | null; staged: boolean };
  sample: { customerId: string; name: string; address: string }[];
  /** The message as the first person on the list will read it. */
  rendered?: { for: string | null; body: string; subject: string | null } | null;
  /** Version B as the same person would read it, for an A/B test. */
  renderedB?: { for: string | null; body: string; subject: string | null } | null;
}

/** The results of an A/B test, as the service returns them. */
export interface AbResults {
  versions: {
    version: string; label: string; sent: number; skipped: number; clicks: number;
    replies: number | null; booked: number; jobs: number; revenue: string;
  }[];
  repliesKnown: boolean;
  untaggedClicks: number;
  measures: { measure: string; label: string; verdict: string; rateA: string | null; rateB: string | null; sentence: string }[];
  winner: string | null;
  headline: string;
}

/**
 * Whether this campaign has been through a send at all.
 *
 * Read off the timestamp rather than off the state name, because `cancelled` can
 * describe a campaign that was cancelled before it ever went and one cancelled
 * part way through, and only the second has recipients to explain.
 */
const hasGone = (campaign: CampaignRow) => campaign.startedAt !== null;

const STATE_TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  draft: "neutral", scheduled: "info", sending: "warning", sent: "success", cancelled: "danger",
};

/**
 * WHAT A SEND ACTUALLY DID, WHICH IS TWO NUMBERS AND A LIST OF REASONS
 *
 * Queued and skipped, never one total. The whole argument of this module is that
 * everybody the rules selected gets a row including the ones it would not send
 * to: "four hundred of your nine hundred customers have never been asked for
 * consent" is the fact an owner needs, and a screen reporting nine hundred sent
 * is the screen that hides it.
 */
export function Tally({ result }: { result: CampaignRow["result"] }) {
  const reasons = Object.entries(result.skippedBy).sort(([a], [b]) => a.localeCompare(b));
  return (
    <>
      <span className="tabular-nums">{result.queued} queued</span>
      {result.skipped > 0 ? (
        <span className="tabular-nums text-amber-700">, {result.skipped} not sent</span>
      ) : null}
      {reasons.length > 0 ? (
        <span className="block text-xs text-ink-700">
          {reasons.map(([reason, n]) => `${n} ${REASON[reason] ?? reason}`).join(", ")}
        </span>
      ) : null}
    </>
  );
}

/**
 * Why a recipient was not sent to, in the words of the thing that stopped it.
 *
 * Each of these is a different conversation. "Never asked" is a consent
 * collection problem the office can fix; "replied STOP" is one they must not
 * touch. A single "skipped" would make them look like the same thing, and the
 * whole value of this screen is that it does not.
 *
 * The keys are `comms.SendRefusal`, which is where the refusal is decided, plus
 * `empty` from the sender. Anything unrecognised falls through to the raw value
 * rather than to "skipped", so a reason this map has not caught up with is
 * visible rather than hidden.
 */
const REASON: Record<string, string> = {
  no_consent: "never asked for consent",
  consent_revoked: "withdrew consent",
  suppressed: "replied STOP",
  channel_not_registered: "no registered sending number",
  quiet_hours: "inside quiet hours",
  empty: "nothing to send",
};

export function Campaigns({
  campaigns, controls,
}: {
  campaigns: CampaignRow[];
  controls?: ((campaign: CampaignRow) => ReactNode) | undefined;
}) {
  if (campaigns.length === 0) {
    return (
      <Empty title="No campaigns yet">
        A campaign goes to the list you already own. Pick the rules, read the sentence they make,
        and nothing is sent until you press send.
      </Empty>
    );
  }
  return (
    <Table label="Campaigns" head={
      <><Th>Campaign</Th><Th>Who</Th><Th>Result</Th>{controls ? <Th /> : null}</>
    }>
      {campaigns.map((campaign) => (
        <tr key={campaign.id}>
          <Td>
            <span className="font-medium">{campaign.name}</span>
            <span className="ml-2"><Chip tone={STATE_TONE[campaign.state] ?? "neutral"}>
              {campaign.state}
            </Chip></span>
            <span className="block text-xs text-ink-500">
              {campaign.channel === "sms" ? "Text" : "Email"}
              {campaign.abTest ? " · two versions" : ""}
              {campaign.utmCampaign ? ` · ${campaign.utmCampaign}` : ""}
            </span>
            {campaign.cancelledAt ? (
              <span className="block text-xs text-red-600">
                Cancelled{campaign.cancellationReason ? `: ${campaign.cancellationReason}` : ""}
              </span>
            ) : null}
          </Td>
          {/*
            The audience as a sentence, from core rather than rebuilt here. The
            difference between two years and two months is one character in a
            form and a factor of twelve in the bill, so the sentence is the
            thing somebody checks before pressing send.
          */}
          <Td className="text-ink-700">{campaign.audienceInWords}</Td>
          <Td>
            {/*
              THREE STATES, NOT TWO. A campaign with no recipients has either not
              gone yet or has gone and matched nobody, and those are different
              facts: the first is a thing to press, the second is a thing to fix
              in the rules. The first version of this showed "Not sent yet" for
              both, so a campaign marked `sent` sat beside a result saying it had
              not been, which a browser test caught.
            */}
            {campaign.result.selected > 0
              ? <Tally result={campaign.result} />
              : hasGone(campaign)
                ? <span className="text-amber-700">Nobody matched the rules</span>
                : <span className="text-ink-500">Not sent yet</span>}
          </Td>
          {controls ? <Td>{controls(campaign)}</Td> : null}
        </tr>
      ))}
    </Table>
  );
}

/**
 * What the rules select, read back before anything is sent.
 *
 * The count, the sentence, and how long it will take. An overflow is said out
 * loud rather than silently truncated: somebody who meant to reach thirty
 * thousand people needs to know this will reach the first twenty five thousand
 * by name order, which is not a random sample of their list.
 */
export function Audience({ preview }: { preview: Preview }) {
  return (
    <div className="mt-3 rounded-md border border-steel-200 bg-canvas p-4">
      {/*
        The count, then the sentence. `describeAudience` returns a whole sentence
        of its own ("Customers who were last served..."), so this does not wrap it
        in a second one: the first version read "412 customers who Customers who
        were last served", which a browser test caught.
      */}
      <p className="text-sm">
        <span className="text-xl font-semibold tabular-nums">
          {preview.count.toLocaleString("en-US")}
        </span>
        {" "}
        {preview.count === 1 ? "customer." : "customers."}{" "}
        <span className="text-ink-700">{preview.inWords}</span>
      </p>

      {preview.overflow ? (
        <p className="mt-2 text-sm text-amber-700">
          More than one campaign will take. This will reach the first {preview.count.toLocaleString("en-US")}{" "}
          by name order, which is not a random sample of your list. Narrow the rules.
        </p>
      ) : null}

      {/*
        The carrier's own cap, said in DAYS rather than in a number of batches.
        An owner reading "3 batches" does not know whether that is three minutes
        or three days, and under a 10DLC daily cap it is days. A staged send with
        a cap of zero is the one case worth saying out loud on its own: the
        carrier has allowed nothing, so pressing send sends nothing.
      */}
      {preview.pace.staged && preview.pace.firstBatch === 0 ? (
        <p className="mt-2 text-sm text-red-600">
          The carrier's daily cap is zero, so this would send to nobody. That is a registration
          problem rather than an audience problem.
        </p>
      ) : preview.pace.days > 1 ? (
        <p className="mt-2 text-sm text-ink-700">
          The carrier's daily cap takes this over {preview.pace.days} days,{" "}
          {preview.pace.firstBatch.toLocaleString("en-US")} a day. Once it has started, the rest goes
          out a day's worth at a time on its own, outside quiet hours.
        </p>
      ) : null}

      {/*
        THE MESSAGE AS THE FIRST PERSON WILL READ IT, merge fields filled in by
        the renderer the send uses. "Hi {{ customer.firstName }}" is a template;
        "Hi Maria" is what somebody checks before four thousand go out, and it
        is the version that shows a field that came out empty.
      */}
      {preview.rendered ? (
        <figure className="mt-3 max-w-xl rounded border border-steel-200 bg-steel-100 p-3">
          <figcaption className="text-xs font-medium text-ink-700">
            {preview.renderedB ? "Version A. " : ""}
            {preview.rendered.for ? `As ${preview.rendered.for} will read it` : "As it will read"}
          </figcaption>
          {preview.rendered.subject ? (
            <p className="mt-1 text-sm font-medium">{preview.rendered.subject}</p>
          ) : null}
          <p className="mt-1 whitespace-pre-wrap text-sm text-ink-900">{preview.rendered.body}</p>
        </figure>
      ) : null}
      {preview.renderedB ? (
        <figure className="mt-3 max-w-xl rounded border border-steel-200 bg-steel-100 p-3">
          <figcaption className="text-xs font-medium text-ink-700">
            Version B. {preview.renderedB.for ? `As ${preview.renderedB.for} will read it` : "As it will read"}.
            Half the list gets each, chosen at random.
          </figcaption>
          {preview.renderedB.subject ? (
            <p className="mt-1 text-sm font-medium">{preview.renderedB.subject}</p>
          ) : null}
          <p className="mt-1 whitespace-pre-wrap text-sm text-ink-900">{preview.renderedB.body}</p>
        </figure>
      ) : null}

      {preview.sample.length === 0 ? (
        <p className="mt-3 text-sm text-ink-500">
          Nobody. Either the rules are too narrow, or nobody on this list has an address on this
          channel.
        </p>
      ) : (
        <>
          <p className="mt-3 text-xs font-medium text-ink-700">For example</p>
          <ul className="mt-1 space-y-0.5 text-sm text-ink-700">
            {preview.sample.map((candidate) => (
              <li key={candidate.customerId}>
                {candidate.name} <span className="text-ink-500">{candidate.address}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * Who it went to and who it did not.
 *
 * The skipped half is the useful half, so it is not a separate screen and not
 * collapsed. A reason per row, because "skipped" tells an office nothing they
 * can act on.
 */
export function Recipients({ recipients }: { recipients: RecipientRow[] }) {
  if (recipients.length === 0) {
    return <Empty title="Nobody yet">Recipients appear when the campaign is sent.</Empty>;
  }
  return (
    <Table label="Recipients" head={<><Th>Customer</Th><Th>Address</Th>{recipients.some((r) => r.variant && r.variant !== "a") ? <Th>Version</Th> : null}<Th>What happened</Th></>}>
      {recipients.map((recipient) => (
        <tr key={recipient.id} className={recipient.state === "skipped" ? "text-ink-700" : undefined}>
          <Td>{recipient.customerName ?? "a customer"}</Td>
          <Td><span className="font-mono text-xs">{recipient.address}</span></Td>
          {recipients.some((r) => r.variant && r.variant !== "a")
            ? <Td>{recipient.variant === "b" ? "B" : "A"}</Td> : null}
          <Td>
            {recipient.state === "skipped" ? (
              <span className="text-amber-700">
                Not sent: {REASON[recipient.skipReason ?? ""] ?? recipient.skipReason ?? "no reason recorded"}
              </span>
            ) : (
              <Chip tone={recipient.state === "sent" ? "success" : "info"}>{recipient.state}</Chip>
            )}
          </Td>
        </tr>
      ))}
    </Table>
  );
}

/**
 * THE TWO VERSIONS OF AN A/B TEST, SIDE BY SIDE
 *
 * The counts come first and are always shown. A winner is named only when the
 * service says the gap is more than luck would explain, and what it says
 * otherwise is "no clear winner" with the counts, because two halves of a list
 * differ by a few people even when the words make no difference at all.
 */
export function AbTestResults({ results }: { results: AbResults }) {
  const [a, b] = results.versions;
  if (!a || !b) return null;
  const rows: { label: string; a: string; b: string }[] = [
    { label: "Sent to", a: String(a.sent), b: String(b.sent) },
    { label: "Clicked the link", a: String(a.clicks), b: String(b.clicks) },
    {
      label: "Replied",
      a: a.replies === null ? "Not known" : String(a.replies),
      b: b.replies === null ? "Not known" : String(b.replies),
    },
    { label: "Booked a job", a: String(a.booked), b: String(b.booked) },
  ];
  return (
    <div className="mt-3 max-w-2xl">
      <p className={`rounded border p-3 text-sm ${results.winner ? "border-green-300 bg-green-50" : "border-steel-200 bg-steel-100"}`}>
        {results.headline}
      </p>
      <Table label="The two versions" head={<><Th>People</Th><Th>Version A</Th><Th>Version B</Th></>}>
        {rows.map((row) => (
          <tr key={row.label}>
            <Td>{row.label}</Td>
            <Td className="tabular-nums">{row.a}</Td>
            <Td className="tabular-nums">{row.b}</Td>
          </tr>
        ))}
      </Table>
      <ul className="mt-3 space-y-2 text-sm text-ink-700">
        {results.measures.map((measure) => (
          <li key={measure.measure}>
            <span className="font-medium text-ink-900">{measure.label}.</span> {measure.sentence}
          </li>
        ))}
      </ul>
      {!results.repliesKnown ? (
        <p className="mt-2 text-xs text-ink-500">
          Replies to an email are not seen unless your mail is set up to bring them back here, so they are
          left out of the comparison.
        </p>
      ) : null}
      {results.untaggedClicks > 0 ? (
        <p className="mt-2 text-xs text-ink-500">
          {results.untaggedClicks} {results.untaggedClicks === 1 ? "person" : "people"} followed the link
          without a version on it, so they are in neither column. Put the link tag in the message to count
          every click.
        </p>
      ) : null}
    </div>
  );
}
