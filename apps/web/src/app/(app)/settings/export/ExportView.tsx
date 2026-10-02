import type { dataExport } from "@opentradesos/api/services";
import { Table, Th, Td } from "@/components/Table";

type Manifest = dataExport.Manifest;

/**
 * WHAT IS IN THE FILE, BEFORE ANYBODY DOWNLOADS IT
 *
 * A row count per table is the thing that makes an export checkable: somebody
 * who pulls 14,812 customers and had 14,900 has a problem they can see. Without
 * it a download is a file and a hope, which is exactly the complaint the
 * comparison pages make about every incumbent's export.
 *
 * Tables with no rows are shown too, greyed. An owner comparing this against
 * their old system needs to know that `rental` is empty rather than missing.
 */
export function Tables({ manifest }: { manifest: Manifest }) {
  return (
    <Table head={<><Th>Table</Th><Th className="text-right">Rows</Th><Th>Key</Th><Th>Held back</Th></>}>
      {manifest.tables.map((table) => (
        <tr key={table.table} className={table.rows === 0 ? "text-ink-500" : undefined}>
          <Td><span className="font-mono text-xs">{table.table}</span></Td>
          <Td className="text-right tabular-nums">{table.rows.toLocaleString("en-US")}</Td>
          <Td><span className="font-mono text-xs">{table.key.join(", ")}</span></Td>
          <Td>
            {table.redacted.length === 0 ? (
              <span className="text-ink-500">Nothing</span>
            ) : (
              <ul className="space-y-1">
                {table.redacted.map((column) => (
                  <li key={column.column}>
                    <span className="font-mono text-xs">{column.column}</span>
                    <span className="block text-xs text-ink-700">{column.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </Td>
        </tr>
      ))}
    </Table>
  );
}

/**
 * The tables that are NOT in the file, each with a reason.
 *
 * An absence nobody wrote down is an omission a reader has to notice. Naming
 * them is the difference between "your data, minus four things, here is why"
 * and a file somebody discovers is incomplete after they have switched.
 */
export function Outside({ manifest }: { manifest: Manifest }) {
  return (
    <ul className="mt-3 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
      {manifest.outsideTheTenant.map((row) => (
        <li key={row.table} className="bg-canvas p-4">
          <span className="font-mono text-xs">{row.table}</span>
          <p className="mt-1 text-sm text-ink-700">{row.reason}</p>
        </li>
      ))}
    </ul>
  );
}
