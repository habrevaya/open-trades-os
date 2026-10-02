import Link from "next/link";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { comms, customers, NotFoundError } from "@opentradesos/api/services";
import { Empty, PageHeader } from "@/components/Table";
import { ThreadList } from "./ThreadList";

export const dynamic = "force-dynamic";

/**
 * THE INBOX
 *
 * Sorted by what happened last, and the only thing distinguished is whether
 * the last thing said came from them. That is the question somebody opening
 * this screen is actually asking, and an inbox that sorts by anything else
 * makes them read every row to find the two that need an answer.
 *
 * `?customer=` narrows it to one customer's threads, which is where the
 * customer page's "all messages" link lands. The customer is read through
 * the customer service first, so an id outside the caller's scope narrows
 * to nothing rather than naming somebody they may not see.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const query = await searchParams;
  const customerId = typeof query["customer"] === "string" ? query["customer"] : null;

  const customer = customerId
    ? await customers.get(ctx, { id: customerId }).catch((error: unknown) => {
        if (error instanceof NotFoundError) return null;
        throw error;
      })
    : null;

  const page = customerId && !customer
    ? { data: [] }
    : await comms.threads(ctx, { limit: 100, ...(customer ? { customerId: customer.id } : {}) });
  const waiting = page.data.filter((t) => t.awaitingReply).length;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Inbox" count={page.data.length} />
      {customerId && (
        <p className="mt-2 text-sm text-ink-700">
          Conversations with{" "}
          {customer
            ? <Link href={`/customers/${customer.id}`} className="font-medium underline underline-offset-4">{customer.name}</Link>
            : "a customer you cannot see"}
          {" · "}
          <Link href="/inbox" className="underline underline-offset-4">Everyone</Link>
        </p>
      )}
      {waiting > 0 && (
        <p className="mt-2 text-sm text-ink-700">
          {waiting === 1 ? "One conversation is" : `${waiting} conversations are`} waiting on a reply.
        </p>
      )}

      {page.data.length === 0 ? (
        <Empty title="Nothing here yet">
          {customerId
            ? "No texts with this customer yet. Start one from their page."
            : "Replies to your texts land here. Connect a number in settings and send one to see it."}
        </Empty>
      ) : (
        <div className="mt-6">
          <ThreadList threads={page.data} timezone={user.organizationTimezone} />
        </div>
      )}
    </div>
  );
}
