import Link from "next/link";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { packMarks } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { packById } from "@opentradesos/trade-packs";
import { Chip } from "@opentradesos/ui";
import { Empty, PageHeader, Table, Th, Td } from "@/components/Table";
import { MarkForm } from "./MarkForm";

export const dynamic = "force-dynamic";

/**
 * WHAT THE SCORECARD COUNTS AS A TROUBLESHOOTING CALL OR A DRAIN CALL
 *
 * Two numbers on the scorecard turn on which job types and items are which,
 * and the trade pack can only mark the ones it set up, by their codes. A job
 * type or item the company made itself is marked here, and the page says what
 * marking it changes in the numbers before anybody ticks a box.
 */

/** What a mark changes in its number, in plain words, for a job type and for an item. */
const CHANGES: Record<string, { jobType?: string; item?: string }> = {
  troubleshooting: {
    jobType: "Its finished jobs count as troubleshooting calls: each one goes into the bottom of Troubleshooting conversion, and into the top too when repair work was done or an estimate was approved on the visit.",
    item: "It counts as the charge for finding the fault, not as repair work. A call with only this on it no longer counts as converted, so the number can go down.",
  },
  drain: {
    jobType: "Its finished jobs count as drain calls: each one goes into the bottom of Drain call conversion, and into the top when it sold a camera inspection, a lining or an excavation.",
  },
  drain_upsell: {
    item: "A drain call that sold it, on the job, on a job raised from it, or on the option the customer chose, counts as converted, so the number can go up.",
  },
};

const NAMES: Record<string, { jobType: string; item: string }> = {
  troubleshooting: { jobType: "Troubleshooting call", item: "Charge for finding the fault" },
  drain: { jobType: "Drain call", item: "" },
  drain_upsell: { jobType: "", item: "Drain call upsell" },
};

const box = "h-8 rounded border border-steel-300 px-2 text-sm";

