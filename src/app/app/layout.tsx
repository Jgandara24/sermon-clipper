import { AppShell } from "@/components/app-shell";
import { requireCurrentUser, requirePrimaryWorkspaceMembership } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AuthenticatedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await requireCurrentUser();
  const membership = await requirePrimaryWorkspaceMembership(user.id);

  return (
    <AppShell user={user} workspace={membership.workspace} role={membership.role}>
      {children}
    </AppShell>
  );
}
