import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { priceCategories, repricing } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { ActionForm } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { refusalOf } from "@/lib/actions";
import { formatIn, todayIn } from "@/lib/dates";
import { applyChange, undoChange } from "./actions";

export const dynamic = "force-dynamic";

/**
 * CHANGING MANY PRICES AT ONCE
 *
 * Choose the items (a category, a search, or both), choose the change, and
 * read every price before and after, with the margin beside it for whoever
 * may see cost, before anything is written. Applying writes a new version per
 * item, the way a single edit does, so every invoice already raised keeps its
 * price; and every change applied is listed below with a button that puts
 * each price back.
 *
 * The preview is a plain GET, so it can be refreshed, bookmarked and sent to
 * whoever has to agree to it before it goes in.
 */
const MODES = [
  { value: "percent", label: "Up or down by a percentage", hint: "5, or -10" },
  { value: "amount", label: "Up or down by an amount", hint: "12.50, or -5" },
  { value: "margin", label: "To a margin over cost", hint: "0.45 for 45%" },
  { value: "round", label: "Only round to an ending", hint: "" },
] as const;
const ENDINGS = ["", "00", "95", "99", "49"] as const;

const pct = (rate: string | null | undefined) =>
  rate === null || rate === undefined ? "" : `${(Number(rate) * 100).toFixed(1)}%`;