export default async function ScorecardMarksPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "report:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="What the scorecard counts" />
        <Empty title="Reports are not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      </div>
    );
  }

  const view = await packMarks.list(ctx);
  const writes = can(user.actor, "settings:write");
  const offeredAny = view.offered.jobType.length > 0 || view.offered.item.length > 0;
  const markedItems = view.items.filter((i) => i.fromPack.length > 0 || i.byHand.length > 0);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="What the scorecard counts" action={<Link href="/reports/scorecard" className="text-sm underline">Back to the scorecard</Link>} />
      <p className="mt-2 text-sm text-ink-700">
        Some numbers on the scorecard need to know which of your job types and items are which. Your trade pack marks
        the ones it set up. If you made your own, under another code, mark them here and the scorecard counts them the
        same way, for every month, past ones too.
      </p>

      {view.tradePack === null ? (
        <Empty title="No trade chosen yet">Apply a trade pack in setup first. The marks belong to its scorecard.</Empty>
      ) : !offeredAny ? (
        <Empty title="Nothing to mark">
          No number on the {packById(view.tradePack)?.name ?? view.tradePack} scorecard depends on marks, so there is nothing to set here.
        </Empty>
      ) : (
        <>
          <section className="mt-6" aria-labelledby="changes">
            <h2 id="changes" className="text-base font-semibold">What marking changes</h2>
            <ul className="mt-2 space-y-2 text-sm text-ink-700">
              {view.meanings.map((m) => (
                <li key={m.mark}>
                  <span className="font-medium">{m.number}.</span>{" "}
                  {CHANGES[m.mark]?.jobType && view.offered.jobType.includes(m.mark as "troubleshooting" | "drain") ? (
                    <>A job type marked {NAMES[m.mark]!.jobType.toLowerCase()}: {CHANGES[m.mark]!.jobType} </>
                  ) : null}
                  {CHANGES[m.mark]?.item && view.offered.item.includes(m.mark as "troubleshooting" | "drain_upsell") ? (
                    <>An item marked {NAMES[m.mark]!.item.toLowerCase()}: {CHANGES[m.mark]!.item}</>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-ink-500">
              A mark your trade pack gave stays: you can add marks, not take the pack&apos;s away. No price changes.
            </p>
          </section>

          {view.offered.jobType.length > 0 ? (
            <section className="mt-8" aria-labelledby="types">
              <h2 id="types" className="text-base font-semibold">Job types</h2>
              <Table label="Job types and their marks" head={<><Th>Job type</Th><Th>Code</Th><Th>Marked</Th></>}>
                {view.jobTypes.map((t) => (
                  <tr key={t.id}>
                    <Td className="font-medium">{t.name}</Td>
                    <Td className="text-ink-500">{t.code ?? "None"}</Td>
                    <Td>
                      {t.fromPack.map((m) => <Chip key={m} tone="info" className="mr-1">{NAMES[m]!.jobType}, by the trade pack</Chip>)}
                      {writes ? (
                        <MarkForm op="jobType" label="Save" quiet hidden={{ id: t.id }} className="mt-1 flex flex-wrap items-center gap-2">
                          {view.offered.jobType.filter((m) => !t.fromPack.includes(m)).map((m) => (
                            <label key={m} className="flex items-center gap-1 text-sm text-ink-700">
                              <input type="checkbox" name="mark" value={m} defaultChecked={t.byHand.includes(m)}
                                     aria-label={`${t.name} is a ${NAMES[m]!.jobType.toLowerCase()}`} />
                              {NAMES[m]!.jobType}
                            </label>
                          ))}
                        </MarkForm>
                      ) : t.byHand.map((m) => <Chip key={m} tone="neutral" className="mr-1">{NAMES[m]!.jobType}</Chip>)}
                    </Td>
                  </tr>
                ))}
              </Table>
            </section>
          ) : null}

          {view.offered.item.length > 0 ? (
            <section className="mt-8" aria-labelledby="items">
              <h2 id="items" className="text-base font-semibold">Items</h2>
              {markedItems.length === 0 ? (
                <p className="mt-2 text-sm text-ink-500">No items are marked.</p>
              ) : (
                <Table label="Marked items" head={<><Th>Item</Th><Th>Code</Th><Th>Marked</Th></>}>
                  {markedItems.map((i) => (
                    <tr key={i.id}>
                      <Td className="font-medium">{i.name}</Td>
                      <Td className="text-ink-500">{i.code}</Td>
                      <Td>
                        {i.fromPack.map((m) => <Chip key={m} tone="info" className="mr-1">{NAMES[m]!.item}, by the trade pack</Chip>)}
                        {writes && view.offered.item.some((m) => !i.fromPack.includes(m)) ? (
                          <MarkForm op="item" label="Save" quiet hidden={{ id: i.id }} className="mt-1 flex flex-wrap items-center gap-2">
                            {view.offered.item.filter((m) => !i.fromPack.includes(m)).map((m) => (
                              <label key={m} className="flex items-center gap-1 text-sm text-ink-700">
                                <input type="checkbox" name="mark" value={m} defaultChecked={i.byHand.includes(m)}
                                       aria-label={`${i.name} is a ${NAMES[m]!.item.toLowerCase()}`} />
                                {NAMES[m]!.item}
                              </label>
                            ))}
                          </MarkForm>
                        ) : writes ? null : i.byHand.map((m) => <Chip key={m} tone="neutral" className="mr-1">{NAMES[m]!.item}</Chip>)}
                      </Td>
                    </tr>
                  ))}
                </Table>
              )}
              {writes ? (
                <div className="mt-4">
                  <h3 className="text-sm font-medium text-ink-700">Mark an item</h3>
                  <MarkForm op="item" label="Mark it" className="mt-2 flex flex-wrap items-center gap-2">
                    <select name="id" className={box} aria-label="Item to mark" defaultValue="">
                      <option value="">Choose an item</option>
                      {view.items.filter((i) => i.byHand.length === 0).map((i) => (
                        <option key={i.id} value={i.id}>{i.name} ({i.code})</option>
                      ))}
                    </select>
                    {view.offered.item.map((m) => (
                      <label key={m} className="flex items-center gap-1 text-sm text-ink-700">
                        <input type="checkbox" name="mark" value={m} aria-label={`The item is a ${NAMES[m]!.item.toLowerCase()}`} />
                        {NAMES[m]!.item}
                      </label>
                    ))}
                  </MarkForm>
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
