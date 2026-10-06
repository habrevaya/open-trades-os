import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customObjects } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { ActionForm, TextField } from "@/components/ActionForm";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { KindFields, LINKS } from "./KindFields";
import { defineKind } from "./actions";

export const dynamic = "force-dynamic";

/**
 * SETTINGS, KINDS OF RECORD
 *
 * The lists a company keeps that the product never heard of: permits,
 * warranty registrations, the Monday truck inspection. Each is defined here
 * with what it is called, what it points at and who may see and change one;
 * its fields are added on its own page, and its records live under Records,
 * on the jobs and customers they point at, in reports and in automations.
 */
export default async function KindsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "settings:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Kinds of record" />
        <Empty title="Settings are not part of your access">Somebody who can change roles can turn this on for you.</Empty>
      </div>
    );
  }
  const kinds = await customObjects.definedKinds(ctx);
  const writes = can(user.actor, "customfield:write");
  const linkWords = (links: string[]) =>
    links.length === 0 ? "Nothing" : links.map((l) => LINKS.find((x) => x.value === l)?.label.replace(/^An? /, "") ?? l).join(", ");

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
      <PageHeader title="Kinds of record" count={kinds.length} />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Lists your company keeps that the product does not have: permits, warranty registrations, truck inspections.
        Each gets its own list under Records, a form drawn from its fields, a place on the jobs and customers it
        points at, a dataset in the report builder, and a trigger for automations.
        {!writes ? " Defining them needs the Define custom fields permission." : ""}
      </p>

      {kinds.length === 0 ? (
        <Empty title="No kinds of record yet">Define one below, then add its fields.</Empty>
      ) : (
        <Table head={<><Th>Kind</Th><Th>Points at</Th><Th className="text-right">Fields</Th><Th className="text-right">On file</Th></>}>
          {kinds.map((kind) => (
            <tr key={kind.id}>
              <Td>
                <a href={`/settings/records/${kind.key}`} className="font-medium underline underline-offset-4">{kind.pluralLabel}</a>
                <span className="ml-2 font-mono text-xs text-ink-500">{kind.key}</span>
                {kind.description ? <span className="block text-xs text-ink-500">{kind.description}</span> : null}
              </Td>
              <Td className="text-ink-700">
                {linkWords(kind.links)}
                {kind.customerVisible ? <span className="block text-xs text-ink-500">Shown to the customer</span> : null}
              </Td>
              <Td className="text-right tabular-nums">{kind.fields.length}</Td>
              <Td className="text-right tabular-nums">{kind.records}</Td>
            </tr>
          ))}
        </Table>
      )}

      {writes ? (
        <section className="mt-12" aria-labelledby="add-kind">
          <h2 id="add-kind" className="text-base font-semibold">Define a kind of record</h2>
          <ActionForm action={defineKind} submit="Define it" className="mt-3 grid max-w-3xl gap-3 sm:grid-cols-2">
            <TextField label="Key it is stored under" name="key" required maxLength={48} placeholder="permit"
                       pattern="[a-z][a-z0-9_]*" title="Lowercase letters, digits and underscores, starting with a letter" />
            <KindFields others={kinds.map((k) => ({ key: k.key, label: k.pluralLabel }))} />
            <p className="text-xs text-ink-500 sm:col-span-2">
              The key cannot be changed later, because its fields and every automation that uses it name it. Everything else can.
            </p>
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
