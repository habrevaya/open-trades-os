import { Chip } from "@opentradesos/ui";

export interface ConsentEntry {
  purpose: string;
  channel: string;
  state: string;
  method: string;
  proofText: string | null;
  capturedAt: string;
  current: boolean;
}

const METHOD: Record<string, string> = {
  web_form: "on a form", verbal: "on a call", written: "in writing", sms_reply: "by text",
  checkout: "at checkout", imported: "imported", api: "through an integration",
};

/**
 * What this number has agreed to, beside the conversation it is about.
 *
 * Two purposes, said separately, because the whole consent model turns on
 * the difference: a reply about booked work needs nothing on record, an
 * offer needs a grant with the wording. A STOP outranks both and is said
 * first, because it is the one thing nobody in the office can undo.
 */
export function ConsentSummary({
  entries, suppressed, customerId,
}: {
  entries: ConsentEntry[];
  suppressed: boolean;
  customerId: string | null;
}) {
  const current = (purpose: string) =>
    entries.find((e) => e.current && e.purpose === purpose && (e.channel === "sms" || e.channel === "mms"));
  const marketing = current("marketing");
  const transactional = current("transactional");

  return (
    <section aria-label="Consent" className="mt-6 rounded-md border border-steel-200 bg-canvas p-4 text-sm">
      <h2 className="text-xs uppercase tracking-[0.08em] text-ink-500">Consent for this number</h2>
      {suppressed ? (
        <p className="mt-2 flex flex-wrap items-center gap-2">
          <Chip tone="danger">Replied STOP</Chip>
          <span className="text-ink-700">Nothing can be texted until they text START.</span>
        </p>
      ) : (
        <dl className="mt-2 grid gap-2 sm:grid-cols-2">
          <div>
            <dt className="text-ink-500">About booked work</dt>
            <dd className="mt-0.5">
              {transactional?.state === "revoked"
                ? <Chip tone="warning">Withdrawn</Chip>
                : <Chip tone="success">Allowed</Chip>}
            </dd>
          </div>
          <div>
            <dt className="text-ink-500">Offers</dt>
            <dd className="mt-0.5">
              {marketing?.state === "granted"
                ? <Chip tone="success">Agreed {METHOD[marketing.method] ?? ""}</Chip>
                : marketing?.state === "revoked"
                  ? <Chip tone="warning">Withdrawn</Chip>
                  : <Chip tone="neutral">Not agreed</Chip>}
              {marketing?.state === "granted" && marketing.proofText && (
                <span className="mt-1 block text-xs text-ink-500">&ldquo;{marketing.proofText}&rdquo;</span>
              )}
            </dd>
          </div>
        </dl>
      )}
      {customerId && (
        <p className="mt-3 text-xs text-ink-500">
          Record or withdraw consent on{" "}
          <a href={`/customers/${customerId}`} className="underline underline-offset-4">the customer&apos;s page</a>.
        </p>
      )}
    </section>
  );
}
