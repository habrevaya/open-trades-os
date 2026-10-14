import { getDb } from "@/lib/db";
import { portalChat } from "@opentradesos/api/services";
import { requirePortalSession } from "@/lib/portal-session";
import { PortalBrand } from "../../../../PortalBrand";
import { PortalChat } from "./PortalChat";

export const dynamic = "force-dynamic";

/**
 * A SIGNED IN CUSTOMER CHATTING WITH THE COMPANY
 *
 * The same conversation the office answers in its inbox, under the customer the
 * sign in names: nobody types a name. The page says who answers before anybody
 * writes: the company's automated assistant when the company turned it on for
 * customer accounts, else a person in the office.
 */
export default async function ChatPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await requirePortalSession(slug);
  const chat = await portalChat.read(getDb(), { token: session.token });
  const base = `/portal/${encodeURIComponent(slug)}`;
  const company = session.organizationName;

  return (
    <PortalBrand token={session.token} logoHref={`${base}/logo`}>
      <header className="text-center">
        <p className="text-sm font-medium text-ink-700">{company}</p>
        <h1 className="mt-1 text-2xl font-semibold">Chat with us</h1>
        <a href={`${base}/account`} className="mt-2 inline-block text-sm text-ink-700 underline underline-offset-4">
          Back to your account
        </a>
      </header>
      <PortalChat slug={slug} company={company} initial={JSON.parse(JSON.stringify(chat)) as typeof chat} />
    </PortalBrand>
  );
}
