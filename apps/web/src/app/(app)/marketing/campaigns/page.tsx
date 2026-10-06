import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { campaigns, messageTemplates } from "@opentradesos/api/services";
import { can, campaign as cp } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";
import { Campaigns, Audience, Recipients, AbTestResults } from "./CampaignView";
import { RuleBoxes } from "./RuleBoxes";
import { ActionForm } from "./ActionForm";

export const dynamic = "force-dynamic";

const input = "h-8 rounded border border-steel-300 px-2 text-sm";

/**
 * CAMPAIGNS TO THE LIST YOU ALREADY OWN
 *
 * M19's send half had a service and no screen. The audience is a closed set of
 * nine rules rather than a query builder, and that is the feature: the rules are
 * the ones a contractor actually uses, each one is a clause somebody can read,
 * and there is no path to "everybody".
 *
 * THE SENTENCE IS THE SAFETY. Before anything is sent the rules are read back as
 * "412 customers who were last served more than 540 days ago and have never held
 * an agreement", because the difference between two years and two months is one
 * character in a form and a factor of twelve in the bill. The count and the
 * sentence come from the same core function the sender uses, so the screen cannot
 * describe one audience and send to another.
 *
 * Previewing is `campaign:read`; creating and sending is `campaign:write`. A
 * reader who holds only the first sees the campaigns and the results and no
 * buttons, which is the right shape for a screen whose buttons spend money and
 * risk a carrier registration.
 */
