"use client";

import { OpForm } from "@/components/OpForm";
import { act } from "../actions";

/**
 * The switch on one row. Off asks why, in a box nobody has to fill, and the
 * reason is shown beside the state and kept in the audit log; on is one
 * button. The row's own name is in each label, because a page of "Turn off"
 * buttons is a page nobody can use with a screen reader.
 */
export function SwitchPlugin({ id, name, on }: { id: string; name: string; on: boolean }) {
  return on ? (
    <OpForm action={act} op="plugin-off" label="Turn off" quiet hidden={{ id }}>
      <input name="reason" placeholder="Why (optional)" maxLength={300}
             aria-label={`Why ${name} is being turned off`}
             className="h-8 w-40 rounded border border-steel-300 px-2 text-sm" />
    </OpForm>
  ) : (
    <OpForm action={act} op="plugin-on" label="Turn on" quiet hidden={{ id }} />
  );
}
