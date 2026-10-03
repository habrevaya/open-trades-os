import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { priceBook, priceCategories } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Money } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { ActionForm, TextField, Select } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { addCategory, editCategory, placeCategory, removeCategory, fileItems } from "./actions";

export const dynamic = "force-dynamic";

/**
 * THE PRICE BOOK'S SHELVES
 *
 * Categories were a column and a trade pack seed, and nothing could add
 * "Tankless" under "Water heaters", put "Diagnostics" first, or move the items
 * the pack filed under "Misc" somewhere a technician would look. This is the
 * manager: the shelves in the order the tablet shows them, nested three deep
 * at most, and a list of items to move between them.
 *
 * Moving an item changes no price and writes no version: the category is on
 * the item, and every document points at a version.
 */
export default async function CategoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ shelf?: string }>;
}) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const { shelf } = await searchParams;
  const categories = await priceCategories.list(ctx);
  const writes = can(user.actor, "pricebook:write");

  /** The items on one shelf, or on none, for moving. */
  const showing = shelf ?? "none";
  const items = (await priceBook.list(ctx, {
    limit: 200, includeInactive: false,
    ...(showing !== "none" ? { categoryId: showing } : {}),
  })).data.filter((item) => (showing === "none" ? item.categoryId === null : true));

  /** Nesting shown as indentation, three levels at most. */
  const INDENT = ["", "pl-5", "pl-10"] as const;
  const parentOptions = [
    { value: "", label: "At the top" },
    ...categories.filter((c) => c.depth < 2).map((c) => ({ value: c.id, label: `${"\u00a0\u00a0".repeat(c.depth)}${c.name}` })),
  ];
  const shelfOptions = [
    { value: "", label: "No category" },
    ...categories.map((c) => ({ value: c.id, label: `${"\u00a0\u00a0".repeat(c.depth)}${c.name}` })),
  ];
  const siblingsOf = (parentId: string | null) => categories.filter((c) => c.parentId === parentId);
  const shelfName = showing === "none" ? "No category" : categories.find((c) => c.id === showing)?.name ?? "That category";

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/pricebook">Price book</Crumb>
      <div className="mt-1"><PageHeader title="Categories" count={categories.length} /></div>

      {categories.length === 0 ? (
        <Empty title="No categories yet">A trade pack adds its own; add one below to start your own shelves.</Empty>
      ) : (
        <Table label="Categories" head={<><Th>Category</Th><Th className="text-right">Items</Th>{writes ? <Th>Change</Th> : null}</>}>
          {categories.map((c) => {
            const siblings = siblingsOf(c.parentId);
            const at = siblings.findIndex((s) => s.id === c.id);
            return (
              <tr key={c.id}>
                <Td>
                  <a href={`/pricebook/categories?shelf=${c.id}`}
                     className={`font-medium hover:underline ${INDENT[Math.min(c.depth, 2)]}`}>
                    {c.name}
                  </a>
                </Td>
                <Td className="text-right tabular-nums">{c.items}</Td>
                {writes ? (
                  <Td>
                    <div className="flex flex-wrap items-start gap-2">
                      {at > 0 ? (
                        <ActionForm action={placeCategory} submit="Up" tone="quiet"
                                    hidden={{ id: c.id, position: String(at - 1) }} className="flex" />
                      ) : null}
                      {at < siblings.length - 1 ? (
                        <ActionForm action={placeCategory} submit="Down" tone="quiet"
                                    hidden={{ id: c.id, position: String(at + 1) }} className="flex" />
                      ) : null}
                      <details className="text-sm">
                        <summary className="cursor-pointer py-2 text-ink-700">Rename or move</summary>
                        <ActionForm action={editCategory} submit="Save" hidden={{ id: c.id }} className="mt-2 space-y-2">
                          <TextField label="Name" name="name" defaultValue={c.name} required maxLength={80} />
                          <Select label="Inside" name="parentId" defaultValue={c.parentId ?? ""}
                                  options={parentOptions.filter((o) => o.value !== c.id)} />
                        </ActionForm>
                        {c.items === 0 && !categories.some((other) => other.parentId === c.id) ? (
                          <ActionForm action={removeCategory} submit="Remove it" tone="danger" hidden={{ id: c.id }} className="mt-2" />
                        ) : null}
                      </details>
                    </div>
                  </Td>
                ) : null}
              </tr>
            );
          })}
        </Table>
      )}

      {writes && (
        <section aria-label="Add a category" className="mt-8">
          <h2 className="text-base font-semibold">Add a category</h2>
          <ActionForm action={addCategory} submit="Add category" className="mt-3 flex flex-wrap items-end gap-3">
            <TextField label="Name" name="name" required maxLength={80} className="block w-64" />
            <Select label="Inside" name="parentId" options={parentOptions} className="block w-64" />
          </ActionForm>
        </section>
      )}

      <section aria-label="Items on a shelf" className="mt-10">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-base font-semibold">Items in {shelfName}</h2>
          {showing !== "none" ? (
            <a href="/pricebook/categories" className="text-sm text-ink-700 underline underline-offset-4">Items with no category</a>
          ) : null}
        </div>
        {items.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">Nothing here.</p>
        ) : writes ? (
          <ActionForm action={fileItems} submit="Move the ticked items" className="mt-3 space-y-3">
            <Table label="Items to move" head={<><Th className="w-10"><span className="sr-only">Move</span></Th><Th>Code</Th><Th>Name</Th><Th className="text-right">Price</Th></>}>
              {items.map((item) => (
                <tr key={item.id}>
                  <Td><input type="checkbox" name="itemId" value={item.id} aria-label={`Move ${item.name}`} /></Td>
                  <Td className="font-mono text-ink-700">{item.code}</Td>
                  <Td>{item.name}</Td>
                  <Td className="text-right"><Money value={item.price} /></Td>
                </tr>
              ))}
            </Table>
            <Select label="Move to" name="categoryId" options={shelfOptions} className="block w-64" />
          </ActionForm>
        ) : (
          <ul className="mt-2 text-sm">{items.map((item) => <li key={item.id}>{item.code} {item.name}</li>)}</ul>
        )}
      </section>
    </div>
  );
}
