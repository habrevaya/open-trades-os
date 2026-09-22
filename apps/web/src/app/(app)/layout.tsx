import { requireSetupUser } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSetupUser();
  return <AppShell user={user}>{children}</AppShell>;
}
