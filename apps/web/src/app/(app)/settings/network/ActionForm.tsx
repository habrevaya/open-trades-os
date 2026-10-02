"use client";

import { OpForm } from "@/components/OpForm";
import { act } from "./actions";

export function ActionForm({ op, label, aggregate }: { op: string; label: string; aggregate: string }) {
  return <OpForm action={act} op={op} label={label} quiet hidden={{ aggregate }} className="inline-flex" />;
}
