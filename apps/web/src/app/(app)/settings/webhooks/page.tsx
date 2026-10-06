import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { webhooks } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm, TextField } from "@/components/ActionForm";
import { Empty, PageHeader, Table, Td, Th } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { act } from "./actions";

export const dynamic = "force-dynamic";

const STATUSES = [
  { value: "", label: "Everything" },
  { value: "delivered", label: "Delivered" },
  { value: "refused", label: "Refused" },
  { value: "unreachable", label: "No answer" },
] as const;

type Status = "delivered" | "refused" | "unreachable";
const isStatus = (value: string | undefined): value is Status =>
  value === "delivered" || value === "refused" || value === "unreachable";

const TONE = { delivered: "success", refused: "danger", unreachable: "warning" } as const;
const SAID = { delivered: "Delivered", refused: "Refused", unreachable: "No answer" } as const;
const REPLAY = { pending: "Waiting", done: "Sent", failed: "Gave up", cancelled: "Stopped" } as const;

/**
 * WHERE THIS COMPANY'S EVENTS GO, AND WHAT EACH RECEIVER SAID
 *
 * The routes to register an endpoint have existed for a while and there was no
 * screen, and an endpoint only ever said THAT it was failing: a count and a
 * time. This shows each attempt with the answer the receiver gave, the start
 * of what it sent back and how long it took, filtered by how it went, and a
 * button beside each to send it again.
 *
 * A REPLAY IS QUEUED, NOT SENT FROM HERE. The worker sends it in order after
 * the endpoint's live deliveries, signed afresh and carrying the same delivery
 * header as the original, so a receiver that deduplicates on it is never made
 * to process anything twice.
 */
