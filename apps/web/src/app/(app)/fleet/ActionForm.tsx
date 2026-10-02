"use client";

import type { ReactNode } from "react";
import { OpForm } from "@/components/OpForm";
import { act } from "./actions";

export function ActionForm(props: {
  op: string; label: string; children?: ReactNode; className?: string; quiet?: boolean;
  hidden?: Record<string, string>;
}) {
  return <OpForm action={act} {...props} />;
}
