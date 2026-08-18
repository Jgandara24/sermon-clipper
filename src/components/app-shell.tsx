import type { WorkspaceAccessPlan, WorkspaceRole } from "@prisma/client";
import {
  Activity,
  Calendar,
  CreditCard,
  Download,
  FolderOpen,
  Home,
  LogOut,
  PanelLeftClose,
  Palette,
  Rss,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { logoutAction } from "@/app/actions/auth";
import { hasWorkspacePermission, type WorkspacePermission } from "@/lib/authorization";
import { decideWorkspaceAccess, workspaceAccessLabel } from "@/lib/billing/access";

type AppShellProps = {
  children: React.ReactNode;
  workspace: {
    name: string;
    accessPlan: WorkspaceAccessPlan;
    trialStartedAt: Date;
    trialEndsAt: Date;
    paidAt: Date | null;
  };
  user: {
    email: string;
    name: string | null;
  };
  role: WorkspaceRole;
};

const navItems = [
  { href: "/app", label: "Home", icon: Home },
  { href: "/app/calendar", label: "Calendar", icon: Calendar },
  { href: "/app/templates", label: "Templates", icon: Palette, permission: "MANAGE_TEMPLATES" },
  { href: "/app/exports", label: "Exports", icon: Download },
  { href: "/app/settings", label: "Settings", icon: Settings },
  { href: "/app/settings/billing", label: "Billing", icon: CreditCard, permission: "MANAGE_BILLING" },
  { href: "/app/settings/imports", label: "Auto-import", icon: Rss, permission: "MANAGE_OPERATIONS" },
  { href: "/app/settings/operations", label: "Operations", icon: Activity, permission: "MANAGE_OPERATIONS" },
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
  const access = decideWorkspaceAccess(workspace, "read");

  return (
    <div className="min-h-screen bg-[#f7f7f7] text-stone-950">
      <div className="app-shell-grid grid min-h-screen">
        <input
          id="app-sidebar-collapse"
          type="checkbox"
          className="sr-only"
          aria-label="Collapse main navigation"
        />
        <aside className="app-shell-sidebar border-b border-white/10 bg-black px-4 py-4 text-white lg:border-b-0 lg:border-r">
          <div className="flex items-center gap-3 px-2">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-600 text-white">
              <FolderOpen size={20} aria-hidden="true" />
            </div>
            <div className="sidebar-copy min-w-0">
              <p className="text-sm font-semibold tracking-wide">Sermon Clipper</p>
              <p className="text-xs text-stone-500">Create with clarity</p>
            </div>
          </div>

          <label
            htmlFor="app-sidebar-collapse"
            className="mt-4 flex h-9 cursor-pointer items-center gap-3 rounded-md px-3 text-sm font-medium text-stone-400 hover:bg-white/10 hover:text-white"
            title="Toggle navigation"
          >
            <PanelLeftClose size={17} className="shrink-0" aria-hidden="true" />
            <span className="sidebar-label">Collapse</span>
          </label>

          <nav className="mt-4 grid gap-1" aria-label="Main navigation">
            {visibleNavItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-stone-400 hover:bg-white/10 hover:text-white"
              >
                <item.icon size={17} className="shrink-0" aria-hidden="true" />
                <span className="sidebar-label">{item.label}</span>
              </Link>
            ))}
          </nav>

          <div className="sidebar-workspace mt-8 rounded-lg border border-white/10 bg-white/5 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-stone-500">Workspace</p>
            <p className="mt-2 text-sm font-semibold">{workspace.name}</p>
            <p className="mt-3 text-sm font-semibold text-red-400">
              {workspaceAccessLabel(access.state)}
            </p>
          </div>
        </aside>

        <div className="flex min-w-0 flex-col">
          <header className="app-shell-account-bar flex items-center justify-between border-b border-stone-200 bg-white px-5 py-4">
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
          <main className="app-shell-main flex-1 px-5 py-6 lg:px-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
