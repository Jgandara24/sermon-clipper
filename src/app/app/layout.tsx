import { AppShell } from "@/components/app-shell";
import { requireCurrentUser, requirePrimaryWorkspace } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AuthenticatedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await requireCurrentUser();
  const workspace = await requirePrimaryWorkspace(user.id);

  return <AppShell user={user} workspace={workspace}>{children}</AppShell>;
}
