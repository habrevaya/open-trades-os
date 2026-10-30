import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { officeOnCall } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { addOnCallTurn, removeOnCallTurn, saveOnCallKinds } from "./actions";

export const dynamic = "force-dynamic";

/**
 * SETTINGS: ON CALL FOR THE OFFICE
 *
 * Who is told about a deadline about to be missed, a customer asking to
 * change a visit and an automatic payment that failed. Everybody who handles
 * them, until the company ticks a kind here; then whoever is on call that day,
 * and everybody again when nobody on call can be told. Shown to anybody who
 * may read settings, changed by whoever may write them.
 */
export default async function OfficeOnCallPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const rota = await officeOnCall.view(ctx);
  const writes = can(user.actor, "settings:write");
  const box = "h-4 w-4 rounded border-steel-300";

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Office on call" />
      <p className="mt-2 max-w-prose text-sm text-ink-700">
        Three notices go to everybody who can deal with them. Tick one below to send it only to whoever is on call
        that day. If nobody is on call, or the person on call cannot deal with it, everybody is told as before. This
        is not the after hours rota for customers&apos; calls, which is on the board.
      </p>

      <section aria-label="Who is on call today" className="mt-6 rounded-md border border-steel-200 p-4">
        <h2 className="font-medium text-ink-900">Today ({rota.today})</h2>
        <p className="mt-1 text-sm text-ink-700">
          {rota.onCallToday.length > 0
            ? `On call: ${rota.onCallToday.join(" and ")}.`
            : "Nobody is on call today, so everybody who can deal with these notices is told."}
        </p>
      </section>

      <section aria-label="Notices that go to whoever is on call" className="mt-6 rounded-md border border-steel-200 p-4">
        <h2 className="font-medium text-ink-900">Notices that go to whoever is on call</h2>
        {writes ? (
          <ActionForm action={saveOnCallKinds} submit="Save" className="mt-3 space-y-3">
            <ul className="space-y-2">
              {rota.kinds.map((k) => (
                <li key={k.kind}>
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" name={k.kind} defaultChecked={k.on} className={`mt-0.5 ${box}`} />
                    <span>
                      <span className="font-medium">{k.label}</span>
                      <span className="block text-xs text-ink-500">{k.description}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </ActionForm>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {rota.kinds.map((k) => (
              <li key={k.kind}>{k.label}: {k.on ? "whoever is on call" : "everybody who can deal with it"}</li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="The rota" className="mt-6">
        <h2 className="text-base font-semibold">The rota</h2>
        {rota.turns.length === 0 ? (
          <Empty title="Nobody is on the rota">
            Put somebody on call below. Until then, everybody who can deal with these notices is told.
          </Empty>
        ) : (
          <Table head={<><Th>Person</Th><Th>First day</Th><Th>Last day</Th><Th>Note</Th><Th>{""}</Th></>}>
            {rota.turns.map((t) => (
              <tr key={t.id}>
                <Td>
                  <span className="font-medium">{t.name}</span>
                  {t.today ? <span className="block text-xs text-ink-500">On call today</span> : null}
                </Td>
                <Td>{t.startsOn}</Td>
                <Td>{t.endsOn}</Td>
                <Td>{t.note ?? ""}</Td>
                <Td>
                  {writes ? (
                    <ActionForm action={removeOnCallTurn} submit="Remove" tone="quiet" hidden={{ id: t.id }} className="inline-flex" />
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      {writes ? (
        <section aria-label="Put somebody on call" className="mt-6 rounded-md border border-steel-200 p-4">
          <h2 className="font-medium text-ink-900">Put somebody on call</h2>
          {rota.people.length === 0 ? (
            <p className="mt-1 text-sm text-ink-700">Nobody here can deal with these notices yet.</p>
          ) : (
            <ActionForm action={addOnCallTurn} submit="Put on call" className="mt-3 grid gap-3 sm:grid-cols-2">
              <Select label="Person" name="userId" required
                      options={rota.people.map((p) => ({ value: p.userId, label: p.name }))} className="block sm:col-span-2" />
              <TextField label="First day" name="startsOn" type="date" required defaultValue={rota.today} min={rota.today} />
              <TextField label="Last day" name="endsOn" type="date" defaultValue={rota.today} min={rota.today} />
              <TextField label="Note" name="note" maxLength={300} placeholder="Weekend cover" className="block sm:col-span-2" />
            </ActionForm>
          )}
        </section>
      ) : null}
    </div>
  );
}
