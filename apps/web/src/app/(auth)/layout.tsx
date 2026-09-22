import { Logo } from "@/components/Logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas-raised">
      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-[420px]">
          <div className="mb-8 flex items-center gap-2.5">
            <Logo className="h-7 w-7" />
            <span className="text-lg font-semibold tracking-[-0.01em]">OpenTradesOS</span>
          </div>
          <div className="rounded-md border border-steel-200 bg-canvas p-7 shadow-sm">{children}</div>
        </div>
      </div>
      <footer className="px-6 py-6 text-center text-sm text-ink-500">
        Your database, your data. AGPL 3.0.
      </footer>
    </div>
  );
}
