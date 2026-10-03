import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { purchaseApprovals, roles } from "@opentradesos/api/services";
import { ROLE_PRESETS, ROLE_IDS, can } from "@opentradesos/core";
import { Money } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { addRuleAction, removeRuleAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * WHO HAS TO SAY YES BEFORE AN ORDER GOES OUT
 *
 * Steps, in order: an order at or over an amount needs somebody holding a
 * role to approve it. Over a thousand, the office manager; over five
 * thousand, the owner as well. An order under every step goes out on the
 * sender's own approval, as it always has. Changing these is company policy
 * about who may commit money, so it needs `settings:write`.
 */
export default async function ApprovalStepsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "po:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Approval steps" />
        <Empty title="Purchasing is not part of your access">Somebody who can change roles can turn this on for you.</Empty>
      </div>
    );
  }
  const writes = can(user.actor, "settings:write");
  const [rules, custom] = await Promise.all([
    purchaseApprovals.listRules(ctx),
    writes && can(user.actor, "role:write") ? roles.list(ctx) : Promise.resolve([]),
  ]);
  const roleOptions = [
    ...ROLE_IDS.filter((r) => r !== "readonly").map((r) => ({ value: r, label: ROLE_PRESETS[r].label })),
    ...custom.map((r) => ({ value: `custom:${r.id}`, label: r.name })),
  ];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Approval steps" />
      <p className="mt-2 max-w-prose text-sm text-ink-700">
        An order at or over a step&apos;s amount waits for somebody holding that role to approve it, the steps in order,
        and nobody approves two steps of the same order. An order under every step goes out on the sender&apos;s own
        approval. A rejected order is cancelled and raised again rather than asked twice.
      </p>
      {rules.length === 0 ? (
        <Empty title="No steps">Whoever may approve orders sends any order of any size.</Empty>
      ) : (
        <Table label="Approval steps" head={<><Th>Step</Th><Th>Orders at or over</Th><Th>Approved by</Th><Th /></>}>
          {rules.map((rule) => (
            <tr key={rule.id}>
              <Td className="tabular-nums">{rule.step}</Td>
              <Td><Money value={rule.minimumTotal} /></Td>
              <Td>{rule.roleLabel}</Td>
              <Td>{writes ? <ActionForm action={removeRuleAction} submit="Remove" tone="quiet" className="" hidden={{ id: rule.id }} /> : null}</Td>
            </tr>
          ))}
        </Table>
      )}
      {writes ? (
        <ActionForm action={addRuleAction} submit="Add step" className="mt-4 flex flex-wrap items-end gap-3">
          <TextField label="Orders at or over" name="minimumTotal" inputMode="decimal" className="w-40" required />
          <Select label="Approved by" name="role" className="w-56" options={roleOptions} />
        </ActionForm>
      ) : null}
    </div>
  );
}
