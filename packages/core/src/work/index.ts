/**
 * HOW URGENT A JOB IS
 *
 * `job.priority` has been an integer defaulting to zero since the first
 * migration, written by nothing and read by two things that could not say
 * what it meant: the job screen rendered a bare "0", and the report
 * catalogue offered a dimension called Priority that grouped every job in
 * the company into a bucket named "0".
 *
 * An integer with no declared scale is worse than no column. So the scale is
 * declared here, once, and everything that shows it or groups by it reads the
 * same list.
 *
 * Deliberately small, and deliberately not the task vocabulary. A task can be
 * low priority because somebody will get to it eventually; a job is work
 * somebody is waiting at a property for, and "low" is not a thing a
 * dispatcher does with it. Normal is the absence of urgency rather than a
 * choice, which is why it is zero and why a screen does not need to say it.
 */
export interface JobPriority {
  value: number;
  label: string;
  /** What it means to a dispatcher, which is the only reason to set one. */
  meaning: string;
}

export const JOB_PRIORITY: JobPriority[] = [
  { value: 0, label: "Normal", meaning: "Goes in the schedule like everything else." },
  { value: 1, label: "High", meaning: "Fit it in today if there is any room." },
  { value: 2, label: "Emergency", meaning: "Somebody is without heat, water or power." },
];

/** The default, and the one a screen does not need to say out loud. */
export const NORMAL_PRIORITY = 0;

export function priorityLabel(value: number): string {
  return JOB_PRIORITY.find((p) => p.value === value)?.label
    /**
     * A number outside the scale is shown rather than hidden. It came from
     * somewhere, probably an import, and a reader deciding what to do with
     * the job is better served by "priority 7" than by silence.
     */
    ?? `Priority ${value}`;
}

/**
 * The scale as a SQL CASE, for grouping a report by it.
 *
 * Generated from the same list rather than written out beside it, because two
 * copies of a scale is how a report ends up disagreeing with the screen about
 * what a job is.
 */
export function prioritySql(column: string): string {
  const whens = JOB_PRIORITY
    .map((p) => `when ${column} = ${p.value} then '${p.label}'`)
    .join(" ");
  return `case ${whens} else 'Priority ' || ${column}::text end`;
}
