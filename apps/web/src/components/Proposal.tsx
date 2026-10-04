import { Money } from "@opentradesos/ui";
import { formatDay, formatIn } from "@/lib/dates";

/** What `proposals.proposal` and `proposals.proposalForToken` return. */
export interface ProposalData {
  company: {
    name: string; legalName: string | null;
    color: string | null; on: string | null; text: string | null;
    hasLogo: boolean; version: number; timezone: string;
  };
  number: number;
  title: string | null;
  status: string;
  issuedOn: string | null;
  expiresOn: string | null;
  decidedAt: string | null;
  signerName: string | null;
  selectedOptionId: string | null;
  customerName: string;
  propertyAddress: string;
  terms: string | null;
  options: {
    id: string; name: string; description: string | null;
    tier: "Good" | "Better" | "Best" | null; isRecommended: boolean;
    subtotal: string; discountTotal: string; taxTotal: string; total: string; optionalTotal: string;
    lines: {
      id: string; name: string; description: string | null; quantity: string; unitPrice: string;
      lineTotal: string; discountAmount: string; memberDiscountAmount: string; memberPlan: string | null;
      isOptional: boolean; isSelected: boolean;
    }[];
  }[];
}

const quantity = (value: string) => {
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
};

/**
 * A PROPOSAL, AS A DOCUMENT
 *
 * Shared by the office and the customer's own link, so the two can never
 * show different numbers, and laid out for paper as much as for a screen:
 * the company first, who it is for, the options side by side so the
 * customer compares them across rather than scrolling between them, the
 * terms, and a line to sign.
 *
 * THE COMPANY'S COLOUR IS A VARIABLE, set on the article from Branding, so a
 * company that never chose one gets the product's own ink and nothing reads
 * as broken. The recommended option carries it, because that is the one the
 * company wants the eye to land on.
 *
 * Nothing here can show cost: the document it draws was built without it.
 */
