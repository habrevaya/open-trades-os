import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inventory, priceCategories } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";
import { CatalogueImport } from "./CatalogueImport";

export const dynamic = "force-dynamic";

/**
 * A SUPPLIER'S CATALOGUE, INTO THE PRICE BOOK
 *
 * Every supply house sends its price list as a spreadsheet. This reads one:
 * each row's part number is matched to what that vendor already calls one of
 * our items, or to one of our item codes, or becomes a new item priced at the
 * margin given. Their number and price are kept on the item for purchase
 * orders, and our own cost can follow theirs as a new version.
 *
 * Needs `vendor:write` and `pricebook:write`, because it writes both.
 */
export default async function CataloguePage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const allowed = can(user.actor, "vendor:write") && can(user.actor, "pricebook:write");

  if (!allowed) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Supplier catalogue" />
        <Empty title="Importing a catalogue is not part of your access">
          It adds to the price book and to vendors, so it needs both. Somebody who can change roles can turn it on.
        </Empty>
      </div>
    );
  }

  const [vendors, shelves] = await Promise.all([inventory.vendors(ctx), priceCategories.list(ctx)]);
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Supplier catalogue" />
      <p className="mt-2 max-w-prose text-sm text-ink-700">
        A file with a part number, a description and a cost on each row, and the vendor&apos;s name in a column or
        chosen below. Nothing is written until you have seen what each row will do.
      </p>
      <div className="mt-6">
        {vendors.length === 0 ? (
          <Empty title="Add a vendor first">
            <a href="/purchasing" className="underline underline-offset-4">Purchasing</a> is where vendors are added,
            with the name their catalogue uses.
          </Empty>
        ) : (
          <CatalogueImport
            vendors={vendors.map((v) => ({ id: v.id, name: v.name }))}
            shelves={[{ value: "", label: "No category" }, ...shelves.map((c) => ({ value: c.id, label: `${"  ".repeat(c.depth)}${c.name}` }))]}
            seesCost={can(user.actor, "pricebook.cost:read")}
          />
        )}
      </div>
    </div>
  );
}
