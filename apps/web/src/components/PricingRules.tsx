import { Money } from "@opentradesos/ui";

/**
 * THE PRICING RULES THAT TOUCHED A LINE, SAID ON THE LINE
 *
 * A connected application can register rules that take money off or add it
 * (M28). Never silently, for the same reason a member discount is shown:
 * the office and the customer both need to see why a line is not the price
 * book's price, and which rule, from which application, made it so.
 */
export function PricingRules({ rules }: { rules?: ReadonlyArray<{ name: string; appName: string; amount: string }> | undefined }) {
  if (!rules || rules.length === 0) return null;
  return (
    <ul className="mt-0.5 text-xs text-ink-500">
      {rules.map((rule, index) => (
        <li key={`${rule.name}:${index}`}>
          {rule.name} ({rule.appName}){rule.amount.startsWith("-") ? ", taken off: " : ", added: "}
          <Money value={rule.amount.replace(/^-/, "")} muted />
        </li>
      ))}
    </ul>
  );
}
