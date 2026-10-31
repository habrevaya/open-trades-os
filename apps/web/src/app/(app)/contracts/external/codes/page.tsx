import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** The client chosen on `Work from other systems`, as the address of their list. */
export default async function ChooseClientCodes(
  { searchParams }: { searchParams: Promise<{ customer?: string }> },
) {
  const { customer } = await searchParams;
  redirect(customer ? `/contracts/external/codes/${encodeURIComponent(customer)}` : "/contracts/external");
}