export default async function CampaignsPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "campaign:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Campaigns" />
        <Empty title="Not shown to your role">
          Campaigns need the view campaigns permission. Sending needs a second one.
        </Empty>
      </div>
    );
  }

  const params = await searchParams;
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  /** A campaign whose recipients somebody asked to see, by id in the query string. */
  const opened = one("campaign");

  const list = await campaigns.list(ctx, { limit: 100 });
  const writes = can(user.actor, "campaign:write");
  /** The company's message templates, for "start from a template". Settings permission, so best effort. */
  const templates = writes && can(user.actor, "settings:read")
    ? (await messageTemplates.list(ctx)).filter((t) => t.active)
    : [];

  /**
   * The preview of a saved campaign, only when asked for. It runs the audience
   * query, so doing it for every row would be a hundred queries on a list screen
   * and most of them for campaigns that already went.
   */
  const previewed = one("preview");
  const preview = previewed
    ? await campaigns.preview(ctx, { id: previewed }).catch(() => null)
    : null;

  const recipients = opened
    ? (await campaigns.recipients(ctx, { id: opened, limit: 200 })).data
    : null;

  /** The two versions of a test, only when asked for: it reads clicks, replies and jobs. */
  const compared = one("results");
  const comparison = compared
    ? await campaigns.results(ctx, { id: compared }).catch(() => null)
    : null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Campaigns" count={list.data.length} />

      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        To the list you already own, by text or email. Send a batch now, or give it a time and it
        goes then. A carrier's daily cap leaves the rest for the next day, and the rest goes out on
        its own outside quiet hours.
      </p>

      <Campaigns
        campaigns={list.data}
        controls={(campaign) => (
          <div className="flex flex-wrap gap-2">
            <a href={`/marketing/campaigns?preview=${campaign.id}`}
               className="inline-flex h-8 items-center rounded border border-steel-300 px-2.5 text-sm hover:bg-steel-100">
              Who it reaches
            </a>
            {campaign.abTest && campaign.result.selected > 0 && (
              <a href={`/marketing/campaigns?results=${campaign.id}`}
                 className="inline-flex h-8 items-center rounded border border-steel-300 px-2.5 text-sm hover:bg-steel-100">
                Compare the versions
              </a>
            )}
            {campaign.result.selected > 0 && (
              <a href={`/marketing/campaigns?campaign=${campaign.id}`}
                 className="inline-flex h-8 items-center rounded border border-steel-300 px-2.5 text-sm hover:bg-steel-100">
                Who it went to
              </a>
            )}
            {writes && (campaign.state === "draft" || campaign.state === "scheduled" || campaign.state === "sending") && (
              <>
                {/*
                  No confirmation dialogue, deliberately. The confirmation is the
                  audience sentence above it, which is specific, and a modal
                  saying "are you sure" is the thing people learn to click
                  through. The send is also safe to repeat: recipients already
                  written are not re-selected.
                */}
                <ActionForm op="send" label="Send a batch" quiet hidden={{ id: campaign.id }} />
                {campaign.state !== "sending" && (
                  <ActionForm op="schedule" label={campaign.scheduledFor ? "Move the time" : "Send later"} quiet
                              hidden={{ id: campaign.id }}>
                    <input name="scheduledFor" type="datetime-local" required className={input}
                           aria-label="When it goes" />
                  </ActionForm>
                )}
                <ActionForm op="cancel" label="Cancel" quiet hidden={{ id: campaign.id }}>
                  <input name="reason" placeholder="Why" className={`${input} w-32`}
                         aria-label="Why it was cancelled" />
                </ActionForm>
              </>
            )}
            {writes && campaign.state === "draft" && campaign.result.selected === 0 && (
              <ActionForm op="delete" label="Delete" quiet hidden={{ id: campaign.id }} />
            )}
          </div>
        )}
      />

      {preview ? (
        <section className="mt-8">
          <h2 className="text-base font-semibold">Who it reaches</h2>
          <Audience preview={preview} />
        </section>
      ) : previewed ? (
        <Empty title="That audience could not be counted">
          The campaign may have been deleted, or its rules may no longer be a valid set.
        </Empty>
      ) : null}

      {comparison?.abTest ? (
        <section className="mt-8">
          <h2 className="text-base font-semibold">The two versions: {comparison.campaign.name}</h2>
          <AbTestResults results={comparison.abTest} />
        </section>
      ) : compared ? (
        <Empty title="That campaign is not a test">
          It has no second version, or it could not be found.
        </Empty>
      ) : null}

      {recipients ? (
        <section className="mt-8">
          <h2 className="text-base font-semibold">Who it went to</h2>
          <p className="mt-1 text-sm text-ink-500">
            Including the ones it would not send to, with the reason. That half is the useful half:
            four hundred customers who have never been asked for consent is a fact about your
            records, not a failure of the send.
          </p>
          <Recipients recipients={recipients} showVersion={list.data.some((c) => c.id === opened && c.abTest)} />
        </section>
      ) : null}

      {writes && (
        <section className="mt-10">
          <h2 className="text-base font-semibold">New campaign</h2>
          <ActionForm op="create" label="Save as a draft" className="mt-3 space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-ink-700">Name</span>
                <input name="name" required placeholder="Spring tune up" className={input} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-ink-700">Channel</span>
                <select name="channel" className={input}>
                  <option value="sms">Text</option>
                  <option value="email">Email</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-ink-700">Tag</span>
                {/*
                  Optional, and derived from the name when it is left blank. It is
                  what attributes a booked job six weeks later, which is why two
                  live campaigns cannot share one.
                */}
                <input name="utmCampaign" placeholder="from the name" className={input} />
              </label>
            </div>

            <RuleBoxes />

            <div className="space-y-2">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-ink-700">Subject, for an email</span>
                <input name="subject" className={`${input} w-full max-w-xl`} />
              </label>
              {templates.length > 0 && (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-ink-700">Start from a message template</span>
                  <select name="templateCode" className={`${input} w-full max-w-xl`}>
                    <option value="">No, use the message below</option>
                    {templates.map((t) => (
                      <option key={t.code} value={t.code}>{t.name} ({t.channel === "sms" ? "text" : "email"})</option>
                    ))}
                  </select>
                </label>
              )}
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-ink-700">Message</span>
                {/*
                  No character counter here. The limit is the carrier's and it is
                  checked in core, which refuses with the real number rather than
                  a count this screen would have to keep in step with it.
                */}
                <textarea name="body" rows={4}
                          className="w-full max-w-xl rounded border border-steel-300 p-2 text-sm"
                          placeholder="Comfort Co here: $89 tune ups this month. Reply STOP to opt out." />
              </label>
              <p className="max-w-xl text-xs text-ink-500">
                A text needs an opt out in it and an email gets a one-click unsubscribe this product
                serves itself, which stops the promotions and leaves the invoices alone.
              </p>
              <p className="max-w-xl text-xs text-ink-500">
                To call people by name, put any of these in the message and each person gets their own:{" "}
                {cp.MERGE_FIELDS.map((f, i) => (
                  <span key={f.key}>
                    {i > 0 ? ", " : ""}<code className="font-mono">{`{{ ${f.key} }}`}</code> ({f.label.toLowerCase()})
                  </span>
                ))}. Anything else is refused, because it would arrive as a gap in the sentence.
              </p>
              <fieldset className="max-w-xl rounded border border-steel-200 p-3">
                <legend className="px-1 text-sm text-ink-700">Test a second way of saying it (optional)</legend>
                <p className="text-xs text-ink-500">
                  Write a second message and half your list, picked at random, gets it instead. Afterwards you
                  see the counts side by side. A winner is named only when the difference is more than luck
                  would explain. To count clicks for each version, end your link with{" "}
                  <code className="font-mono">?{"{{ campaign.utm }}"}</code>.
                </p>
                <label className="mt-2 flex flex-col gap-1 text-sm">
                  <span className="text-ink-700">Version B words</span>
                  <textarea name="variantBBody" rows={3}
                            className="w-full rounded border border-steel-300 p-2 text-sm" />
                </label>
                <label className="mt-2 flex flex-col gap-1 text-sm">
                  <span className="text-ink-700">Version B headline, for an email (blank keeps the first one)</span>
                  <input name="variantBSubject" className={`${input} w-full`} />
                </label>
              </fieldset>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-ink-700">Send it at, if not now</span>
                <input name="scheduledFor" type="datetime-local" className={`${input} w-56`} />
              </label>
            </div>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
