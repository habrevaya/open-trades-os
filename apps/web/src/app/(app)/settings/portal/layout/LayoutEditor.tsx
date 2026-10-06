"use client";

import { useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import type { FormState } from "@/lib/actions";

export interface EditorRow {
  kind: string;
  title: string;
  usualTitle: string;
  visible: boolean;
  hideable: boolean;
}

/**
 * THE ACCOUNT PAGE'S BLOCKS, IN ORDER, TO MOVE, HIDE AND RENAME
 *
 * Move up and Move down rather than dragging, because a list of fourteen on a
 * phone is easier to put in order a step at a time than to drag. Every block
 * is posted, in the order on screen, so what is saved is the whole page.
 */
export function LayoutEditor({ rows, save }: {
  rows: EditorRow[];
  save: (previous: FormState, form: FormData) => Promise<FormState>;
}) {
  const [order, setOrder] = useState(rows);
  const move = (index: number, by: -1 | 1) => setOrder((current) => {
    const next = [...current];
    const target = index + by;
    if (target < 0 || target >= next.length) return current;
    [next[index], next[target]] = [next[target]!, next[index]!];
    return next;
  });

  return (
    <ActionForm action={save} submit="Save layout" className="mt-4 space-y-4">
      <ol className="divide-y divide-steel-200 rounded-md border border-steel-200">
        {order.map((row, index) => (
          <li key={row.kind} className="flex flex-wrap items-center gap-3 p-3">
            <input type="hidden" name="kind" value={row.kind} />
            <span className="w-6 text-right font-mono text-sm tabular-nums text-ink-500">{index + 1}</span>
            <label className="min-w-0 flex-1 text-sm">
              <span className="sr-only">Heading for {row.usualTitle}</span>
              <input
                name={`title:${row.kind}`}
                defaultValue={row.title}
                maxLength={60}
                aria-label={`Heading for ${row.usualTitle}`}
                className="h-9 w-full rounded border border-steel-300 bg-canvas px-3 text-sm"
              />
              {row.title !== row.usualTitle && (
                <span className="mt-0.5 block text-xs text-ink-500">Usually called {row.usualTitle}</span>
              )}
            </label>
            <label className="flex items-center gap-2 text-sm">
              {row.hideable ? (
                <input type="checkbox" name={`visible:${row.kind}`} defaultChecked={row.visible}
                       aria-label={`Show ${row.usualTitle}`} />
              ) : (
                <>
                  <input type="hidden" name={`visible:${row.kind}`} value="on" />
                  <input type="checkbox" checked disabled aria-label={`Show ${row.usualTitle}, always shown`} />
                </>
              )}
              {row.hideable ? "Show" : "Always shown"}
            </label>
            <span className="flex gap-1">
              <button type="button" onClick={() => move(index, -1)} disabled={index === 0}
                      aria-label={`Move ${row.usualTitle} up`}
                      className="h-9 rounded border border-steel-300 px-2 text-sm disabled:opacity-40">Up</button>
              <button type="button" onClick={() => move(index, 1)} disabled={index === order.length - 1}
                      aria-label={`Move ${row.usualTitle} down`}
                      className="h-9 rounded border border-steel-300 px-2 text-sm disabled:opacity-40">Down</button>
            </span>
          </li>
        ))}
      </ol>
    </ActionForm>
  );
}
