import type { deliverySchedules } from "@opentradesos/api/services";
import { field, fields } from "./actions";

/**
 * The schedule a submitted form describes.
 *
 * The report arrives as `builtIn:{slug}` or `saved:{id}`, the same pair a
 * dashboard tile uses. Addresses arrive as one box, split on commas, spaces
 * and new lines, because that is how people paste a list of them. Nothing is
 * validated here: the service checks every field against the person saving it
 * and says what is wrong in its own words.
 */
export function scheduleFromForm(form: FormData): deliverySchedules.ReportScheduleInput {
  const report = field(form, "report") ?? "";
  const number = (name: string) => {
    const value = field(form, name);
    return value === undefined ? undefined : Number(value);
  };
  const name = field(form, "name");
  const period = field(form, "period");
  return {
    ...(report.startsWith("builtIn:") ? { builtIn: report.slice("builtIn:".length) } : {}),
    ...(report.startsWith("saved:") ? { reportId: report.slice("saved:".length) } : {}),
    ...(name ? { name } : {}),
    frequency: field(form, "frequency") ?? "",
    weekdays: fields(form, "weekdays").map(Number),
    ...(number("dayOfMonth") !== undefined ? { dayOfMonth: number("dayOfMonth") } : {}),
    time: field(form, "time") ?? "",
    ...(period ? { period } : {}),
    userIds: fields(form, "userIds"),
    addresses: (field(form, "addresses") ?? "").split(/[\s,;]+/).filter((v) => v !== ""),
  };
}