export default async function WebhooksPage({
  searchParams,
}: {
  searchParams: Promise<{ endpoint?: string; status?: string; cursor?: string }>;
}) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const zone = user.organizationTimezone;

  if (!can(user.actor, "integration:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Webhooks" />
        <Empty title="Integrations are not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      </div>
    );
  }

  const params = await searchParams;
  const writes = can(user.actor, "integration:write");
  const endpoints = await webhooks.list(ctx);
  const catalogue = await webhooks.catalogue(ctx);
  const chosen = endpoints.find((e) => e.id === params.endpoint) ?? endpoints[0] ?? null;
  const status = isStatus(params.status) ? params.status : undefined;

  const positions = new Map(await Promise.all(
    endpoints.map(async (e) => [e.id, await webhooks.position(ctx, { id: e.id })] as const),
  ));
  const history = chosen
    ? await webhooks.history(ctx, {
      id: chosen.id,
      limit: 50,
      ...(status ? { status } : {}),
      ...(params.cursor ? { cursor: params.cursor } : {}),
    })
    : null;
  const replays = chosen ? await webhooks.replays(ctx, { id: chosen.id }) : [];

  const linkTo = (endpointId: string, next?: { status?: string | undefined; cursor?: string | undefined }) => {
    const query = new URLSearchParams({ endpoint: endpointId });
    if (next?.status) query.set("status", next.status);
    if (next?.cursor) query.set("cursor", next.cursor);
    return `/settings/webhooks?${query.toString()}`;
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Webhooks" count={endpoints.length} />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Your own systems hear about what happens here without asking: a job completed, an invoice
        paid. Each address gets the events it signed up for, in order, signed so it can tell they
        came from us. Every attempt and what the other end answered is kept for thirty days.
      </p>

      {endpoints.length === 0 ? (
        <Empty title="Nothing is being sent anywhere">
          Add an address below and pick the events it should hear about.
        </Empty>
      ) : (
        <Table label="Endpoints" head={<><Th>Address</Th><Th>Events</Th><Th>State</Th><Th>{""}</Th></>}>
          {endpoints.map((endpoint) => {
            const position = positions.get(endpoint.id);
            return (
              <tr key={endpoint.id} className={chosen?.id === endpoint.id ? "bg-steel-100" : undefined}>
                <Td>
                  <a href={linkTo(endpoint.id)} className="break-all font-mono text-blue-600 underline underline-offset-4">
                    {endpoint.url}
                  </a>
                </Td>
                <Td className="text-ink-700">{endpoint.events.join(", ")}</Td>
                <Td>
                  <Chip tone={endpoint.active ? "success" : "neutral"}>{endpoint.active ? "On" : "Off"}</Chip>
                  {endpoint.failureCount > 0 ? (
                    <p className="mt-1 text-xs text-red-600">
                      Failed {endpoint.failureCount} {endpoint.failureCount === 1 ? "time" : "times"} in a row
                    </p>
                  ) : null}
                  {position && position.pending > 0 ? (
                    <p className="mt-1 text-xs text-ink-500">{position.pending} waiting to go</p>
                  ) : null}
                  {endpoint.previousSecretExpiresAt ? (
                    <p className="mt-1 text-xs text-amber-700">
                      The old secret also signs until {formatIn(endpoint.previousSecretExpiresAt, zone)}
                    </p>
                  ) : null}
                </Td>
                <Td>
                  {writes ? (
                    <div className="flex flex-wrap gap-2">
                      <ActionForm action={act} className="" tone="quiet"
                                  submit={endpoint.active ? "Switch off" : "Switch on"}
                                  hidden={{ op: endpoint.active ? "off" : "on", id: endpoint.id }} />
                      <ActionForm action={act} className="" tone="danger" submit="Remove"
                                  hidden={{ op: "remove", id: endpoint.id }} />
                    </div>
                  ) : null}
                </Td>
              </tr>
            );
          })}
        </Table>
      )}

      {chosen && history ? (
        <section className="mt-10" aria-labelledby="history-heading">
          <h2 id="history-heading" className="text-base font-semibold">
            What was sent to <span className="break-all font-mono text-sm">{chosen.url}</span>
          </h2>
          <nav aria-label="Filter by what happened" className="mt-3 flex flex-wrap gap-2 text-sm">
            {STATUSES.map((option) => {
              const current = (status ?? "") === option.value;
              return (
                <a key={option.value} href={linkTo(chosen.id, { status: option.value || undefined })}
                   aria-current={current ? "page" : undefined}
                   className={current
                     ? "rounded border border-ink-900 bg-ink-900 px-2.5 py-1 font-medium text-white"
                     : "rounded border border-steel-300 px-2.5 py-1 text-ink-700 hover:bg-steel-100"}>
                  {option.label}
                </a>
              );
            })}
          </nav>

          {history.data.length === 0 ? (
            <Empty title={status ? "Nothing like that in the last thirty days" : "Nothing sent yet"}>
              {status
                ? "Try another filter, or everything."
                : "The first event this address signed up for goes on the next pass after it happens."}
            </Empty>
          ) : (
            <Table label="Delivery history"
                   head={<><Th>When</Th><Th>Event</Th><Th>Answer</Th><Th>Took</Th><Th>{""}</Th></>}>
              {history.data.map((delivery) => (
                <tr key={delivery.id}>
                  <Td className="whitespace-nowrap">{formatIn(delivery.requestedAt, zone)}</Td>
                  <Td>
                    <span className="font-medium">{delivery.eventName}</span>
                    <span className="block text-xs text-ink-500">
                      Event {delivery.eventSequence}, attempt {delivery.attempt}
                      {delivery.replayId ? ", sent again on request" : ""}
                    </span>
                  </Td>
                  <Td>
                    <Chip tone={TONE[delivery.status]}>{SAID[delivery.status]}</Chip>
                    <span className="ml-2 text-xs text-ink-700">
                      {delivery.responseStatus !== null ? `HTTP ${delivery.responseStatus}` : delivery.error}
                    </span>
                    {delivery.responseExcerpt ? (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-ink-500">What it said</summary>
                        <pre className="mt-1 max-h-48 max-w-md overflow-auto whitespace-pre-wrap break-all rounded bg-steel-100 p-2 text-xs">
                          {delivery.responseExcerpt}
                        </pre>
                      </details>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap text-ink-700">{delivery.durationMs} ms</Td>
                  <Td>
                    {writes && chosen.active ? (
                      <ActionForm action={act} className="" tone="quiet" submit="Send again"
                                  hidden={{ op: "replay-delivery", id: chosen.id, deliveryId: delivery.id }} />
                    ) : null}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          {history.hasMore && history.nextCursor ? (
            <p className="mt-3 text-sm">
              <a href={linkTo(chosen.id, { status, cursor: history.nextCursor })}
                 className="text-blue-600 underline underline-offset-4">Older attempts</a>
            </p>
          ) : null}

          {writes ? (
            <div className="mt-8">
              <h3 className="text-sm font-medium text-ink-700">Give this endpoint a new signing secret</h3>
              <p className="mt-1 max-w-2xl text-sm text-ink-500">
                For a while after, every delivery is signed with both the new secret and the old one,
                so the receiver keeps working until whoever runs it puts the new one in. During that
                time the signature header carries two signatures separated by a comma, and the receiver
                must accept the delivery when either matches. If the old secret leaked, choose no
                overlap and it stops working at once.
                {chosen.secretRotatedAt ? ` The current secret was made ${formatIn(chosen.secretRotatedAt, zone)}.` : ""}
              </p>
              <ActionForm action={act} submit="Make a new secret" className="mt-3 flex flex-wrap items-end gap-3"
                          hidden={{ op: "rotate", id: chosen.id }}>
                <label className="block text-sm">
                  <span className="font-medium text-ink-700">The old secret keeps signing for</span>
                  <select name="overlapHours" defaultValue="24" aria-label="How long the old secret keeps signing"
                          className="mt-1 block h-9 rounded border border-steel-300 bg-canvas px-2 text-sm">
                    <option value="0">No time at all: it leaked</option>
                    <option value="1">An hour</option>
                    <option value="24">A day</option>
                    <option value="72">Three days</option>
                    <option value="168">A week</option>
                  </select>
                </label>
              </ActionForm>
            </div>
          ) : null}

          {writes && chosen.active ? (
            <div className="mt-8">
              <h3 className="text-sm font-medium text-ink-700">Send everything again from a point</h3>
              <p className="mt-1 max-w-2xl text-sm text-ink-500">
                For a receiver that lost a stretch of events. Every event it signed up for from that
                number on is sent again, in order, up to the newest event there is now. The receiver
                gets the same delivery id as the first time, so it can skip what it already has.
                {(() => {
                  const position = positions.get(chosen.id);
                  return position ? ` It has been sent everything through event ${position.deliveredThrough}.` : "";
                })()}
              </p>
              <ActionForm action={act} submit="Send again from here" className="mt-3 flex flex-wrap items-end gap-3"
                          hidden={{ op: "replay-from", id: chosen.id }}>
                <TextField label="From event number" name="fromSequence" type="number" min={1} required
                           className="block w-44" />
                <TextField label="Up to (optional)" name="throughSequence" type="number" min={1}
                           className="block w-44" />
              </ActionForm>
            </div>
          ) : null}

          {replays.length > 0 ? (
            <Table label="Sent again on request"
                   head={<><Th>Asked</Th><Th>Events</Th><Th>State</Th><Th>Why it stopped</Th><Th>{""}</Th></>}>
              {replays.map((replay) => (
                <tr key={replay.id}>
                  <Td className="whitespace-nowrap">{formatIn(replay.createdAt, zone)}</Td>
                  <Td>
                    {replay.fromSequence === replay.throughSequence
                      ? `Event ${replay.fromSequence}`
                      : `${replay.fromSequence} to ${replay.throughSequence}`}
                  </Td>
                  <Td>
                    <Chip tone={replay.status === "done" ? "success" : replay.status === "failed" ? "danger" : "info"}>
                      {REPLAY[replay.status]}
                    </Chip>
                  </Td>
                  <Td className="text-ink-700">
                    {replay.status === "cancelled"
                      ? `Stopped by hand${replay.position >= replay.fromSequence ? ` after event ${replay.position}` : " before anything went"}.`
                      : replay.lastError ?? ""}
                  </Td>
                  <Td>
                    {/*
                      Only while it is waiting: a replay that finished has nothing
                      left to stop. What already went stays gone, and the line says so.
                    */}
                    {writes && replay.status === "pending" ? (
                      <ActionForm action={act} className="" tone="quiet" submit="Stop it"
                                  hidden={{ op: "cancel-replay", id: chosen.id, replayId: replay.id }} />
                    ) : null}
                  </Td>
                </tr>
              ))}
            </Table>
          ) : null}
        </section>
      ) : null}

      {writes ? (
        <section className="mt-10">
          <h2 className="text-base font-semibold">Send events to a new address</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-500">
            It has to be https. The signing secret is shown once, when you save.
          </p>
          <ActionForm action={act} submit="Add endpoint" hidden={{ op: "register" }}>
            <TextField label="Address" name="url" type="url" required placeholder="https://" />
            <fieldset>
              <legend className="text-sm font-medium text-ink-700">Events</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {catalogue.map((event) => (
                  <label key={event.name} className="flex items-start gap-2 text-sm">
                    <input type="checkbox" name="events" value={event.name} className="mt-1" />
                    <span>
                      <span className="font-mono text-xs">{event.name}</span>
                      {event.summary ? <span className="block text-ink-500">{event.summary}</span> : null}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
