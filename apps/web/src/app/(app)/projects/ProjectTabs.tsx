import Link from "next/link";

/**
 * The project's own pages, under its name. Money pages are offered only to
 * whoever may read invoices, so a dispatcher is not handed a tab that opens
 * on a refusal.
 */
export function ProjectTabs({ projectId, current, money }: {
  projectId: string;
  current: "overview" | "schedule" | "change-orders" | "applications" | "liens";
  money: boolean;
}) {
  const tabs = [
    { key: "overview", href: `/projects/${projectId}`, label: "Overview" },
    { key: "schedule", href: `/projects/${projectId}/schedule`, label: "Schedule" },
    { key: "change-orders", href: `/projects/${projectId}/change-orders`, label: "Change orders" },
    ...(money ? [
      { key: "applications", href: `/projects/${projectId}/applications`, label: "Applications for payment" },
      { key: "liens", href: `/projects/${projectId}/liens`, label: "Notices and waivers" },
    ] : []),
  ];
  return (
    <nav aria-label="Project" className="mt-4 flex flex-wrap gap-1 border-b border-steel-200 print:hidden">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === current ? "page" : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab.key === current
            ? "border-ink-900 font-medium text-ink-900"
            : "border-transparent text-ink-500 hover:text-ink-900"}`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
