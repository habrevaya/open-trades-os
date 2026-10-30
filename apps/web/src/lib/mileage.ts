/**
 * WHOSE RATE A CLAIM IN MILES WAS WORKED OUT AT, IN WORDS
 *
 * A claim keeps the rate it was worked out at and where that rate came from (M17). The company's own
 * rate needs no note, because it is the ordinary case; the person's own and a vehicle's say so.
 * `whose` is how the reader is told it: "your own" on the person's page, a name on the office's.
 */
export function rateSourceNote(
  claim: { mileageRateSource: "company" | "person" | "vehicle" | null; mileageVehicle: string | null },
  whose: string,
): string {
  if (claim.mileageRateSource === "person") return `${whose} rate`;
  if (claim.mileageRateSource === "vehicle") return `the rate for ${claim.mileageVehicle ?? "the vehicle"}`;
  return "";
}
