import { ActionForm, TextArea, TextField } from "@/components/ActionForm";
import { editService } from "./actions";

export interface OfferedService {
  id: string;
  publicName: string;
  publicDescription: string | null;
  displayPrice: string | null;
  depositAmount: string | null;
  depositPercent: string | null;
  minNoticeHours: number;
  maxAdvanceDays: number;
  maxPerWindow: number;
  isActive: boolean;
}

/** A stored figure as it is typed: "189.0000" reads "189.00", a rate of 0.1 reads "10". */
const typed = (v: string | null) => (v === null ? "" : Number(v).toFixed(2));
const percent = (v: string | null) => (v === null ? "" : String(Number((Number(v) * 100).toFixed(4))));

/**
 * CHANGING ONE SERVICE THE PUBLIC MAY BOOK
 *
 * Every term the create form takes, the deposit terms it does not, and the
 * switch that takes it off the booking page without losing its terms. Each
 * deposit choice says what it does, because the booking page itself takes
 * no money: the figure is what a website booking through the API is told is
 * due, what the office asks for once it confirms the booking, and, when the
 * company shows deposits on the booking page, what the customer reads there.
 */
export function EditService({ service, showDeposits = false }: { service: OfferedService; showDeposits?: boolean }) {
  const deposit = service.depositAmount ? "amount" : service.depositPercent ? "percent" : "none";
  return (
    <details data-testid="edit-service" className="rounded-md border border-steel-200 p-3">
      <summary className="cursor-pointer text-sm font-medium">Edit {service.publicName}</summary>
      <ActionForm action={editService} submit="Save changes" hidden={{ id: service.id }} className="mt-3 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="What customers see it called" name="publicName" required maxLength={200}
                     defaultValue={service.publicName} />
          <TextField label="Price shown" name="displayPrice" inputMode="decimal" placeholder="Leave blank to quote on site"
                     defaultValue={typed(service.displayPrice)} />
        </div>
        <TextArea label="Description" name="publicDescription" rows={2} maxLength={2000}
                  defaultValue={service.publicDescription ?? ""} />
        <div className="grid grid-cols-3 gap-2">
          <TextField label="Notice (hours)" name="minNoticeHours" type="number" min={0} max={720} required
                     defaultValue={service.minNoticeHours} />
          <TextField label="Book out (days)" name="maxAdvanceDays" type="number" min={1} max={365} required
                     defaultValue={service.maxAdvanceDays} />
          <TextField label="Per window" name="maxPerWindow" type="number" min={1} max={100} required
                     defaultValue={service.maxPerWindow} />
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink-700">Deposit</legend>
          <p className="text-xs text-ink-500" data-testid="deposit-note">
            The booking page does not take money.{" "}
            {showDeposits
              ? "It shows this deposit to the customer before they book, because Show deposits on the booking page is on. "
              : "It does not show this deposit either. Turn on Show deposits on the booking page, below, to show it. "}
            A deposit here is also the figure a website that books through the API is told is due, and what you ask
            the customer for after you confirm the booking. Nothing is charged on its own.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="deposit" value="none" defaultChecked={deposit === "none"} /> No deposit
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="deposit" value="amount" defaultChecked={deposit === "amount"} /> A set amount
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="deposit" value="percent" defaultChecked={deposit === "percent"} />
            A percent of the price shown (nothing is due when the price is blank)
          </label>
          <TextField label="Deposit amount or percent" name="depositValue" inputMode="decimal"
                     placeholder="50.00 or 10"
                     defaultValue={deposit === "amount" ? typed(service.depositAmount) : deposit === "percent" ? percent(service.depositPercent) : ""} />
        </fieldset>

        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="isActive" defaultChecked={service.isActive} className="mt-1" />
          <span>
            On the booking page
            <span className="block text-xs text-ink-500">
              Untick to take it off. Its terms are kept, and bookings already made are not touched.
            </span>
          </span>
        </label>
      </ActionForm>
    </details>
  );
}
