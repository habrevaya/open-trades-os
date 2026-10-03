import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { can } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";
import { TaxSection } from "./TaxSection";

export const dynamic = "force-dynamic";

/** PRICE BOOK, TAX: which items are taxed and under which class. */
export default async function PriceBookTaxPage() {
  const user = await requireSetupUser();
  if (!can(user.actor, "pricebook:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Sales tax" />
        <Empty title="The price book is not part of your access">Somebody who can change roles can turn this on for you.</Empty>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Sales tax" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Whether each item is taxed, and what kind of thing it is. The rate itself is set on the invoice or
        estimate it is charged on, because rates belong to where the work is done.
      </p>
      <div className="mt-6"><TaxSection ctx={{ actor: user.actor, db: getDb() }} /></div>
    </div>
  );
}
