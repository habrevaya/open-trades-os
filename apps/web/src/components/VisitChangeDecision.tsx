import { ActionForm, Select, TextField } from "@/components/ActionForm";
import type { FormState } from "@/lib/actions";

type Action = (previous: FormState, form: FormData) => Promise<FormState>;

export interface VisitChangeView {
  id: string;
  kind: "reschedule" | "cancel";
  reason: string | null;
  customerName: string;
  requestedStart: string | null;
  requestedEnd: string | null;
  previousStart: string | null;
  previousEnd: string | null;
  createdAt: string;
  /** Who is on the visit now, by name, so the screen can say who comes off it. */
  assigned?: string[];
}

const when = (start: string | null, end: string | null, timezone: string) => {
  if (!start) return "no time";
  const s = new Date(start);
  const day = s.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: timezone });
  const at = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: timezone });
  return end ? `${day}, ${at(s)} to ${at(new Date(end))}` : `${day} ${at(s)}`;
};

/**
 * A CUSTOMER'S REQUEST, AND THE TWO ANSWERS.
 *
 * Shown on the job and in the office queue, the same component in both, so
 * the two places cannot offer different decisions about one request. What
 * approving will do is said before the button, including the part a
 * dispatcher most needs to know: a moved visit comes off the technician's day
 * and goes back on the board to be assigned.
 *
 * The decline box is sent to the customer as written, so it asks for words
 * they can act on.
 */
/** A window the office could offer instead, as online booking offers it. */
export interface OfferableTime {
  date: string;
  arrivalWindowId: string;
  label: string;
  startsAt: string;
  endsAt: string;
}

const clock = (value: string) => {
  const [h = "0", m = "0"] = value.split(":");
  const hour = Number(h);
  return `${hour % 12 === 0 ? 12 : hour % 12}:${m.padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
};
const offerLabel = (t: OfferableTime) =>
  `${new Date(`${t.date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}, ${clock(t.startsAt)} to ${clock(t.endsAt)}`;

export function VisitChangeDecision({
  request, timezone, approve, decline, canDecide, propose, times = [],
}: {
  request: VisitChangeView;
  timezone: string;
  approve: Action;
  decline: Action;
  canDecide: boolean;
  /** Offering a different time, for a request to move. Absent where it is not offered. */
  propose?: Action;
  /** The times that could be offered, from `visitChanges.proposalTimes`. */
  times?: OfferableTime[];
}) {
  const assigned = request.assigned ?? [];
  return (
    <section
      aria-label={`${request.customerName} asks to ${request.kind === "cancel" ? "cancel" : "move"} a visit`}
      className="rounded-md border border-amber-700 bg-amber-tint p-4"
    >
      <p className="text-sm font-medium text-ink-900">
        {request.kind === "cancel"
          ? `${request.customerName} asks to cancel the visit on ${when(request.previousStart, request.previousEnd, timezone)}.`
          : `${request.customerName} asks to move the visit on ${when(request.previousStart, request.previousEnd, timezone)} to ${when(request.requestedStart, request.requestedEnd, timezone)}.`}
      </p>
      {request.reason ? <p className="mt-1 text-sm text-ink-700">In their words: {request.reason}</p> : null}
      {canDecide ? (
        <>
          <p className="mt-2 text-xs text-ink-700">
            {request.kind === "cancel"
              ? "Agreeing cancels the visit and tells them."
              : assigned.length > 0
                ? `Agreeing moves it, takes ${assigned.join(" and ")} off it, and puts it back on the board for the new day. They are told.`
                : "Agreeing moves it to that time and puts it on the board to be assigned. They are told."}
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-4">
            <ActionForm
              action={approve}
              submit={request.kind === "cancel" ? "Agree and cancel it" : "Agree and move it"}
              hidden={{ id: request.id }}
              className="flex flex-wrap items-end gap-3"
            />
            <ActionForm
              action={decline}
              submit="Say no"
              tone="quiet"
              hidden={{ id: request.id }}
              className="flex flex-wrap items-end gap-3"
            >
              <TextField
                label="What to tell them"
                name="response"
                placeholder="We are full that week. Could Monday work?"
                maxLength={1000}
                className="block w-72"
              />
            </ActionForm>
          </div>
          {propose && request.kind === "reschedule" && (
            /*
              The third answer: not that time, this one. Nothing moves until
              the customer says yes from their link, and the screen says so.
            */
            times.length === 0 ? (
              <p className="mt-3 text-xs text-ink-700">No other times are open online to offer instead.</p>
            ) : (
              <ActionForm
                action={propose}
                submit="Offer this time instead"
                tone="quiet"
                hidden={{ id: request.id }}
                className="mt-3 flex flex-wrap items-end gap-3"
              >
                <Select
                  label="Another time"
                  name="time"
                  options={times.map((t) => ({ value: `${t.date}|${t.arrivalWindowId}`, label: offerLabel(t) }))}
                />
                <TextField
                  label="What to tell them"
                  name="response"
                  placeholder="Thursday is full, but Friday morning is free."
                  maxLength={1000}
                  className="block w-72"
                />
                <p className="basis-full text-xs text-ink-700">
                  They are sent the time with a link to say yes or no. The visit stays where it is until they say yes.
                </p>
              </ActionForm>
            )
          )}
        </>
      ) : null}
    </section>
  );
}
