import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { externalWorkCodes, jobs, priceBook } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Crumb } from "@/components/Detail";
import { ActionForm } from "@/components/ActionForm";
import { Empty, Table, Th, Td } from "@/components/Table";
import { saveCodes } from "../../actions";

export const dynamic = "force-dynamic";

const input = "h-8 w-full rounded border border-steel-300 px-2 text-sm";

/**
 * A CLIENT'S CODES, AND WHAT EACH MEANS HERE
 *
 * One list per client, because two clients' "PLB-07" are two different things.
 * Each code says what kind of work it is, which price book item it is and how
 * many, or both. When an order from this client arrives with these codes, the
 * order's page proposes the job from this list for the office to confirm.
 *
 * The whole list is one form saved at once: every row saved plus three empty
 * ones, so a new code is typed into an empty row and saving brings three more.
 * Clearing a row's code takes it off the list. `contract:read` to look and
 * `contract:write` to change, as for the client's contract.
 */
export default async function ClientCodesPage({ params }: { params: Promise<{ customerId: string }> }) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const { customerId } = await params;

  if (!can(user.actor, "contract:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <h1 className="text-xl font-semibold">A client&apos;s codes</h1>
        <Empty title="Not shown to your role">This needs the permission that reads contracts.</Empty>
      </div>
    );
  }

  const list = await externalWorkCodes.listCodes(ctx, { customerId });
  const writes = can(user.actor, "contract:write");
  const [types, items] = writes
    ? await Promise.all([
      can(user.actor, "job:read") ? jobs.listTypes(ctx, { includeInactive: false }) : { data: [] },
      can(user.actor, "pricebook:read") ? priceBook.list(ctx, { limit: 200, includeInactive: false }) : { data: [] },
    ])
    : [{ data: [] }, { data: [] }];

  const typeOptions = [{ value: "", label: "No kind of work" }, ...types.data.map((t) => ({ value: t.id, label: t.name }))];
  const itemOptions = [{ value: "", label: "No item" }, ...items.data.map((i) => ({
    value: String(i.id), label: `${String(i.name)}${i.code ? ` (${String(i.code)})` : ""}`,
  }))];
  /**
   * Every item a saved row names is offered, even past the first two hundred
   * the list reads, so saving the list never quietly drops a mapping.
   */
  for (const row of list.data) {
    if (row.priceBookItemId && row.itemSold && !itemOptions.some((o) => o.value === row.priceBookItemId)) {
      itemOptions.push({ value: row.priceBookItemId, label: `${row.itemName ?? "Item"}${row.itemCode ? ` (${row.itemCode})` : ""}` });
    }
    if (row.jobTypeId && row.jobTypeActive && !typeOptions.some((o) => o.value === row.jobTypeId)) {
      typeOptions.push({ value: row.jobTypeId, label: row.jobTypeName ?? "Job type" });
    }
  }
  const rows = [...list.data, ...Array.from({ length: 3 }, () => null)].slice(0, 200);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/contracts/external">Work from other systems</Crumb>
      <h1 className="mt-1 text-xl font-semibold">{list.clientName}&apos;s codes</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        The codes {list.clientName} writes on its work orders, and what each one means here. When an order
        arrives with these codes, its page offers the job they add up to for you to check. A code that is
        not on this list is named on that page, and nothing is added for it.
      </p>

      {writes ? (
        <ActionForm action={saveCodes} submit="Save the codes"
                    hidden={{ customerId: list.customerId, rows: String(rows.length) }}>
          <Table label={`${list.clientName}'s codes`} head={
            <><Th>Their code</Th><Th>What it means to them</Th><Th>Kind of work</Th><Th>Item</Th><Th>How many</Th></>
          }>
            {rows.map((row, i) => (
              <tr key={row?.id ?? `new-${i}`}>
                <Td>
                  <input name={`code.${i}`} defaultValue={row?.code ?? ""} aria-label={`Code, row ${i + 1}`}
                         className={input} />
                </Td>
                <Td>
                  <input name={`description.${i}`} defaultValue={row?.description ?? ""}
                         aria-label={`What it means, row ${i + 1}`} className={input} />
                </Td>
                <Td>
                  <select name={`jobTypeId.${i}`} defaultValue={row?.jobTypeActive ? row.jobTypeId ?? "" : ""}
                          aria-label={`Kind of work, row ${i + 1}`} className={input}>
                    {typeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  {row?.jobTypeId && !row.jobTypeActive ? (
                    <span className="block text-xs text-amber-700">{row.jobTypeName} is switched off. Choose another.</span>
                  ) : null}
                </Td>
                <Td>
                  <select name={`itemId.${i}`} defaultValue={row?.itemSold ? row.priceBookItemId ?? "" : ""}
                          aria-label={`Item, row ${i + 1}`} className={input}>
                    {itemOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  {row?.priceBookItemId && !row.itemSold ? (
                    <span className="block text-xs text-amber-700">
                      {row.itemName ?? "Its item"} is no longer sold. Choose another.
                    </span>
                  ) : null}
                </Td>
                <Td>
                  <input name={`quantity.${i}`} defaultValue={row?.quantity ?? "1"} inputMode="decimal"
                         aria-label={`How many, row ${i + 1}`} className={`${input} w-20`} />
                </Td>
              </tr>
            ))}
          </Table>
        </ActionForm>
      ) : list.data.length === 0 ? (
        <Empty title="No codes yet">Somebody who can change contracts adds them here.</Empty>
      ) : (
        <Table label={`${list.clientName}'s codes`} head={
          <><Th>Their code</Th><Th>What it means to them</Th><Th>Kind of work</Th><Th>Item</Th><Th>How many</Th></>
        }>
          {list.data.map((row) => (
            <tr key={row.id}>
              <Td className="font-mono">{row.code}</Td>
              <Td>{row.description ?? ""}</Td>
              <Td>{row.jobTypeName ?? "None"}{row.jobTypeId && !row.jobTypeActive ? " (switched off)" : ""}</Td>
              <Td>{row.itemName ?? "None"}{row.priceBookItemId && !row.itemSold ? " (no longer sold)" : ""}</Td>
              <Td>{row.quantity}</Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
