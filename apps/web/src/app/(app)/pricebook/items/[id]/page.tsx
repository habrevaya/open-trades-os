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
import { CrewHoursBox, FEE_ROLES, KINDS, PriceFields, shelfOptions } from "../ItemFields";
import { actOnItem } from "../actions";
import { percentOf } from "@/lib/commission-rate";

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
  /** A commission rate is a pay term: seen with `commission:read`, set with `commission:configure`. */
  const setsCommission = can(user.actor, "commission:configure") && "commissionRate" in item;
  const readsVendors = can(user.actor, "vendor:read");
  const writesVendors = can(user.actor, "vendor:write");
  const [shelves, links, vendors] = await Promise.all([
    priceCategories.list(ctx),
    readsVendors ? vendorCatalogue.links(ctx, { itemId: id }) : Promise.resolve([]),
    writesVendors ? inventory.vendors(ctx) : Promise.resolve([]),
  ]);
  const hidden = { id };
  const scheduled = item.versions.some((v) => v.state === "scheduled");
  /** A kit's parts by name and code, read one by one: a kit has a handful. */
  const parts = await Promise.all(item.components.map(async (part) => {
    const found = await priceBook.detail(ctx, { id: part.itemId }).catch(() => null);
    return { ...part, code: found?.code ?? "", name: found?.name ?? "An item no longer in the book" };
  }));
  const PART_ROWS = Math.max(parts.length + 2, 4);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/pricebook">Price book</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">
          <span className="font-mono text-ink-500">{item.code}</span> {item.name}
        </h1>
        <div className="flex items-center gap-2">
          {item.feeRole ? <Chip tone="info">{item.feeRole === "diagnostic" ? "Diagnostic fee" : "After hours rate"}</Chip> : null}
          {item.quantityIsCrewHours ? <Chip tone="info">Counted in crew hours</Chip> : null}
          {item.chemical ? <Chip tone="info">Chemical, per {item.chemical.unit}</Chip> : null}
          <Chip tone={item.active ? "success" : "neutral"}>{item.active ? "sold" : "retired"}</Chip>
        </div>
      </div>
      <p className="mt-1 text-sm text-ink-700">
        {label(PRICE_BOOK_KIND, item.kind)}, <Money value={item.price} />
        {item.units ? <> per {item.units.use}</> : null}
        {"cost" in item && item.cost ? <>, costs <Money value={item.cost} />{item.units ? <> per {item.units.buy}</> : null}
          {"costPerUse" in item && item.costPerUse && item.units ? <> (<Money value={item.costPerUse} /> per {item.units.use}, {Number(item.units.usePerBuy)} to the {item.units.buy})</> : null}
          {" "}{item.margin ? `(${(Number(item.margin) * 100).toFixed(1)}% margin)` : ""}</> : null}
        {!item.inForce ? " Not in force yet: its only version starts later." : null}
      </p>

      {item.hasPicture || writes ? (
        <section aria-label="Picture" className="mt-8 rounded-md border border-steel-200 p-4">
          <h2 className="text-sm font-semibold">Picture</h2>
          {item.hasPicture ? (
            <img src={`/pricebook/pictures/${item.versionId}`} alt={`Picture of ${item.name}`}
                 className="mt-3 max-h-48 rounded border border-steel-200 object-contain" />
          ) : (
            <p className="mt-1 text-sm text-ink-700">No picture yet.</p>
          )}
          {writes ? (
            <>
              <p className="mt-2 text-sm text-ink-700">
                Customers see it beside this item on proposals and in the proposal PDF. A JPEG, PNG, GIF or WebP, up to 4 MB.
                Saved as a new version, so estimates already written keep the picture they had.
              </p>
              {scheduled ? (
                <p className="mt-2 text-sm text-ink-700">A price change is waiting. Bring it forward or call it off below before you change the picture.</p>
              ) : item.inForce ? (
                <div className="mt-3 flex flex-wrap items-center gap-4">
                  <ActionForm action={actOnItem} submit={item.hasPicture ? "Upload a new picture" : "Upload the picture"}
                              hidden={{ ...hidden, op: "picture" }} className="flex flex-wrap items-center gap-3">
                    <input type="file" name="picture" accept="image/jpeg,image/png,image/gif,image/webp"
                           aria-label="Picture file" className="text-sm" />
                  </ActionForm>
                  {item.hasPicture ? (
                    <ActionForm action={actOnItem} submit="Take the picture off" tone="quiet"
                                hidden={{ ...hidden, op: "picture-off" }} className="inline" />
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}

      {writes ? (
        <section aria-label="Change the price or wording" className="mt-8 rounded-md border border-steel-200 p-4">
          <h2 className="text-sm font-semibold">Change the price or wording</h2>
          <p className="mt-1 text-sm text-ink-700">
            Saved as a new version. Estimates and invoices already written keep the version they used.
            {scheduled ? " A change is already scheduled; bring it forward or call it off below first." : ""}
          </p>
          <ActionForm action={actOnItem} submit="Save as a new version" hidden={{ ...hidden, op: "revise" }} className="mt-3 space-y-3">
            <PriceFields item={item} seesCost={seesCost} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <TextField label="Picture (a web address starting with https://)" name="imageUrl" type="url" maxLength={2000}
                           defaultValue={item.imageUrl ?? ""} placeholder="https://" />
                <input type="hidden" name="imageUrlWas" value={item.imageUrl ?? ""} />
                <p className="mt-1 text-xs text-ink-500">
                  Kept with this version for your own reference. It is never shown to a customer and nothing opens it.
                  To show a picture, upload one above. Empty takes it off.
                </p>
              </div>
              {setsCommission ? (
                <div>
                  <TextField label="Commission on this item, percent" name="commissionPercent" inputMode="decimal"
                             defaultValue={percentOf("commissionRate" in item ? item.commissionRate : null)} placeholder="8" />
                  <input type="hidden" name="commissionPercentWas" value={percentOf("commissionRate" in item ? item.commissionRate : null)} />
                  <p className="mt-1 text-xs text-ink-500">
                    Kept with this version, so a line priced now keeps this rate. How it works with the plan is the
                    company&apos;s choice on <a href="/payroll/commissions" className="underline underline-offset-2">Commission plans</a>.
                    Empty means no rate on this item.
                  </p>
                </div>
              ) : null}
            </div>
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
            <Th>Picture</Th><Th>From</Th><Th>Until</Th><Th>State</Th>
          </>
        }>
          {item.versions.map((v) => (
            <tr key={v.id}>
              <Td className="tabular-nums">{v.version}</Td>
              <Td>{v.name}</Td>
              <Td className="text-right"><Money value={v.price} /></Td>
              {seesCost ? <Td className="text-right"><Money value={v.cost ?? null} muted /></Td> : null}
              <Td>
                {v.hasPicture
                  ? <img src={`/pricebook/pictures/${v.id}`} alt={`Picture on version ${v.version}`} className="h-8 w-10 rounded object-cover" />
                  : <span className="text-ink-500">None</span>}
              </Td>
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

      {parts.length > 0 || writes ? (
        <section aria-label="What is in the kit" className="mt-8 rounded-md border border-steel-200 p-4">
          <h2 className="text-sm font-semibold">What is in the kit</h2>
          {parts.length > 0 ? (
            <ul className="mt-2 space-y-0.5 text-sm">
              {parts.map((part) => (
                <li key={part.itemId}>
                  {part.quantity} &times; <a href={`/pricebook/items/${part.itemId}`} className="hover:underline">
                    <span className="font-mono text-ink-500">{part.code}</span> {part.name}</a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-ink-700">Nothing: this item is not a kit. Add the items it is made up of to make it one.</p>
          )}
          {writes ? (
            <ActionForm action={actOnItem} submit="Save the parts as a new version" hidden={{ ...hidden, op: "components" }}
                        className="mt-3 space-y-3">
              <p className="text-sm text-ink-700">
                By each item&apos;s code. Saved as a new version like a price change, so an estimate already written keeps
                the kit it was written with. Leave a row empty to take a part off.
              </p>
              {Array.from({ length: PART_ROWS }, (_, i) => (
                <div key={i} className="grid gap-3 sm:grid-cols-[1fr_8rem]">
                  <TextField label={`Part ${i + 1} code`} name={`partCode${i}`} defaultValue={parts[i]?.code ?? ""} maxLength={60} />
                  <TextField label={`Part ${i + 1} how many`} name={`partQuantity${i}`} inputMode="decimal"
                             defaultValue={parts[i] ? String(parts[i]!.quantity) : ""} />
                </div>
              ))}
              <TextField label="Takes effect (leave empty for now)" name="effectiveOn" type="date"
                         min={todayIn(user.organizationTimezone)} className="block w-56" />
            </ActionForm>
          ) : null}
        </section>
      ) : null}

      {writes ? (
        <section aria-label="What it is" className="mt-8 rounded-md border border-steel-200 p-4">
          <h2 className="text-sm font-semibold">What it is</h2>
          <p className="mt-1 text-sm text-ink-700">
            Changes the item itself and writes no version, because no document points at these. Marking it as the
            diagnostic fee or the after hours rate is what lets a membership plan waive it for members. Saying its quantity is
            crew hours lets an approved estimate budget the job in hours.
          </p>
          <ActionForm action={actOnItem} submit="Save" hidden={{ ...hidden, op: "identity" }} className="mt-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Select label="Kind" name="kind" options={KINDS} defaultValue={item.kind} />
              <TextField label="Code" name="code" required maxLength={60} defaultValue={item.code} />
              <Select label="Category" name="categoryId" options={shelfOptions(shelves)} defaultValue={item.categoryId ?? ""} />
              <Select label="Fee a plan can waive" name="feeRole" options={FEE_ROLES} defaultValue={item.feeRole ?? ""} />
              <CrewHoursBox defaultChecked={item.quantityIsCrewHours} />
            </div>
          </ActionForm>
        </section>
      ) : null}

      {writes && (item.kind === "material" || item.chemical) ? (
        <section aria-label="A chemical your technicians apply" className="mt-8 rounded-md border border-steel-200 p-4">
          <h2 className="text-sm font-semibold">A chemical your technicians apply</h2>
          <p className="mt-1 text-sm text-ink-700">
            {item.chemical
              ? <>Technicians pick it by name when they record what they applied, and its EPA number goes on the record
                for them. Its cost is per {item.chemical.unit}, and the chemical cost per stop counts what they applied
                at the cost on the day.</>
              : <>Mark it as a chemical and technicians pick it by name when they record what they applied, instead of
                typing it. Say the unit its cost is per, so what they apply can be costed.</>}
          </p>
          <ActionForm action={actOnItem} submit={item.chemical ? "Save" : "Mark as a chemical"}
                      hidden={{ ...hidden, op: "chemical" }} className="mt-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField label="Unit its cost is per, like gal or oz" name="chemicalUnit" required maxLength={20}
                         defaultValue={item.chemical?.unit ?? ""} />
              <TextField label="EPA registration number, from the label" name="epaRegistrationNumber" maxLength={40}
                         defaultValue={item.chemical?.epaRegistrationNumber ?? ""} />
            </div>
          </ActionForm>
          {item.chemical ? (
            <ActionForm action={actOnItem} submit="Not a chemical" tone="quiet" hidden={{ ...hidden, op: "unchemical" }} className="mt-2" />
          ) : null}
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
                  <Td className="text-right">
                    <Money value={link.cost} muted />
                    {Number(link.packQuantity) !== 1 ? (
                      <div className="text-xs text-ink-500">
                        a {link.purchaseUnit ?? "pack"} of {Number(link.packQuantity)}
                        {link.eachCost ? <>, <Money value={link.eachCost} muted /> each</> : null}
                      </div>
                    ) : null}
                    {link.priceBreaks.length > 0 ? (
                      <div className="text-xs text-ink-500">
                        {link.priceBreaks.map((b) => `${Number(b.minimum)}+ at ${Number(b.cost).toFixed(2)}`).join(", ")}
                      </div>
                    ) : null}
                    {link.secondPack ? (
                      <div className="text-xs text-ink-500" data-testid="second-pack">
                        or {Number(link.secondPack.packQuantity) === 1 && !link.secondPack.purchaseUnit
                          ? "by the each"
                          : `a ${link.secondPack.purchaseUnit ?? "pack"} of ${Number(link.secondPack.packQuantity)}`}
                        {link.secondPack.cost ? <> at <Money value={link.secondPack.cost} muted /></> : null}
                        {link.secondPack.eachCost && Number(link.secondPack.packQuantity) !== 1 ? <>, <Money value={link.secondPack.eachCost} muted /> each</> : null}
                        {link.secondPack.partNumber ? <>, their number <span className="font-mono">{link.secondPack.partNumber}</span></> : null}
                      </div>
                    ) : null}
                  </Td>
                  <Td>
                    {writesVendors ? (
                      <ActionForm action={actOnItem} submit="Forget" tone="quiet"
                                  hidden={{ ...hidden, op: "unvendor", linkId: link.id }} className="inline" />
                    ) : null}
                    {writesVendors && link.secondPack ? (
                      <ActionForm action={actOnItem} submit="Stop buying it the second way" tone="quiet"
                                  hidden={{ ...hidden, op: "nosecond", vendorId: link.vendorId, partNumber: link.partNumber }} className="inline" />
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
                <TextField label="How many come in one of theirs" name="packQuantity" inputMode="decimal" placeholder="1" />
                <TextField label="What they call it" name="purchaseUnit" placeholder="box" maxLength={40} />
              </div>
              <p className="text-xs text-ink-500">
                When they sell it by the box, their price is for the box and orders to them go in whole boxes.
              </p>
              <fieldset className="grid gap-3 sm:grid-cols-4">
                <legend className="mb-1 text-sm font-medium text-ink-700">A second way they sell it (optional)</legend>
                <TextField label="How many in one, the second way" name="secondPackQuantity" inputMode="decimal" placeholder="25" />
                <TextField label="What they call that" name="secondPurchaseUnit" placeholder="box" maxLength={40} />
                <TextField label="Their price for one of those" name="secondCost" inputMode="decimal" />
                <TextField label="Their number for that, if it is different" name="secondPartNumber" maxLength={100} />
              </fieldset>
              <p className="text-xs text-ink-500">
                Some suppliers sell the same part by the each and by the box at different prices. Fill this in and a
                purchase order to them offers the cheaper per piece first, buying by the box when the quantity is whole
                boxes. If the box has a number of its own, put it in: an order for boxes goes out with the box&apos;s
                number, and typing it on an order picks the box. Leave it empty to keep what is there.
              </p>
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
