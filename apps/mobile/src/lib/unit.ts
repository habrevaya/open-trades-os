import { equipmentPayload, type UnitOnSite } from "@opentradesos/field-client";

/**
 * A UNIT TYPED ON SITE, BEFORE IT GOES INTO THE QUEUE
 *
 * What the "Equipment here" form becomes, or the sentence that says what is
 * missing. The serial is matched by the server across every address the
 * company has (`field.decideSerial` in core), so the form does not try to
 * match it here: the phone has no register to match against offline.
 */
export interface UnitForm {
  category: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  location: string;
}

export const EMPTY_UNIT: UnitForm = { category: "", manufacturer: "", model: "", serialNumber: "", location: "" };

export function unitFromForm(
  form: UnitForm, visit: { id: string; property: { id: string } },
): { unit: UnitOnSite } | { problem: string } {
  const unit: UnitOnSite = {
    visitId: visit.id, propertyId: visit.property.id, category: form.category,
    manufacturer: form.manufacturer, model: form.model, serialNumber: form.serialNumber, location: form.location,
  };
  try {
    equipmentPayload(unit);
  } catch (error) {
    return { problem: (error as Error).message };
  }
  return { unit };
}

/** What the technician is told once it is saved, which depends on whether there was a serial to match. */
export function unitSavedLine(form: UnitForm): string {
  return form.serialNumber.trim() === ""
    ? "Saved on this phone. With no serial it is added as a new unit at this address."
    : "Saved on this phone. The office's register is checked for that serial at every address before it is added.";
}
