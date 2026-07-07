import type { Prisma } from "@prisma/client";
import type { WorkspaceRole } from "@prisma/client";
import { CreditCard, Download, FolderOpen, Home, LogOut, Palette, Settings } from "lucide-react";
import Link from "next/link";
import { logoutAction } from "@/app/actions/auth";
import { formatMinutes } from "@/lib/format";
import { hasWorkspacePermission, type WorkspacePermission } from "@/lib/authorization";

type AppShellProps = {
  children: React.ReactNode;
  workspace: {
    name: string;
    minuteBalance: number | Prisma.Decimal;
    planCode: string;
  };
  user: {
    email: string;
    name: string | null;
  };
  role: WorkspaceRole;
};

const navItems = [
  { href: "/app", label: "Home", icon: Home },
  { href: "/app/templates", label: "Templates", icon: Palette, permission: "MANAGE_TEMPLATES" },
  { href: "/app/exports", label: "Exports", icon: Download },
  { href: "/app/settings", label: "Settings", icon: Settings },
  { href: "/app/settings/billing", label: "Billing", icon: CreditCard, permission: "MANAGE_BILLING" },
] satisfies Array<{
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  permission?: WorkspacePermission;
}>;

export function AppShell({ children, workspace, user, role }: AppShellProps) {
  const visibleNavItems = navItems.filter(
    (item) => !item.permission || hasWorkspacePermission(role, item.permission),
  );

  return (
    <div className="min-h-screen bg-[#f6f5f0] text-stone-950">
      <div className="grid min-h-screen lg:grid-cols-[264px_1fr]">
        <aside className="border-b border-stone-200 bg-white/90 px-4 py-4 lg:border-b-0 lg:border-r">
          <div className="flex items-center gap-3 px-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-700 text-white">
              <FolderOpen size={20} aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-semibold tracking-wide">Sermon Clipper</p>
              <p className="text-xs text-stone-500">Phase 1 foundation</p>
            </div>
          </div>

          <nav className="mt-8 grid gap-1" aria-label="Main navigation">
            {visibleNavItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100 hover:text-stone-950"
              >
                <item.icon size={17} aria-hidden="true" />
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="mt-8 rounded-lg border border-stone-200 bg-stone-50 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-stone-500">Workspace</p>
            <p className="mt-2 text-sm font-semibold">{workspace.name}</p>
            <div className="mt-4 rounded-md bg-white p-3">
              <p className="text-xs text-stone-500">Minute balance</p>
              <p className="text-2xl font-semibold text-teal-800">
                {formatMinutes(workspace.minuteBalance)}
              </p>
            </div>
            <p className="mt-3 text-xs text-stone-500">Plan: {workspace.planCode}</p>
          </div>
        </aside>

        <div className="flex min-w-0 flex-col">
          <header className="flex items-center justify-between border-b border-stone-200 bg-white px-5 py-4">
            <div>
              <p className="text-sm font-medium text-stone-600">{user.name ?? user.email}</p>
              <p className="text-xs text-stone-500">{user.email}</p>
            </div>
            <form action={logoutAction}>
              <button
                type="submit"
                className="inline-flex items-center gap-2 rounded-md border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50"
              >
                <LogOut size={16} aria-hidden="true" />
                Sign out
              </button>
            </form>
          </header>
          <main className="flex-1 px-5 py-6 lg:px-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
