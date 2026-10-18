"use client";

import { useState } from "react";
import { Select, TextField } from "@/components/ActionForm";

/** Why the company called a day off, from core's list, passed in so this client file imports no server code. */
export interface CancelReasonOption { value: string; label: string }

/**
 * WHO ASKED TO CALL IT OFF, AND, WHEN WE DID, WHY.
 *
 * Asked every time, with no default: a customer's late cancellation and a rain
 * day are different numbers. The reason appears only when "We called it off" is
 * chosen, and is required then, because a customer is never asked why they
 * cancelled and a company's own day off with no reason is the blank this
 * exists to remove. "Something else" asks for words.
 */
export function CalledOffFields({
  name, label, reasons, initial = "", strict = false,
}: {
  /** The name the who field posts under: `by` on a visit, `cancelledBy` on a job. */
  name: string;
  label: string;
  reasons: readonly CancelReasonOption[];
  initial?: "" | "customer" | "company";
  /** The browser insists on an answer. Off on the job's form, where the visits may be left alone and the server asks instead. */
  strict?: boolean;
}) {
  const [who, setWho] = useState<string>(initial);
  const [why, setWhy] = useState("");
  return (
    <>
      <Select label={label} name={name} required={strict} value={who} className="block w-72"
              onChange={(event) => setWho(event.target.value)} options={[
        { value: "", label: "Choose" },
        { value: "customer", label: "The customer asked" },
        { value: "company", label: "We called it off" },
      ]} />
      {who === "company" && (
        <>
          <Select label="Why we called it off" name="cancelReason" required={strict} value={why} className="block w-72"
                  onChange={(event) => setWhy(event.target.value)}
                  options={[{ value: "", label: "Choose" }, ...reasons]} />
          <TextField label={why === "other" ? "What was the reason?" : "More about it, if you like"} name="cancelReasonNote"
                     required={strict && why === "other"} maxLength={500} className="block w-72" />
        </>
      )}
    </>
  );
}
