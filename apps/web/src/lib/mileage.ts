/**
 * WHOSE RATE A CLAIM IN MILES WAS WORKED OUT AT, IN WORDS
 *
 * A claim keeps the rate it was worked out at and where that rate came from (M17). The company's own
 * rate needs no note, because it is the ordinary case; the person's own, a vehicle's and a kind of work's say so.
 * `whose` is how the reader is told it: "your own" on the person's page, a name on the office's. `toWhom` is who
 * a vehicle was checked out to, in the same voice: "you", or the person's name.
 *
 * A vehicle taken from the fleet's custody record, because none was named, says so; and a vehicle checked out
 * that day that the claim was not worked out at is named, so the office deciding it can see it.
 */
export function rateSourceNote(
  claim: {
    mileageRateSource: "company" | "person" | "vehicle" | "work" | null;
    mileageVehicle: string | null;
    mileageWork?: string | null | undefined;
    mileageVehicleFrom?: "picked" | "checked_out" | null | undefined;
    mileageCheckedOut?: string | null | undefined;
  },
  whose: string,
  toWhom = "them",
): string {
  const vehicle = claim.mileageVehicle ?? "the vehicle";
  const source = claim.mileageRateSource === "person" ? `${whose} rate`
    : claim.mileageRateSource === "vehicle"
      ? claim.mileageVehicleFrom === "checked_out"
        ? `the rate for ${vehicle}, which was checked out to ${toWhom} that day`
        : `the rate for ${vehicle}`
      : claim.mileageRateSource === "work" ? `the rate for ${claim.mileageWork ?? "the kind of work"} work` : "";
  const passedOver = claim.mileageCheckedOut
    ? `${claim.mileageCheckedOut} was checked out to ${toWhom} that day but was not what the claim says was driven`
    : "";
  return [source, passedOver].filter((part) => part !== "").join("; ");
}
