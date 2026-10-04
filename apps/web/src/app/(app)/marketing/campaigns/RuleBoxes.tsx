import { RULES } from "./rules";

const input = "h-9 rounded border border-steel-300 px-2 text-sm";

/**
 * The audience rules as boxes, for any form that picks people from the
 * customer list by them: texts and emails, and direct mail. One component so
 * the two cannot drift, and `audienceFrom` in `rules.ts` reads either back.
 */
export function RuleBoxes({ legend = "Who" }: { legend?: string }) {
  return (
    <fieldset className="rounded-md border border-steel-200 p-3">
      <legend className="px-1 text-sm font-medium">{legend}</legend>
      <p className="text-xs text-ink-500">
        Combined with AND. Every rule you tick narrows the audience, and an audience with no
        rules at all is refused rather than sent to everybody.
      </p>
      <ul className="mt-2 space-y-2 text-sm">
        {RULES.map((rule) => (
          <li key={rule.kind} className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2">
              <input type="checkbox" name="rule" value={rule.kind} />
              <span>{rule.label}</span>
            </label>
            {rule.fields?.map((box) => (
              <input key={box.name} name={box.name} placeholder={box.placeholder}
                     aria-label={box.label}
                     inputMode={box.numeric ? "numeric" : undefined}
                     className={`${input} ${box.wide ? "w-56" : "w-24"}`} />
            ))}
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
