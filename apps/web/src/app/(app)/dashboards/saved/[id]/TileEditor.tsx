"use client";

import { useActionState } from "react";
import { addTile, removeTile, moveTile } from "../../actions";

export interface ReportOption {
  /** `saved:<uuid>` or `builtIn:<slug>`, because both are strings. */
  value: string;
  label: string;
  group: string;
}

/**
 * ADDING AND ARRANGING TILES
 *
 * Every one of these posts the tiles it started from alongside the change.
 * The server writes the whole list, so a change is "these plus this" rather
 * than a read, an append and a write, which cannot half apply.
 *
 * Two people with the same dashboard open means the second save wins. That
 * is the honest behaviour for a layout: the whole arrangement is the unit,
 * and merging two orderings would have to invent one nobody chose.
 */
export function AddTile({ id, tiles, reports }: {
  id: string;
  tiles: string;
  reports: ReportOption[];
}) {
  const [state, submit, pending] = useActionState(addTile, null);
  const groups = [...new Set(reports.map((r) => r.group))];

  if (reports.length === 0) {
    return (
      <p className="mt-3 text-sm text-ink-500">
        There is nothing to put on it yet. Build a report first and it will
        show up here.
      </p>
    );
  }

  return (
    <form action={submit} className="mt-3 flex flex-wrap items-end gap-3">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="tiles" value={tiles} />

      <label className="text-sm">
        <span className="block text-ink-700">Show</span>
        <select name="report" className="mt-1 h-9 max-w-64 rounded border border-steel-300 px-2">
          {groups.map((group) => (
            <optgroup key={group} label={group}>
              {reports.filter((r) => r.group === group).map((report) => (
                <option key={report.value} value={report.value}>{report.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <label className="text-sm">
        <span className="block text-ink-700">As</span>
        <select name="kind" defaultValue="bars" className="mt-1 h-9 rounded border border-steel-300 px-2">
          {/*
            What each shape needs is said here rather than discovered by
            being refused. A number tile takes a report with no grouping and
            a trend takes one grouped by a date, and neither is guessable.
          */}
          <option value="number">One number, from a report with no grouping</option>
          <option value="bars">Bars, from a report grouped by one thing</option>
          <option value="trend">A trend, from a report grouped by a date</option>
        </select>
      </label>

      <label className="text-sm">
        <span className="block text-ink-700">Width</span>
        <select name="width" defaultValue="6" className="mt-1 h-9 rounded border border-steel-300 px-2">
          <option value="3">Quarter</option>
          <option value="6">Half</option>
          <option value="12">Full</option>
        </select>
      </label>

      <label className="text-sm">
        <span className="block text-ink-700">Call it</span>
        <input
          name="title" placeholder="The report's own name"
          className="mt-1 h-9 w-48 rounded border border-steel-300 px-2"
        />
      </label>

      <button type="submit" disabled={pending}
              className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100 disabled:opacity-60">
        {pending ? "Adding" : "Add it"}
      </button>
      {state && "error" in state && state.error ? (
        <span role="alert" className="pb-2 text-sm text-red-600">{state.error}</span>
      ) : null}
    </form>
  );
}

export function TileControls({ id, tiles, tileKey, first, last }: {
  id: string;
  tiles: string;
  tileKey: string;
  first: boolean;
  last: boolean;
}) {
  const [, move, moving] = useActionState(moveTile, null);
  const [, remove, removing] = useActionState(removeTile, null);

  return (
    <span className="flex items-center gap-1 text-xs text-ink-500">
      <form action={move}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="tiles" value={tiles} />
        <input type="hidden" name="key" value={tileKey} />
        <input type="hidden" name="direction" value="up" />
        {/*
          Disabled at the ends rather than wrapping. A tile that jumps from
          the top to the bottom because somebody pressed up once too often is
          a change they have to undo and will not be sure how.
        */}
        <button type="submit" disabled={first || moving} aria-label="Move up"
                className="rounded px-1 hover:bg-steel-100 disabled:opacity-30">Up</button>
      </form>
      <form action={move}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="tiles" value={tiles} />
        <input type="hidden" name="key" value={tileKey} />
        <input type="hidden" name="direction" value="down" />
        <button type="submit" disabled={last || moving} aria-label="Move down"
                className="rounded px-1 hover:bg-steel-100 disabled:opacity-30">Down</button>
      </form>
      <form action={remove}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="tiles" value={tiles} />
        <input type="hidden" name="key" value={tileKey} />
        <button type="submit" disabled={removing} aria-label="Remove this tile"
                className="rounded px-1 hover:bg-steel-100 hover:text-red-600 disabled:opacity-30">
          Remove
        </button>
      </form>
    </span>
  );
}
