"use client";

import type { ReactNode } from "react";
import { ActionForm } from "@/components/ActionForm";
import { actOnApplication, actOnChangeOrder, actOnLienRecords, setPhaseDates } from "./document-actions";

/**
 * The project document forms, each bound to its server action on the client,
 * because a server page cannot hand a server action to a client form as a
 * prop without this seam. The fields are passed in.
 */
export function ChangeOrderForm(props: {
  submit: string; hidden: Record<string, string>; children?: ReactNode; className?: string;
  tone?: "primary" | "quiet" | "danger"; done?: string;
}) {
  return <ActionForm action={actOnChangeOrder} {...props} />;
}

export function ApplicationForm(props: {
  submit: string; hidden: Record<string, string>; children?: ReactNode; className?: string;
  tone?: "primary" | "quiet" | "danger"; done?: string;
}) {
  return <ActionForm action={actOnApplication} {...props} />;
}

export function LienForm(props: {
  submit: string; hidden: Record<string, string>; children?: ReactNode; className?: string;
  tone?: "primary" | "quiet" | "danger"; done?: string;
}) {
  return <ActionForm action={actOnLienRecords} {...props} />;
}

export function PhaseDatesForm(props: {
  submit: string; hidden: Record<string, string>; children?: ReactNode; className?: string;
}) {
  return <ActionForm action={setPhaseDates} tone="quiet" {...props} />;
}
