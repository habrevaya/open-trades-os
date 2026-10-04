import { leadIntake, payments, type ServiceContext } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ConnectForm } from "./ConnectForm";
import { SignIn } from "./SignIn";
import { FORMS } from "./fields";
// Registers the marketing adapters, so the catalogue's built entries resolve.
import "@opentradesos/api/marketing";

export const GROUPS: { capability: string; title: string; description: string }[] = [
  { capability: "payments", title: "Card payments",
    description: "Take a card on the invoice link and in the field. The webhook is what marks an invoice paid." },
  { capability: "financing", title: "Customer financing",
    description: "Let customers pay over time. The lender decides on each application; the funded loan lands on the invoice with the lender's fee booked as an expense." },
  { capability: "accounting", title: "Accounting",
    description: "Invoices, payments and write-offs into the books your accountant uses. Map your accounts after connecting." },
  { capability: "messaging", title: "Texting",
    description: "Reminders, arrival notices and the shared inbox. Replies route back on the webhook address shown once connected." },
  { capability: "email", title: "Email",
    description: "Invoices, estimates and notices by email." },
  { capability: "telephony", title: "Call tracking",
    description: "Which marketing made the phone ring." },
  { capability: "transcription", title: "Call transcripts",
    description: "Recordings and voicemails written out, card numbers removed, and searchable on the call log." },
  { capability: "ai_model", title: "AI models",
    description: "Your own key, your own bill, the same permissions as the person asking." },
  { capability: "calendar", title: "Calendar",
    description: "A technician's visits in the calendar they already use." },
  { capability: "ads", title: "Advertising",
    description: "Spend pulled from the ad accounts every few hours into your spend, and booked and paid jobs told back to the account whose click won them. Each platform needs its own developer approval before it will answer; see what each one needs below." },
  { capability: "analytics", title: "Website analytics",
    description: "Booked and paid jobs sent to your own analytics against the visit that led to them." },
  { capability: "reviews", title: "Review listings",
    description: "Reviews read into the review work list every hour, and replies written here posted back." },
  { capability: "maps", title: "Maps and addresses",
    description: "Puts customers' addresses on the dispatch map in the background, so the route optimiser has something to measure. A pin placed by hand on a property always wins." },
  { capability: "routing", title: "Drive times by road",
    description: "How long the drive really is, for the route optimiser, the day rebalance and the arrival time on a customer's tracking link. Without one, drive times are straight line estimates and every screen says so." },
];

/**
 * The connect forms for some or all of the capabilities, exactly as Settings,
 * Integrations draws them. The setup wizard's payments, phone and email, and
 * accounting steps draw their own capabilities through this, so connecting
 * Stripe from the wizard is connecting Stripe, not a copy of it.
 */
export async function IntegrationGroups({
  ctx, only,
}: {
  ctx: ServiceContext;
  /** The capabilities to show, in this order. Every group when left out. */
  only?: readonly string[];
}) {
  const [connectors, card] = await Promise.all([
    leadIntake.catalogue(ctx),
    payments.status(ctx),
  ]);
  const writes = can(ctx.actor, "integration:write");
  const configuresAi = can(ctx.actor, "agent:configure");
  const groups = only
    ? only.map((key) => GROUPS.find((g) => g.capability === key)).filter((g): g is (typeof GROUPS)[number] => !!g)
    : GROUPS;

  return (
    <>
      {groups.map((group) => {
        const rows = connectors.filter((c) => c.capability === group.capability);
        if (rows.length === 0) return null;
        return (
          <section key={group.capability} className="mt-8">
            <h2 className="text-base font-semibold">{group.title}</h2>
            <p className="mt-1 max-w-2xl text-sm text-ink-700">{group.description}</p>
            <ul className="mt-3 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
              {rows.map((c) => {
                const form = FORMS[c.key];
                const mayChange = form?.via === "ai" ? configuresAi : writes;
                return (
                  <li key={c.key} className="bg-canvas p-4">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-medium">{c.label}</span>
                      {c.state !== "built"
                        ? <Chip tone="neutral">Named, not built</Chip>
                        : c.connected
                          ? <Chip tone="success">Connected</Chip>
                          : c.connectionStatus
                            ? <Chip tone={c.connectionStatus === "needs_reauth" ? "danger" : "neutral"}>{STATUS_WORDS[c.connectionStatus] ?? c.connectionStatus}</Chip>
                            : null}
                      {c.lastError && <Chip tone="danger">Erroring</Chip>}
                    </div>
                    <p className="mt-1 text-sm text-ink-700">{c.purpose}</p>
                    <p className="mt-2 text-sm text-ink-500">
                      <span className="font-medium text-ink-700">Needs: </span>{c.setup}
                    </p>
                    <p className="mt-1 text-sm text-ink-500">
                      <span className="font-medium text-ink-700">Will not tell you: </span>{c.limitation}
                    </p>

                    {c.connected && c.credentialRef && (
                      <p className="mt-2 text-sm text-ink-700">
                        Secret name: <code className="font-mono text-xs">{c.credentialRef}</code>
                      </p>
                    )}
                    {c.key === "stripe" && c.connected && !card.webhookConfigured && (
                      /*
                        The failure that looks like success: cards are taken
                        and no invoice ever closes.
                      */
                      <p className="mt-2 rounded bg-red-tint px-3 py-2 text-sm text-red-600">
                        No webhook signing secret is set. Cards will be taken and no payment will
                        be recorded until it is.
                      </p>
                    )}
                    {c.webhookPath && (
                      <p className="mt-2 text-sm text-ink-700">
                        Webhook address: your public URL followed by{" "}
                        <code className="break-all font-mono text-xs">{c.webhookPath}</code>
                      </p>
                    )}
                    {c.notice && (
                      <p className="mt-2 rounded bg-red-tint px-3 py-2 text-sm text-red-600" role="alert">
                        {c.notice}
                      </p>
                    )}
                    {c.lastError && <p className="mt-2 text-sm text-red-600">{c.lastError}</p>}

                    {c.state === "built" && form?.noForm && (
                      <p className="mt-2 text-sm text-ink-500">{form.noForm}</p>
                    )}
                    {c.state === "built" && form && !form.noForm && mayChange && (
                      <ConnectForm
                        provider={c.key}
                        label={c.label}
                        form={form}
                        connected={c.connected}
                        saved={c.connectionStatus !== null && c.connectionStatus !== "disconnected"}
                        credentialRef={c.credentialRef}
                      />
                    )}
                    {c.state === "built" && form?.signIn && c.connectionStatus && c.connectionStatus !== "disconnected" && (
                      /*
                        After the settings are saved, never before: the sign in
                        needs the OAuth client's name to send the person to
                        the right consent screen.
                      */
                      <SignIn
                        provider={c.key}
                        platform={form.signIn}
                        status={c.connectionStatus}
                        mayChange={mayChange}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

    </>
  );
}

/** A connection's state in words, rather than the column's value. */
const STATUS_WORDS: Record<string, string> = {
  disconnected: "Off",
  pending: "Waiting for somebody to sign in",
  needs_reauth: "Sign in again",
  error: "Erroring",
};

export const MARKETING_CAPABILITIES = new Set(["lead_source"]);
