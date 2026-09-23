import { requireSetupUser } from "@/lib/auth";
import { assertCan } from "@opentradesos/core";
import { NewCustomerForm } from "./Form";

export const dynamic = "force-dynamic";

/**
 * The permission is checked HERE as well as in the service.
 *
 * Not because the service check is insufficient: it is the one that matters,
 * and it would refuse the write anyway. This is so somebody who reaches the
 * URL without the permission gets a refusal rather than a form that looks
 * like it works and fails on submit after they have typed an address.
 */
export default async function NewCustomerPage() {
  const user = await requireSetupUser();
  assertCan(user.actor, "customer:write");

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 lg:px-6">
      <h1 className="text-xl font-semibold">Add a customer</h1>
      <p className="mt-2 text-sm text-ink-700">
        The address is optional here and needed before you can book work, so
        most people fill it in now.
      </p>
      <NewCustomerForm />
    </div>
  );
}
