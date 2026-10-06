import { can } from "@opentradesos/core";
import { afterHours, priceBook, type ServiceContext } from "@opentradesos/api/services";
import { ActionForm, Select } from "@/components/ActionForm";
import { saveRates } from "./actions";

const price = (value: string) => `$${Number(value).toFixed(2)}`;

/**
 * THE AFTER HOURS RATE AND THE HOLIDAY RATE
 *
 * Two picks from the price book. Drawn under Settings and as its own setup
 * step. What choosing one does is said beside the form, because choosing an
 * item marks it as the after hours rate, and a plan that waives that rate
 * then waives it for members.
 */
export async function RatesSection({ ctx }: { ctx: ServiceContext }) {
  if (!can(ctx.actor, "pricebook:read")) {
    return <p className="text-sm text-ink-500">The rates are price book items, and reading them needs the price book.</p>;
  }
  const current = await afterHours.rates(ctx);
  const writes = can(ctx.actor, "pricebook:write");
  const items = (await priceBook.list(ctx, { limit: 200, includeInactive: false })).data
    .map((item) => ({ value: item.id, label: `${item.name} (${price(item.price)})` }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const options = [{ value: "", label: "None" }, ...items];

  return (
    <section aria-label="After hours and holiday rates">
      <p className="max-w-2xl text-sm text-ink-700">
        When a job&rsquo;s visit was booked outside your hours, or on a day in your holiday list, the invoice for that
        job offers the item you choose here. It is never added on its own: you decide on each invoice. The item you
        choose is marked as your after hours rate, so a membership plan that waives the after hours rate waives it for
        members, on a holiday too. The two can be the same item.
      </p>
      <dl className="mt-4 grid max-w-2xl gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-ink-500">After hours</dt>
          <dd className="font-medium">
            {current.afterHoursItem ? `${current.afterHoursItem.name}, ${price(current.afterHoursItem.price)}` : "None chosen"}
          </dd>
        </div>
        <div>
          <dt className="text-ink-500">On a holiday</dt>
          <dd className="font-medium">
            {current.holidayItem ? `${current.holidayItem.name}, ${price(current.holidayItem.price)}` : "None chosen"}
          </dd>
        </div>
      </dl>
      {writes ? (
        <ActionForm action={saveRates} submit="Save rates" className="mt-4 grid max-w-2xl gap-3 sm:grid-cols-2">
          <Select label="After hours rate" name="afterHoursItemId" options={options}
                  defaultValue={current.afterHoursItem?.id ?? ""} />
          <Select label="Holiday rate" name="holidayItemId" options={options}
                  defaultValue={current.holidayItem?.id ?? ""} />
        </ActionForm>
      ) : (
        <p className="mt-4 text-sm text-ink-500">Changing the rates needs the permission to change the price book.</p>
      )}
    </section>
  );
}
