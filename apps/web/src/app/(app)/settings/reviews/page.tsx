import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { reviews } from "@opentradesos/api/services";
import { can, reviews as rv } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";
import { ActionForm, Select, TextArea, TextField } from "@/components/ActionForm";
import { resetReminderWords, saveReminder, saveReviewPolicy } from "./actions";
import { BAND_ROWS, DAYS, hourLabel } from "./fields";

export const dynamic = "force-dynamic";

/**
 * SETTINGS → REVIEW POLICY
 *
 * How the company asks for reviews and how soon it answers them, which was
 * `PUT /v1/reviews/policy` and nothing else: until it is set, nobody is
 * asked and the reply queue says to set it. Every number is a decision about
 * how the company talks to its customers, so the form starts from the numbers
 * the API would store for a field left out and says that is what they are.
 *
 * And the one reminder's words, which went out in the words the product
 * ships: changed here through `PUT /v1/reviews/reminders`, checked by core's
 * `checkReviewWording` (the ask's placeholders, the link, nothing offered and
 * no stars asked for), and put back with one button.
 *
 * Read with `settings:read`; saved with `settings:write`, as the routes are.
 * The reminder's state is read with `review:respond`, its own route's
 * permission.
 */
export default async function ReviewPolicyPage() {
  const user = await requireSetupUser();
  if (!can(user.actor, "settings:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Review policy" />
        <Empty title="Not shown to your role">The review policy needs the View settings permission.</Empty>
      </div>
    );
  }
  const ctx = { actor: user.actor, db: getDb() };
  const policy = await reviews.currentPolicy(ctx);
  const writes = can(user.actor, "settings:write");
  const start = reviews.POLICY_STARTING_POINT;
  const value = {
    timeZone: policy?.timeZone ?? user.organizationTimezone,
    delayMinutes: policy?.delayMinutes ?? start.delayMinutes,
    customerCooldownDays: policy?.customerCooldownDays ?? start.customerCooldownDays,
    requirePaid: policy?.requirePaid ?? start.requirePaid,
    maxJobAgeDays: policy?.maxJobAgeDays ?? start.maxJobAgeDays,
    earliestHour: policy?.earliestHour ?? start.earliestHour,
    latestHour: policy?.latestHour ?? start.latestHour,
    recoverAtOrBelow: policy?.recoverAtOrBelow ?? start.recoverAtOrBelow,
    sameDayAtOrBelow: policy?.sameDayAtOrBelow ?? start.sameDayAtOrBelow,
    businessDays: policy?.businessDays ?? [...start.businessDays],
    openHour: policy?.openHour ?? start.openHour,
    closeHour: policy?.closeHour ?? start.closeHour,
    halfLifeDays: policy?.halfLifeDays ?? start.halfLifeDays,
    bands: policy && policy.bands.length > 0 ? policy.bands : rv.DEFAULT_RESPONSE_BANDS,
  };
  const hours = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: hourLabel(h) }));
  const ratings = [1, 2, 3, 4, 5].map((r) => ({ value: String(r), label: `${r} star${r === 1 ? "" : "s"}` }));
  const reminder = policy && can(user.actor, "review:respond") ? await reviews.reminders(ctx) : null;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Review policy" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        {policy
          ? "How you ask customers for a review, and how soon you answer the reviews they leave."
          : "Not set yet, so nobody is asked for a review. The numbers below are where most companies start. Change what does not fit, then save to start asking."}
      </p>

      {writes ? null : (
        <p className="mt-3 text-sm text-ink-700">Changing it needs the Change settings permission.</p>
      )}

      <ActionForm action={saveReviewPolicy} submit={policy ? "Save the review policy" : "Set the review policy"}
                  className="mt-6 space-y-8">
        <fieldset aria-label="Asking for a review" className="space-y-3" disabled={!writes}>
          <legend className="text-base font-semibold">Asking for a review</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="Time zone the hours are in" name="timeZone" defaultValue={value.timeZone} required />
            <TextField label="Wait after the visit before asking (minutes)" name="delayMinutes" type="number"
                       min={0} max={10080} defaultValue={value.delayMinutes} />
            <TextField label="Ask the same customer at most once every (days)" name="customerCooldownDays"
                       type="number" min={0} max={3650} defaultValue={value.customerCooldownDays} />
            <TextField label="Do not ask about a job older than (days)" name="maxJobAgeDays" type="number"
                       min={1} max={365} defaultValue={value.maxJobAgeDays} />
            <Select label="Not before" name="earliestHour" options={hours} defaultValue={String(value.earliestHour)} />
            <Select label="Not after" name="latestHour" options={hours} defaultValue={String(value.latestHour)} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="requirePaid" defaultChecked={value.requirePaid} className="h-4 w-4" />
            Only ask once the job is paid
          </label>
          <p className="text-xs text-ink-500">
            Nobody is asked who opted out, has a complaint open, or is waiting on a call back, whatever these say.
          </p>
        </fieldset>

        <fieldset aria-label="Answering reviews" className="space-y-3" disabled={!writes}>
          <legend className="text-base font-semibold">Answering reviews</legend>
          <div>
            <p className="text-sm font-medium text-ink-700">Days the office is open</p>
            <div className="mt-1 flex flex-wrap gap-3">
              {DAYS.map((day, index) => (
                <label key={day} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" name={`day:${index}`} defaultChecked={value.businessDays.includes(index)}
                         className="h-4 w-4" />
                  {day}
                </label>
              ))}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label="Office opens" name="openHour" options={hours} defaultValue={String(value.openHour)} />
            <Select label="Office closes" name="closeHour" options={hours} defaultValue={String(value.closeHour)} />
            <Select label="Ring the customer back at or below" name="recoverAtOrBelow" options={ratings}
                    defaultValue={String(value.recoverAtOrBelow)} />
            <Select label="The same day at or below" name="sameDayAtOrBelow" options={ratings}
                    defaultValue={String(value.sameDayAtOrBelow)} />
            <TextField label="An old review counts half after (days)" name="halfLifeDays" type="number"
                       min={1} max={3650} defaultValue={value.halfLifeDays} />
          </div>

          <div>
            <p className="text-sm font-medium text-ink-700">How soon each review is answered</p>
            <p className="mt-0.5 text-xs text-ink-500">
              From the lowest rating up. Each row covers every rating above the one before, up to its own, and the last
              has to reach 5 stars. Open hours count only the days and hours the office is open. Leave a row empty to
              drop it.
            </p>
            <div className="mt-2 space-y-3">
              {Array.from({ length: BAND_ROWS }, (_, i) => {
                const band = value.bands[i];
                return (
                  <div key={i} className="grid gap-2 rounded border border-steel-200 p-3 sm:grid-cols-[9rem_9rem_1fr]">
                    <Select label={`Row ${i + 1}: up to`} name={`band:${i}:upTo`}
                            options={[{ value: "", label: "Not used" }, ...ratings]}
                            defaultValue={band ? String(band.upToRating) : ""} />
                    <TextField label="Answer within (hours)" name={`band:${i}:hours`} type="number" min={1} max={8760}
                               defaultValue={band?.withinHours ?? ""} />
                    <label className="flex items-end gap-2 pb-2 text-sm">
                      <input type="checkbox" name={`band:${i}:open`} defaultChecked={band?.businessHoursOnly ?? true}
                             className="h-4 w-4" />
                      Count open hours only
                    </label>
                    <div className="sm:col-span-3">
                      <TextField label="Why this many hours" name={`band:${i}:reason`} maxLength={1000}
                                 defaultValue={band?.reason ?? ""} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </fieldset>
      </ActionForm>

      <section aria-label="The reminder" className="mt-12">
        <h2 className="text-base font-semibold">The reminder</h2>
        {!policy ? (
          <p className="mt-1 text-sm text-ink-700">Set the policy first. Then one reminder can be turned on here.</p>
        ) : !reminder ? (
          <p className="mt-1 text-sm text-ink-700">The reminder needs the Answer reviews permission to read.</p>
        ) : (
          <>
            <p className="mt-1 max-w-2xl text-sm text-ink-700">
              {reminder.afterDays === null
                ? "Off. Each customer is asked once."
                : `On. A customer who has not answered ${reminder.afterDays} days after the ask gets one reminder, the way you ask.`}
              {" "}{reminder.wording.custom ? "It goes in your own words." : "It goes in the words we wrote."}
              {" "}You can use {"{{ customer.name }}"} (their first name), {"{{ organization.name }}"} and
              {" "}{"{{ review.url }}"}, the link, which the text and the email both need. Nothing may offer something for a
              review or ask for a number of stars.
            </p>
            {writes ? (
              <>
                <ActionForm action={saveReminder} submit="Save the reminder" className="mt-3 space-y-3">
                  <TextField label="Remind after this many days (3 to 60). Empty is off." name="afterDays" type="number"
                             min={3} max={60} defaultValue={reminder.afterDays ?? ""} className="block w-80" />
                  <TextArea label="The text" name="sms" rows={3} defaultValue={reminder.wording.sms} />
                  <TextField label="The email's subject" name="emailSubject" defaultValue={reminder.wording.emailSubject} />
                  <TextArea label="The email" name="emailBody" rows={8} defaultValue={reminder.wording.emailBody} />
                </ActionForm>
                {reminder.wording.custom ? (
                  <ActionForm action={resetReminderWords} submit="Put back the words we wrote" tone="quiet"
                              className="mt-3 flex items-center gap-2" />
                ) : null}
              </>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
