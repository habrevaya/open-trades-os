import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { warrantyMakers } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { ActionForm, TextField } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { addMaker, editMaker, retireMaker } from "./actions";

export const dynamic = "force-dynamic";

/**
 * THE MAKERS A COMPANY BUYS FROM, AND THE DAYS EACH GIVES TO REGISTER A UNIT
 *
 * The days to register a unit used to be typed on every price book item. Here a
 * maker is written down once with its days, and an item says which maker it
 * comes from. A maker with no days leaves each item's own days as they were.
 * Changing the days applies to units installed from then on: a deadline already
 * open keeps the last day it was given.
 */
export default async function MakersPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const { makers } = await warrantyMakers.list(ctx);
  const writes = can(user.actor, "pricebook:write");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/pricebook">Price book</Crumb>
      <div className="mt-1"><PageHeader title="Makers" count={makers.length} /></div>
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Many makers start a warranty only when the installer registers the unit, within a number of days. Write each
        maker down once with its days, then say on each item which maker it comes from. A unit with a serial number that
        goes on a job gets a deadline to register it, counted from the day it went in. An item with no maker, or a
        maker with no days, uses the days typed on the item itself.
      </p>

      {makers.length === 0 ? (
        <div className="mt-6"><Empty title="No makers yet">Add the makers whose warranties start on registration.</Empty></div>
      ) : (
        <Table label="Makers" head={<><Th>Maker</Th><Th className="text-right">Days to register</Th><Th className="text-right">Items</Th>{writes ? <Th>Change</Th> : null}</>}>
          {makers.map((maker) => (
            <tr key={maker.id}>
              <Td>
                <span className="font-medium">{maker.name}</span>
                {maker.notes ? <span className="block text-xs text-ink-500">{maker.notes}</span> : null}
              </Td>
              <Td className="text-right tabular-nums">{maker.registrationDays ?? "Not given"}</Td>
              <Td className="text-right tabular-nums">{maker.items}</Td>
              {writes ? (
                <Td>
                  <details className="text-sm">
                    <summary className="cursor-pointer py-2 text-ink-700">Change</summary>
                    <ActionForm action={editMaker} submit="Save" hidden={{ id: maker.id }} className="mt-2 space-y-2">
                      <TextField label="Name" name="name" required maxLength={120} defaultValue={maker.name} />
                      <TextField label="Days to register (empty if they have not given any)" name="registrationDays"
                                 inputMode="numeric" defaultValue={maker.registrationDays == null ? "" : String(maker.registrationDays)} />
                      <TextField label="Where to register, and what they ask for" name="notes" maxLength={1000}
                                 defaultValue={maker.notes ?? ""} />
                    </ActionForm>
                    <ActionForm action={retireMaker} submit="Take it off the list" tone="danger" hidden={{ id: maker.id }} className="mt-2" />
                  </details>
                </Td>
              ) : null}
            </tr>
          ))}
        </Table>
      )}

      {writes ? (
        <section aria-label="Add a maker" className="mt-8">
          <h2 className="text-base font-semibold">Add a maker</h2>
          <ActionForm action={addMaker} submit="Add maker" className="mt-3 flex flex-wrap items-end gap-3">
            <TextField label="Name" name="name" required maxLength={120} className="block w-56" />
            <TextField label="Days to register" name="registrationDays" inputMode="numeric" className="block w-40" />
            <TextField label="Where to register, and what they ask for" name="notes" maxLength={1000} className="block w-80" />
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
