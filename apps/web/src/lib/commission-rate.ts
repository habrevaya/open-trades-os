/**
 * AN ITEM'S COMMISSION RATE, SAID AS A PERCENT AND KEPT AS A SHARE
 *
 * People say "8 percent"; the price book keeps 0.08 (a share of the line, never above
 * 1, six places at most). This turns one into the other without floating point error
 * in the digits that are kept, and refuses in words anything that is not a rate.
 */

/** "0.0825" shown as "8.25", "0.08" as "8", empty for none. */
export function percentOf(share: string | null | undefined): string {
  if (share === null || share === undefined || share === "") return "";
  const scaled = (Number(share) * 100).toFixed(4);
  return scaled.replace(/\.?0+$/, "");
}

export type ParsedRate = { ok: true; share: string | null } | { ok: false; error: string };

/** "8.25" to "0.0825"; empty to null (back to the person's own plan). */
export function shareOf(percent: string | null | undefined): ParsedRate {
  const typed = (percent ?? "").trim().replace(/%$/, "").trim();
  if (typed === "") return { ok: true, share: null };
  if (!/^\d+(\.\d{1,4})?$/.test(typed)) {
    return { ok: false, error: "Type the commission as a percent, like 8 or 7.5, with at most four places." };
  }
  const value = Number(typed);
  if (value > 100) return { ok: false, error: "A commission cannot be more than 100 percent of the line." };
  const share = (value / 100).toFixed(6).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return { ok: true, share: share === "" ? "0" : share };
}
