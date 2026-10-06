import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { priceCategories } from "@opentradesos/api/services";
import { assertCan, can } from "@opentradesos/core";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { FEE_ROLES, KINDS, PriceFields, shelfOptions } from "../ItemFields";
import { createItem } from "../actions";

export const dynamic = "force-dynamic";

/** A NEW ITEM in the price book: version one of it, from today. */
export default async function NewPriceBookItemPage() {
  const user = await requireSetupUser();
  assertCan(user.actor, "pricebook:write");
  const shelves = await priceCategories.list({ actor: user.actor, db: getDb() });
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <Crumb href="/pricebook">Price book</Crumb>
      <h1 className="mt-1 text-xl font-semibold">New item</h1>
      <ActionForm action={createItem} submit="Add to the price book" className="mt-6 space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Kind" name="kind" options={KINDS} defaultValue="service" />
          <TextField label="Code" name="code" required maxLength={60} placeholder="CAP-45-5" />
          <Select label="Category" name="categoryId" options={shelfOptions(shelves)} />
          <Select label="Fee a plan can waive" name="feeRole" options={FEE_ROLES} />
        </div>
        <PriceFields seesCost={can(user.actor, "pricebook.cost:read")} />
      </ActionForm>
    </div>
  );
}
