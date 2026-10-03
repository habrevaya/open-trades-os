import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inventory, priceBook, priceCategories, vendorCatalogue, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { Table, Td, Th } from "@/components/Table";
import { formatIn, todayIn } from "@/lib/dates";
import { PRICE_BOOK_KIND, label } from "@/lib/labels";
import { FEE_ROLES, KINDS, PriceFields, shelfOptions } from "../ItemFields";
import { actOnItem } from "../actions";

export const dynamic = "force-dynamic";

const STATE = { in_force: "in force", scheduled: "scheduled", past: "past" } as const;

/**
 * ONE ITEM IN THE PRICE BOOK
 *
 * Revising it writes a new version and never edits the old one, so every
 * estimate and invoice that already used it keeps saying what it said; a
 * revision can be dated ahead and waits beside the price in force until its
 * day. What the item IS (its kind, code, shelf and which fee it is) changes
 * in place, because no document points at any of those. Every price it has
 * had is listed with when, which answers "what did we charge for this in
 * March" without anybody opening an old invoice.
 *
 * Cost and margin only for `pricebook.cost:read`; the vendors who sell it to
 * us, with their part numbers, only for `vendor:read`.
 */
export default async function PriceBookItemPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };
  const item = await priceBook.detail(ctx, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const writes = can(user.actor, "pricebook:write");
  const publishes = can(user.actor, "pricebook:publish");
  const seesCost = can(user.actor, "pricebook.cost:read");
  const readsVendors = can(user.actor, "vendor:read");
  const writesVendors = can(user.actor, "vendor:write");
  const [shelves, links, vendors] = await Promise.all([
    priceCategories.list(ctx),
    readsVendors ? vendorCatalogue.links(ctx, { itemId: id }) : Promise.resolve([]),
    writesVendors ? inventory.vendors(ctx) : Promise.resolve([]),
  ]);
  const hidden = { id };
  const scheduled = item.versions.some((v) => v.state === "scheduled");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/pricebook">Price book</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">
          <span className="font-mono text-ink-500">{item.code}</span> {item.name}
        </h1>
        <div className="flex items-center gap-2">
          {item.feeRole ? <Chip tone="info">{item.feeRole === "diagnostic" ? "Diagnostic fee" : "After hours rate"}</Chip> : null}
          <Chip tone={item.active ? "success" : "neutral"}>{item.active ? "sold" : "retired"}</Chip>
        </div>
      </div>
      <p className="mt-1 text-sm text-ink-700">
        {label(PRICE_BOOK_KIND, item.kind)}, <Money value={item.price} />
        {"cost" in item && item.cost ? <>, costs <Money value={item.cost} /> {item.margin ? `(${(Number(item.margin) * 100).toFixed(1)}% margin)` : ""}</> : null}
        {!item.inForce ? " Not in force yet: its only version starts later." : null}
      </p>

      {writes ? (
        <section aria-label="Change the price or wording" className="mt-8 rounded-md border border-steel-200 p-4">
          <h2 className="text-sm font-semibold">Change the price or wording</h2>
          <p className="mt-1 text-sm text-ink-700">
            Saved as a new version. Estimates and invoices already written keep the version they used.
            {scheduled ? " A change is already scheduled; bring it forward or call it off below first." : ""}
          </p>
          <ActionForm action={actOnItem} submit="Save as a new version" hidden={{ ...hidden, op: "revise" }} className="mt-3 space-y-3">
            <PriceFields item={item} seesCost={seesCost} />
            <TextField label="Takes effect (leave empty for now)" name="effectiveOn" type="date"
                       min={todayIn(user.organizationTimezone)} className="block w-56" />
          </ActionForm>
        </section>
      ) : null}

      <section aria-label="Every price" className="mt-8">
        <h2 className="text-sm font-semibold">Every price it has had</h2>
        <Table head={
          <>
            <Th>Version</Th><Th>Name</Th><Th className="text-right">Price</Th>
            {seesCost ? <Th className="text-right">Cost</Th> : null}
            <Th>From</Th><Th>Until</Th><Th>State</Th>
          </>
        }>
          {item.versions.map((v) => (
            <tr key={v.id}>
              <Td className="tabular-nums">{v.version}</Td>
              <Td>{v.name}</Td>
              <Td className="text-right"><Money value={v.price} /></Td>
              {seesCost ? <Td className="text-right"><Money value={v.cost ?? null} muted /></Td> : null}
              <Td className="text-ink-700">{formatIn(v.effectiveFrom, user.organizationTimezone, { month: "short", day: "numeric", year: "numeric" })}</Td>
              <Td className="text-ink-700">{v.effectiveTo ? formatIn(v.effectiveTo, user.organizationTimezone, { month: "short", day: "numeric", year: "numeric" }) : ""}</Td>
              <Td>
                <span className={v.state === "in_force" ? "font-medium" : "text-ink-500"}>{STATE[v.state]}</span>
                {v.state === "scheduled" && publishes ? (
                  <div className="mt-1 flex gap-2">
                    <ActionForm action={actOnItem} submit="Bring forward" tone="quiet"
                                hidden={{ ...hidden, op: "publish", versionId: v.id }} className="inline" />
                    <ActionForm action={actOnItem} submit="Call off" tone="quiet"
                                hidden={{ ...hidden, op: "discard", versionId: v.id }} className="inline" />
                  </div>
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      </section>

      {writes ? (
        <section aria-label="What it is" className="mt-8 rounded-md border border-steel-200 p-4">
          <h2 className="text-sm font-semibold">What it is</h2>
          <p className="mt-1 text-sm text-ink-700">
            Changes the item itself and writes no version, because no document points at these. Marking it as the
            diagnostic fee or the after hours rate is what lets a membership plan waive it for members.
          </p>
          <ActionForm action={actOnItem} submit="Save" hidden={{ ...hidden, op: "identity" }} className="mt-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Select label="Kind" name="kind" options={KINDS} defaultValue={item.kind} />
              <TextField label="Code" name="code" required maxLength={60} defaultValue={item.code} />
              <Select label="Category" name="categoryId" options={shelfOptions(shelves)} defaultValue={item.categoryId ?? ""} />
              <Select label="Fee a plan can waive" name="feeRole" options={FEE_ROLES} defaultValue={item.feeRole ?? ""} />
            </div>
          </ActionForm>
        </section>
      ) : null}

      {readsVendors ? (
        <section aria-label="Who we buy it from" className="mt-8">
          <h2 className="text-sm font-semibold">Who we buy it from</h2>
          <p className="mt-1 text-sm text-ink-700">
            Each vendor&apos;s own part number and price for it. A purchase order to that vendor carries their number.
          </p>
          {links.length > 0 ? (
            <Table head={<><Th>Vendor</Th><Th>Their number</Th><Th>Their description</Th><Th className="text-right">Their price</Th><Th>{""}</Th></>}>
              {links.map((link) => (
                <tr key={link.id}>
                  <Td>{link.vendorName}</Td>
                  <Td className="font-mono">{link.partNumber}</Td>
                  <Td className="text-ink-700">{link.description ?? ""}</Td>
                  <Td className="text-right"><Money value={link.cost} muted /></Td>
                  <Td>
                    {writesVendors ? (
                      <ActionForm action={actOnItem} submit="Forget" tone="quiet"
                                  hidden={{ ...hidden, op: "unvendor", linkId: link.id }} className="inline" />
                    ) : null}
                  </Td>
                </tr>
              ))}
            </Table>
          ) : <p className="mt-2 text-sm text-ink-500">No vendor numbers recorded.</p>}
          {writesVendors && vendors.length > 0 ? (
            <ActionForm action={actOnItem} submit="Save vendor number" hidden={{ ...hidden, op: "vendor" }} className="mt-3 space-y-3">
              <div className="grid gap-3 sm:grid-cols-4">
                <Select label="Vendor" name="vendorId" options={vendors.map((v) => ({ value: v.id, label: v.name }))} />
                <TextField label="Their part number" name="partNumber" required maxLength={100} />
                <TextField label="Their price for one" name="vendorCost" inputMode="decimal" />
                <TextField label="Their description" name="vendorDescription" maxLength={500} />
              </div>
            </ActionForm>
          ) : null}
        </section>
      ) : null}

      {writes ? (
        <section aria-label={item.active ? "Retire" : "Sell again"} className="mt-8 rounded-md border border-steel-200 p-4">
          <h2 className="text-sm font-semibold">{item.active ? "Stop selling it" : "Sell it again"}</h2>
          <p className="mt-1 text-sm text-ink-700">
            {item.active
              ? "Retired, not deleted: it leaves every technician's list and every document that used it still resolves."
              : "It goes back on every list at the price in force."}
          </p>
          <ActionForm action={actOnItem} submit={item.active ? "Retire item" : "Sell it again"}
                      tone={item.active ? "danger" : "quiet"}
                      hidden={{ ...hidden, op: "active", active: item.active ? "0" : "1" }} className="mt-3" />
        </section>
      ) : null}
    </div>
  );
}
