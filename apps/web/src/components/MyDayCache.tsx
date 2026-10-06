"use client";

import { useEffect } from "react";
import { claimCache, forgetMyDay } from "@/lib/my-day-offline";

/**
 * Keeps the copy of `/my-day` kept for no signal belonging to whoever is
 * signed in. On every signed in page it claims it for this person, which
 * empties it first when it was somebody else's; on the sign in page, where
 * signing out lands, it empties it. Draws nothing.
 */
export function MyDayCache({ person }: { person: string | null }) {
  useEffect(() => {
    (person ? claimCache(person) : forgetMyDay()).catch(() => undefined);
  }, [person]);
  return null;
}
