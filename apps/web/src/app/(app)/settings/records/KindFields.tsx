import { TextArea, TextField } from "@/components/ActionForm";

/**
 * The boxes that say what a kind of record is: shared by defining one and
 * changing one, so the two forms cannot ask different questions.
 */

export const LINKS = [
  { value: "customer", label: "A customer" },
  { value: "property", label: "An address" },
  { value: "job", label: "A job" },
  { value: "equipment", label: "A unit of equipment" },
] as const;

/**
 * Who may see and change one, in words. Every record needs the gate
 * (`record:read`, `record:write`) first; these narrow it further. The
 * catalogue has every permission and the API takes any of them; the screen
 * offers the few a contractor actually reaches for, and keeps whatever a
 * kind already names.
 */
export const READERS = [
  { value: "record:read", label: "Everybody who can see your records" },
  { value: "customer:write", label: "Only the office (people who can change customers)" },
  { value: "job.cost:read", label: "Only people who can see job costs" },
  { value: "settings:write", label: "Only people who can change settings" },
];
export const WRITERS = [
  { value: "record:write", label: "Everybody who can add records" },
  { value: "customer:write", label: "Only the office (people who can change customers)" },
  { value: "settings:write", label: "Only people who can change settings" },
];

const withCurrent = (options: { value: string; label: string }[], current: string | undefined) =>
  current && !options.some((o) => o.value === current) ? [...options, { value: current, label: current }] : options;

export function KindFields({ kind }: {
  kind?: {
    label: string; pluralLabel: string; titleLabel: string; description: string | null;
    links: string[]; readPermission: string; writePermission: string;
  };
}) {
  const box = "mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm";
  return (
    <>
      <TextField label="What one is called" name="label" required maxLength={60} placeholder="Permit" defaultValue={kind?.label} />
      <TextField label="More than one" name="pluralLabel" maxLength={60} placeholder="Permits" defaultValue={kind?.pluralLabel} />
      <TextField label="What each one's name is" name="titleLabel" maxLength={60} placeholder="Permit number" defaultValue={kind?.titleLabel} />
      <div className="sm:col-span-2">
        <TextArea label="What it is for (optional)" name="description" rows={2} maxLength={500} defaultValue={kind?.description ?? ""} />
      </div>
      <fieldset className="sm:col-span-2">
        <legend className="text-sm font-medium text-ink-700">Each one can point at</legend>
        <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1">
          {LINKS.map((link) => (
            <label key={link.value} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="links" value={link.value} defaultChecked={kind?.links.includes(link.value) ?? false} className="h-4 w-4" />
              {link.label}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-ink-500">One put on a job is put on that job&apos;s customer and address too.</p>
      </fieldset>
      <label className="block">
        <span className="text-sm font-medium text-ink-700">Who can see them</span>
        <select name="readPermission" defaultValue={kind?.readPermission ?? "record:read"} className={box}>
          {withCurrent(READERS, kind?.readPermission).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="text-sm font-medium text-ink-700">Who can add and change them</span>
        <select name="writePermission" defaultValue={kind?.writePermission ?? "record:write"} className={box}>
          {withCurrent(WRITERS, kind?.writePermission).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
    </>
  );
}
