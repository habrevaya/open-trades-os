import { getDb } from "@/lib/db";
import { priceBook, priceCategories, repricing } from "@opentradesos/api/services";
import { Money } from "@opentradesos/ui";
import { ActionForm } from "@/components/ActionForm";
import { Table, Th, Td, Empty } from "@/components/Table";
import { refusalOf } from "@/lib/actions";
import { StepFrame, loadStep } from "../StepFrame";
import { applyMarketChange } from "./actions";

export const dynamic = "force-dynamic";

const ENDINGS = ["", "00", "95", "99", "49"] as const;

/**
 * STEP SIX: THE PRICE BOOK, AT YOUR PRICES
 *
 * A trade pack's prices are national averages, which is wrong for every
 * company in the same direction until somebody changes them. Going through
 * forty items one at a time is the job nobody finishes, so this step offers
 * the move most owners actually make: everything, or one shelf, up or down by
 * a percentage, with every price before and after shown before anything is
 * written. It is the bulk change on Price book, Change prices, and it is
 * listed there afterwards with an undo.
 */
export default async function PriceBookStep({
  searchParams,
}: {
  searchParams: Promise<{ categoryId?: string; value?: string; ending?: string }>;
}) {
  const { user, allowed } = await loadStep("pricebook");
  const ctx = { actor: user.actor, db: getDb() };
  const params = await searchParams;

  const [items, categories] = allowed
    ? await Promise.all([priceBook.list(ctx, { limit: 200, includeInactive: false }), priceCategories.list(ctx)])
    : [null, []];

  const flat = {
    ...(params.categoryId ? { categoryId: params.categoryId } : {}),
    ...(params.value ? { value: params.value } : {}),
    ...(params.ending ? { ending: params.ending } : {}),
  };
  let preview: Awaited<ReturnType<typeof repricing.handlers.previewPriceChange>> | null = null;
  let refusal: string | null = null;
  if (allowed && params.value) {
    try {
      preview = await repricing.handlers.previewPriceChange(ctx, { mode: "percent", ...flat });
    } catch (error) {
      refusal = refusalOf(error);
      if (refusal === null) throw error;
    }
  }
  const changing = preview?.lines.filter((line) => line.priceAfter) ?? [];

  return (
    <StepFrame stepKey="pricebook" user={user} allowed={allowed}
               intro="The prices your trade pack loaded are national averages, a starting point rather than a recommendation. Move them to your market here; single items are changed from the Price book.">
      {items && items.data.length === 0 ? (
        <Empty title="The price book is empty">Choose your trade first, or add items from the Price book.</Empty>
      ) : (
        <>
          <form action="/setup/pricebook" className="grid gap-3 sm:grid-cols-4">
            <label className="block sm:col-span-2">
              <span className="text-sm font-medium text-ink-700">Which items</span>
              <select name="categoryId" defaultValue={params.categoryId ?? ""}
                      className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm">
                <option value="">Every item ({items?.data.length ?? 0})</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-medium text-ink-700">Up or down by percent</span>
              <input name="value" defaultValue={params.value ?? ""} maxLength={8} placeholder="8, or -5" required
                     className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm" />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-ink-700">Round up to an ending</span>
              <select name="ending" defaultValue={params.ending ?? ""}
                      className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm">
                {ENDINGS.map((e) => <option key={e} value={e}>{e === "" ? "No rounding" : `.${e}`}</option>)}
              </select>
            </label>
            <div className="sm:col-span-4">
              <button type="submit" className="inline-flex h-10 items-center rounded border border-steel-300 px-3.5 text-sm font-medium hover:bg-steel-100">
                Show the new prices
              </button>
            </div>
          </form>

          {refusal ? <p role="alert" className="mt-4 text-sm text-red-600">{refusal}</p> : null}

          {preview ? (
            <section aria-label="New prices" className="mt-6">
              <h2 className="text-base font-semibold">{preview.description}</h2>
              {changing.length === 0 ? (
                <p className="mt-2 text-sm text-ink-500">Nothing would change.</p>
              ) : (
                <ActionForm action={applyMarketChange} submit={`Apply to ${changing.length} ${changing.length === 1 ? "item" : "items"}`}
                            hidden={{ mode: "percent", ...flat }} className="mt-2 space-y-3">
                  <Table label="Prices before and after" head={<><Th className="w-10"><span className="sr-only">Change</span></Th><Th>Item</Th><Th className="text-right">Now</Th><Th className="text-right">After</Th></>}>
                    {changing.map((line) => (
                      <tr key={line.itemId}>
                        <Td><input type="checkbox" name="itemId" value={line.itemId} defaultChecked aria-label={`Change ${line.name}`} /></Td>
                        <Td>{line.name}</Td>
                        <Td className="text-right"><Money value={line.priceBefore} /></Td>
                        <Td className="text-right"><Money value={line.priceAfter!} /></Td>
                      </tr>
                    ))}
                  </Table>
                </ActionForm>
              )}
            </section>
          ) : null}
        </>
      )}
    </StepFrame>
  );
}
