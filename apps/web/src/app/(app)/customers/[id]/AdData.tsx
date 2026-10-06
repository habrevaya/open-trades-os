import { adConversions, type ServiceContext } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { ActionForm, TextField } from "@/components/ActionForm";
import { formatIn } from "@/lib/dates";
import { setAdData } from "./ad-data-actions";

/**
 * WHETHER THIS CUSTOMER'S DETAILS MAY BE USED TO MEASURE ADVERTISING
 *
 * A different question from whether they may be texted, and asked separately.
 * A connected Google Ads or Meta account is told when a job this customer
 * booked came from one of its ads; what goes with it depends on the company's
 * setting on that connection and on this answer. "No" sends nothing about them
 * to any platform, not even the click. What already went cannot be called
 * back, and this says so rather than leaving it to be discovered.
 */
export async function AdData({ ctx, customerId, zone }: { ctx: ServiceContext; customerId: string; zone: string }) {
  const answer = await adConversions.adChoice(ctx, { customerId });
  const writes = can(ctx.actor, "customer:write");
  return (
    <section className="mt-8 rounded-md border border-steel-200 p-4" aria-label="Advertising">
      <h2 className="font-medium text-ink-900">Their details and advertising</h2>
      <p className="mt-1 text-sm text-ink-700">
        {answer.choice === "granted"
          ? <>Said yes{answer.capturedAt ? ` on ${formatIn(new Date(answer.capturedAt), zone)}` : ""}: their email and phone may be sent, hashed, to connected ad platforms to measure which ads brought work.</>
          : answer.choice === "refused"
            ? <>Said no{answer.capturedAt ? ` on ${formatIn(new Date(answer.capturedAt), zone)}` : ""}: nothing about them is sent to any ad platform. Anything sent before then cannot be called back.</>
            : <>Never asked. The company&rsquo;s setting on each connected ad platform decides what is sent.</>}
        {answer.proofText ? <span className="mt-1 block text-ink-500">&ldquo;{answer.proofText}&rdquo;</span> : null}
      </p>
      {writes && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <ActionForm action={setAdData} submit="They said no" tone="quiet" hidden={{ id: customerId, choice: "refused" }}
                      className="flex flex-wrap items-end gap-3">
            <TextField label="What they said (optional)" name="proofText" className="w-64" />
          </ActionForm>
          <ActionForm action={setAdData} submit="They said yes" tone="quiet" hidden={{ id: customerId, choice: "granted" }} className="" />
        </div>
      )}
    </section>
  );
}
