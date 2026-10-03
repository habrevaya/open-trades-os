import { notFound, redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { portalSignIn } from "@opentradesos/api/services";
import { currentPortalSession } from "@/lib/portal-session";
import { SignInForm } from "./SignInForm";

export const dynamic = "force-dynamic";

/**
 * WHERE A CUSTOMER SIGNS IN
 *
 * One page per company, at the company's public key, so it can go on the
 * website, the bottom of an invoice email or a sticker on the furnace. A
 * customer who is already signed in goes straight to their account.
 *
 * Nothing here says whether an address is on file. The page is the same for
 * a customer and for a stranger, and that is the point.
 */
export default async function PortalSignInPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let company: { name: string; slug: string };
  try {
    company = await portalSignIn.companyNamed(getDb(), slug);
  } catch {
    notFound();
  }
  if (await currentPortalSession(company.slug)) redirect(`/portal/${encodeURIComponent(company.slug)}/account`);

  return (
    <div className="space-y-6">
      <header className="text-center">
        <p className="text-sm font-medium text-ink-700">{company.name}</p>
        <h1 className="mt-1 text-2xl font-semibold">Sign in to your account</h1>
        <p className="mt-1 text-sm text-ink-500">
          See your visits, pay a bill, find an old invoice. No password: we send you a code.
        </p>
      </header>
      <SignInForm slug={company.slug} organizationName={company.name} />
    </div>
  );
}
