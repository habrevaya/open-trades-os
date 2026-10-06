import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { marketing, acquisition } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Money } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { ActionForm, TextField } from "@/components/ActionForm";
import { LeadSourceSelect } from "@/components/LeadSourceSelect";
import { todayIn } from "@/lib/dates";
import { recordSpend, removeSpend, uploadSpend } from "../actions";

export const dynamic = "force-dynamic";

/** Where a spend row came from, in words: typed, a file, or a connection that writes its own. */
const ORIGIN: Record<string, string> = {
  manual: "Typed",
  google_ads: "Pulled from Google Ads",
  meta_ads: "Pulled from Meta",
  bing_ads: "Pulled from Microsoft Advertising",
  lead_charge: "What a marketplace charged for a lead",
  direct_mail: "A mailing's pieces",
};

/**
 * WHAT IT COST, A DAY AT A TIME
 *
 * Typed by hand for anything with no export (a yard sign order, a radio buy,
 * a sponsorship), or uploaded as the daily CSV every ads platform exports. A
 * day rather than a month, because spend moves with the weather and a monthly
 * figure cannot say what the heat wave week cost per booked job.
 *
 * Against a channel or a tracking campaign, picked from the same list the rest
 * of the product uses, so the money lands on the funnel row it belongs to.
 * Typing the same day for the same campaign again replaces it rather than
 * doubling it.
 */
export default async function SpendPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const today = todayIn(user.organizationTimezone);
  const from = new Date(Date.parse(`${today}T12:00:00Z`) - 59 * 86_400_000).toISOString().slice(0, 10);
  const [rows, channels] = await Promise.all([
    marketing.listSpend(ctx, { from, to: today }),
    acquisition.channelOptions(ctx),
  ]);
  const writes = can(user.actor, "adspend:write");

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Spend" count={rows.length} />

      {writes ? (
        <div className="mt-4 grid gap-8 lg:grid-cols-2">
          <section>
            <h2 className="text-base font-semibold">Record a day</h2>
            <ActionForm action={recordSpend} submit="Record spend" className="mt-3 space-y-3">
              <LeadSourceSelect options={channels} name="for" label="Spent on" required />
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField label="Day" name="spentOn" type="date" required defaultValue={today} />
                <TextField label="Amount" name="amount" required inputMode="decimal" placeholder="250.00" />
              </div>
              <TextField label="What the platform calls it (optional)" name="label" maxLength={200} />
            </ActionForm>
          </section>
          <section>
            <h2 className="text-base font-semibold">Upload an export</h2>
            <p className="mt-1 text-sm text-ink-700">
              The daily CSV from Google Ads, Microsoft Ads or Meta. A row whose campaign name is one
              of your tracking campaigns lands on it; lines that cannot be read are listed, and the rest load.
            </p>
            <ActionForm action={uploadSpend} submit="Upload" className="mt-3 space-y-3">
              <LeadSourceSelect options={channels} name="for" id="lead-source-upload" label="Every row is for" required />
              <label className="block">
                <span className="text-sm font-medium text-ink-700">File</span>
                <input type="file" name="file" accept=".csv,text/csv" required className="mt-1 block text-sm" />
              </label>
            </ActionForm>
          </section>
        </div>
      ) : null}

      <h2 className="mt-10 text-base font-semibold">The last sixty days</h2>
      {rows.length === 0 ? (
        <Empty title="Nothing recorded">
          With no spend recorded, every channel looks free on the funnel, which is the one mistake it
          cannot catch for you.
        </Empty>
      ) : (
        <Table label="Spend" head={<><Th>Day</Th><Th>Channel</Th><Th>Campaign</Th><Th>From</Th><Th>Amount</Th><Th></Th></>}>
          {rows.map((row) => (
            <tr key={row.id}>
              <Td className="tabular-nums">{row.spentOn}</Td>
              <Td>{row.channelName ?? row.source.replace(/_/g, " ")}</Td>
              <Td>{row.campaignName ?? row.label ?? ""}</Td>
              <Td className="text-ink-700">{ORIGIN[row.origin] ?? "Imported"}</Td>
              <Td><Money value={row.amount} /></Td>
              <Td>
                {writes ? (
                  <ActionForm action={removeSpend} submit="Take out" tone="quiet" hidden={{ id: row.id }} className="flex" />
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