export function ProposalView({ proposal, logoSrc, timezone }: {
  proposal: ProposalData;
  /** Where the logo is served from for this reader, or nothing when the company has none. */
  logoSrc: string | null;
  timezone: string;
}) {
  const palette = {
    "--brand": proposal.company.color ?? "#111827",
    "--brand-on": proposal.company.on ?? "#ffffff",
    "--brand-text": proposal.company.text ?? proposal.company.color ?? "#111827",
  } as React.CSSProperties;
  const approved = proposal.status === "approved" || proposal.status === "converted";
  const columns = proposal.options.length >= 3
    ? "md:grid-cols-3 print:grid-cols-3"
    : proposal.options.length === 2 ? "md:grid-cols-2 print:grid-cols-2" : "";

  return (
    <article aria-label="Proposal" style={palette} className="space-y-8 bg-canvas text-ink-900">
      <header className="flex flex-wrap items-start justify-between gap-6 border-b-4 pb-5"
              style={{ borderColor: "var(--brand)" }}>
        <div className="flex items-center gap-4">
          {logoSrc ? (
            <img src={logoSrc} alt={proposal.company.name} className="h-14 max-w-[220px] object-contain" />
          ) : null}
          <div>
            <p className="text-lg font-semibold" style={{ color: "var(--brand-text)" }}>{proposal.company.name}</p>
            {proposal.company.legalName && proposal.company.legalName !== proposal.company.name ? (
              <p className="text-xs text-ink-500">{proposal.company.legalName}</p>
            ) : null}
          </div>
        </div>
        <dl className="text-right text-sm">
          <dt className="sr-only">Estimate number</dt>
          <dd className="text-xl font-semibold">Proposal <span className="font-mono tabular-nums">#{proposal.number}</span></dd>
          {proposal.issuedOn ? (
            <><dt className="sr-only">Written</dt><dd className="text-ink-700">Written {formatDay(proposal.issuedOn, timezone)}</dd></>
          ) : null}
          {proposal.expiresOn ? (
            <><dt className="sr-only">Good until</dt><dd className="text-ink-700">Good until {formatDay(proposal.expiresOn, timezone)}</dd></>
          ) : null}
        </dl>
      </header>

      <section aria-label="Prepared for" className="flex flex-wrap justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.08em] text-ink-500">Prepared for</p>
          <p className="mt-1 font-medium">{proposal.customerName}</p>
          <p className="text-sm text-ink-700">{proposal.propertyAddress}</p>
        </div>
        {proposal.title ? (
          <div className="max-w-md text-right">
            <p className="text-xs uppercase tracking-[0.08em] text-ink-500">For</p>
            <p className="mt-1 font-medium">{proposal.title}</p>
          </div>
        ) : null}
      </section>

      <section aria-label="Options" className={`grid gap-4 ${columns}`}>
        {proposal.options.map((option) => {
          const base = option.lines.filter((l) => !l.isOptional);
          const extras = option.lines.filter((l) => l.isOptional);
          const chosen = proposal.selectedOptionId === option.id;
          return (
            <div key={option.id} aria-label={option.name}
                 className="flex break-inside-avoid flex-col rounded-md border-2 border-steel-200 p-4"
                 style={option.isRecommended || chosen ? { borderColor: "var(--brand)" } : undefined}>
              <div className="flex min-h-[1.5rem] flex-wrap items-center gap-2">
                {option.tier ? (
                  <span className="rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.08em]"
                        style={{ background: "var(--brand)", color: "var(--brand-on)" }}>
                    {option.tier}
                  </span>
                ) : null}
                {option.isRecommended ? <span className="text-xs font-medium" style={{ color: "var(--brand-text)" }}>Recommended</span> : null}
                {chosen && approved ? <span className="text-xs font-medium text-green-700">Chosen</span> : null}
              </div>
              <h2 className="mt-2 text-base font-semibold">{option.name}</h2>
              {option.description ? <p className="mt-1 text-sm text-ink-700">{option.description}</p> : null}

              <ul className="mt-3 flex-1 space-y-2 text-sm">
                {base.map((line) => (
                  <li key={line.id}>
                    <div className="flex justify-between gap-3">
                      <span>
                        {line.name}
                        {Number(line.quantity) !== 1 ? <span className="text-ink-500"> × {quantity(line.quantity)}</span> : null}
                      </span>
                      <Money value={line.lineTotal} />
                    </div>
                    {line.description ? <p className="text-xs text-ink-500">{line.description}</p> : null}
                    <Saving line={line} />
                  </li>
                ))}
              </ul>

              {extras.length > 0 ? (
                <div className="mt-3 border-t border-steel-200 pt-2">
                  <p className="text-xs uppercase tracking-[0.08em] text-ink-500">Add if you like</p>
                  <ul className="mt-1 space-y-1 text-sm">
                    {extras.map((line) => (
                      <li key={line.id} className="flex justify-between gap-3">
                        <span>
                          {line.name}
                          {line.isSelected ? <span className="ml-1 text-xs text-green-700">(included)</span> : null}
                        </span>
                        <Money value={line.lineTotal} muted={!line.isSelected} />
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <dl className="mt-4 space-y-0.5 border-t border-steel-200 pt-3 text-sm">
                <div className="flex justify-between"><dt className="text-ink-500">Subtotal</dt><dd><Money value={option.subtotal} /></dd></div>
                {Number(option.discountTotal) > 0 ? (
                  <div className="flex justify-between"><dt className="text-ink-500">Discount</dt><dd><Money value={`-${option.discountTotal}`} /></dd></div>
                ) : null}
                {Number(option.taxTotal) > 0 ? (
                  <div className="flex justify-between"><dt className="text-ink-500">Tax</dt><dd><Money value={option.taxTotal} /></dd></div>
                ) : null}
                <div className="flex justify-between pt-1 text-base font-semibold"><dt>Total</dt><dd><Money value={option.total} /></dd></div>
              </dl>
            </div>
          );
        })}
      </section>

      {proposal.terms ? (
        <section aria-label="Terms" className="break-inside-avoid">
          <h2 className="text-sm font-semibold">Terms</h2>
          <p className="mt-1 whitespace-pre-line text-sm text-ink-700">{proposal.terms}</p>
        </section>
      ) : null}

      <section aria-label="Signature" className="break-inside-avoid">
        {approved && proposal.signerName ? (
          <p className="text-sm">
            Approved by <span className="font-medium">{proposal.signerName}</span>
            {proposal.decidedAt
              ? ` on ${formatIn(proposal.decidedAt, timezone, { month: "long", day: "numeric", year: "numeric" })}`
              : ""}.
          </p>
        ) : (
          <>
            {/*
              Lines to sign on paper, for the proposal left on a kitchen
              table. Signing the link does the same thing and records it.
            */}
            <p className="text-sm text-ink-700">
              To go ahead, choose an option and sign below, or approve it from the link you were sent.
            </p>
            <div className="mt-8 grid gap-8 sm:grid-cols-3 print:grid-cols-3">
              {["Option chosen", "Signature", "Date"].map((label) => (
                <div key={label} className="border-t border-ink-900 pt-1 text-xs text-ink-500">{label}</div>
              ))}
            </div>
          </>
        )}
      </section>
    </article>
  );
}

/** Never silently: what came off a line, and the plan that took it off. */
function Saving({ line }: { line: ProposalData["options"][number]["lines"][number] }) {
  const member = Number(line.memberDiscountAmount);
  const other = Number(line.discountAmount) - member;
  if (member <= 0 && other <= 0) return null;
  const gross = Number(line.lineTotal) === 0 && member > 0;
  return (
    <p className="text-xs text-ink-500">
      {member > 0 ? (
        gross
          ? <>Waived for members{line.memberPlan ? ` of ${line.memberPlan}` : ""}: <Money value={`-${line.memberDiscountAmount}`} muted /></>
          : <>Member discount{line.memberPlan ? `, ${line.memberPlan}` : ""}: <Money value={`-${line.memberDiscountAmount}`} muted /></>
      ) : null}
      {member > 0 && other > 0 ? " " : null}
      {other > 0 ? <>Discount: <Money value={`-${other.toFixed(2)}`} muted /></> : null}
    </p>
  );
}
