"use client";

import { useEffect } from "react";
import { releaseHeldSubmits } from "@/lib/held-submits";

/** Sends any form pressed before the page was ready. See `lib/held-submits.ts`. */
export function HeldSubmits() {
  useEffect(() => { releaseHeldSubmits(); }, []);
  return null;
}
