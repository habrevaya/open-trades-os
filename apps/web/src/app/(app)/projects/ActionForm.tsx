"use client";

import type { ReactNode } from "react";
import { OpForm } from "@/components/OpForm";
import { act } from "./actions";

export function ActionForm({ projectId, tone = "primary", ...props }: {
  op: string; projectId?: string; label: string; children?: ReactNode; className?: string;
  tone?: "primary" | "quiet";
}) {
  return <OpForm action={act} quiet={tone === "quiet"} hidden={projectId ? { projectId } : {}} {...props} />;
}