export default async function ChangePricesPage({
  searchParams,
}: {
  searchParams: Promise<{ categoryId?: string; q?: string; mode?: string; value?: string; ending?: string }>;
}) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const params = await searchParams;
  const writes = can(user.actor, "pricebook:write");
  const seesCost = can(user.actor, "pricebook.cost:read");
  const categories = await priceCategories.list(ctx);
  const history = await repricing.history(ctx);

  const mode = MODES.find((m) => m.value === params.mode)?.value;
  const flat = {
    ...(params.categoryId ? { categoryId: params.categoryId } : {}),
    ...(params.q ? { q: params.q } : {}),
    ...(params.value ? { value: params.value } : {}),
    ...(params.ending ? { ending: params.ending } : {}),
  };

  let preview: Awaited<ReturnType<typeof repricing.handlers.previewPriceChange>> | null = null;
  let refusal: string | null = null;
  if (writes && mode) {
    try {
      preview = await repricing.handlers.previewPriceChange(ctx, { mode, ...flat });
    } catch (error) {
      refusal = refusalOf(error);
      if (refusal === null) throw error;
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
      <Crumb href="/pricebook">Price book</Crumb>
      <div className="mt-1"><PageHeader title="Change prices" /></div>

      {writes ? (
        <form action="/pricebook/changes" className="mt-4 grid gap-3 rounded-md border border-steel-200 bg-canvas p-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block">
            <span className="text-sm font-medium text-ink-700">Category</span>
            <select name="categoryId" defaultValue={params.categoryId ?? ""}
                    className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm">
              <option value="">Every category</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{`${"\u00a0\u00a0".repeat(c.depth)}${c.name}`}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-medium text-ink-700">Name or code contains</span>
            <input name="q" defaultValue={params.q ?? ""} maxLength={200}
                   className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-ink-700">Change</span>
            <select name="mode" defaultValue={mode ?? "percent"}
                    className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm">
              {MODES.filter((m) => m.value !== "margin" || seesCost).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-medium text-ink-700">By</span>
            <input name="value" defaultValue={params.value ?? ""} maxLength={20} placeholder="5, -10, 12.50 or 0.45"
                   className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-ink-700">Round up to a price ending in</span>
            <select name="ending" defaultValue={params.ending ?? ""}
                    className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm">
              {ENDINGS.map((e) => <option key={e} value={e}>{e === "" ? "No rounding" : `.${e}`}</option>)}
            </select>
          </label>
          <div className="flex items-end">
            <button type="submit" className="inline-flex h-10 items-center rounded bg-ink-900 px-3.5 text-sm font-medium text-white hover:bg-ink-700">
              Preview
            </button>
          </div>
        </form>
      ) : (
        <p className="mt-4 text-sm text-ink-700">Changing prices needs <code>pricebook:write</code>. The changes made so far are below.</p>
      )}

      {refusal ? <p role="alert" className="mt-4 text-sm text-red-600">{refusal}</p> : null}

      {preview && mode ? (
        <section aria-label="Preview" className="mt-6">
          <h2 className="text-base font-semibold">{preview.description}</h2>
          <p className="mt-1 text-sm text-ink-700">
            {preview.changing === 1 ? "1 price changes" : `${preview.changing} prices change`}
            {preview.lines.length > preview.changing
              ? `, ${preview.lines.length - preview.changing} stay as they are and say why.` : "."}
            {" "}Untick anything that should be left alone.
          </p>
          {preview.lines.length === 0 ? (
            <Empty title="Nothing matches">Choose another category, or clear the search.</Empty>
          ) : (
            <ActionForm action={applyChange} submit="Apply these prices" className="mt-2 space-y-3"
                        hidden={{ mode, ...flat }}>
              <Table label="Prices before and after" head={
                <>
                  <Th className="w-10"><span className="sr-only">Change</span></Th>
                  <Th>Code</Th><Th>Name</Th>
                  <Th className="text-right">Now</Th><Th className="text-right">After</Th>
                  {seesCost ? <><Th className="text-right">Cost</Th><Th className="text-right">Margin now</Th><Th className="text-right">Margin after</Th></> : null}
                </>
              }>
                {preview.lines.map((line) => (
                  <tr key={line.itemId}>
                    <Td>
                      {line.priceAfter ? (
                        <input type="checkbox" name="itemId" value={line.itemId} defaultChecked
                               aria-label={`Change ${line.name}`} />
                      ) : null}
                    </Td>
                    <Td className="font-mono text-ink-700">{line.code}</Td>
                    <Td>
                      {line.name}
                      {line.skipped ? <p className="text-xs text-ink-500">{line.skipped}</p> : null}
                    </Td>
                    <Td className="text-right"><Money value={line.priceBefore} /></Td>
                    <Td className="text-right">{line.priceAfter ? <Money value={line.priceAfter} /> : <span className="text-ink-500">Unchanged</span>}</Td>
                    {seesCost ? (
                      <>
                        <Td className="text-right"><Money value={line.cost ?? null} muted /></Td>
                        <Td className="text-right tabular-nums">{pct(line.marginBefore)}</Td>
                        <Td className="text-right tabular-nums">{pct(line.marginAfter)}</Td>
                      </>
                    ) : null}
                  </tr>
                ))}
              </Table>
              <label className="block w-64">
                <span className="text-sm font-medium text-ink-700">Takes effect (leave empty for now)</span>
                <input type="date" name="effectiveOn" min={todayIn(user.organizationTimezone)}
                       className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm" />
                <span className="mt-1 block text-xs text-ink-500">
                  A day ahead waits as a scheduled change on every item until the start of that day, and the prices
                  now stay until then.
                </span>
              </label>
            </ActionForm>
          )}
        </section>
      ) : null}

      <section aria-label="Changes made" className="mt-10">
        <h2 className="text-base font-semibold">Changes made</h2>
        {history.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">None yet.</p>
        ) : (
          <Table label="Changes made" head={<><Th>When</Th><Th>What</Th><Th className="text-right">Items</Th><Th>By</Th><Th /></>}>
            {history.map((change) => (
              <tr key={change.id}>
                <Td className="whitespace-nowrap text-ink-700">{formatIn(change.appliedAt, user.organizationTimezone)}</Td>
                <Td>
                  <a href={`/pricebook/changes/${change.id}`} className="font-medium hover:underline">{change.description}</a>
                  {change.reversedById ? <> <Chip tone="neutral">Undone</Chip></> : null}
                  {change.effectiveFrom && !change.reversedById && new Date(change.effectiveFrom) > new Date()
                    ? <> <Chip tone="info">Waiting until {formatIn(change.effectiveFrom, user.organizationTimezone, { month: "short", day: "numeric", year: "numeric" })}</Chip></>
                    : null}
                </Td>
                <Td className="text-right tabular-nums">{change.itemCount}</Td>
                <Td className="text-ink-700">{change.appliedBy ?? ""}</Td>
                <Td>
                  {writes && !change.reversedById ? (
                    <ActionForm action={undoChange} submit="Undo" tone="quiet" hidden={{ id: change.id }}
                                className="flex flex-wrap items-center gap-2" />
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </section>
    </div>
  );
}
