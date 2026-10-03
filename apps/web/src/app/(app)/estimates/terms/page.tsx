import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { estimates } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { ActionForm, TextArea } from "@/components/ActionForm";
import { PageHeader } from "@/components/Table";
import { saveTerms } from "./actions";

export const dynamic = "force-dynamic";

/**
 * THE SMALL PRINT ON EVERY PROPOSAL
 *
 * What the price includes, how long it holds, the warranty and how payment
 * works, printed under the options and shown to the customer on the page they
 * approve. Copied onto each estimate when it is written, so changing it here
 * reaches estimates written from now on and never one a customer has already
 * read or signed.
 *
 * Anybody who writes estimates can read it; changing it is a company
 * decision, `settings:write`, the same as the discount limit.
 */
export default async function ProposalTermsPage() {
  const user = await requireSetupUser();
  const { terms } = await estimates.proposalTerms({ actor: user.actor, db: getDb() });
  const edits = can(user.actor, "settings:write");

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <PageHeader title="Proposal terms" />
      <p className="mt-2 max-w-prose text-sm text-ink-700">
        Printed under the options on every proposal and shown on the page where the customer approves.
        Each estimate keeps the terms it was written with, so a change here applies to estimates written
        from now on. Your logo and colour come from the company settings.
      </p>
      {edits ? (
        <ActionForm action={saveTerms} submit="Save terms" done="Saved. New estimates will carry these terms."
                    className="mt-6 space-y-3">
          <TextArea label="Terms" name="terms" rows={12} maxLength={10000} defaultValue={terms ?? ""}
                    placeholder="Prices hold for 30 days. Labour is warranted for one year. Half is due on approval and the rest on completion." />
        </ActionForm>
      ) : (
        <div className="mt-6 rounded-md border border-steel-200 bg-canvas p-4 text-sm">
          {terms
            ? <p className="whitespace-pre-line text-ink-700">{terms}</p>
            : <p className="text-ink-500">No terms are set, so proposals go out without any.</p>}
          <p className="mt-3 text-xs text-ink-500">Somebody who can change company settings can edit these.</p>
        </div>
      )}
    </div>
  );
}
