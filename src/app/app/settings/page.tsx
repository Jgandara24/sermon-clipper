import { inviteWorkspaceMemberAction } from "@/app/actions/members";
import { requireCurrentUser, requirePrimaryWorkspaceMembership } from "@/lib/auth";
import { hasWorkspacePermission } from "@/lib/authorization";
import { formatDate, titleCaseStatus } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

function inviteMessage(status: string | undefined) {
  switch (status) {
    case "sent":
      return "Invitation created. If email delivery is configured, the invitee will receive a join link.";
    case "invalid":
      return "Enter a valid invite email and role.";
    case "already-member":
      return "That user is already an active workspace member.";
    default:
      return null;
  }
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string }>;
}) {
  const user = await requireCurrentUser();
  const membership = await requirePrimaryWorkspaceMembership(user.id);
  const workspace = membership.workspace;
  const params = await searchParams;
  const canManageMembers = hasWorkspacePermission(membership.role, "MANAGE_MEMBERS");
  const settings = workspace.settings as {
    churchProfile?: { timezone?: string; serviceDay?: string };
  };
  const [members, invitations] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { workspaceId: workspace.id },
      include: { user: true },
      orderBy: { createdAt: "asc" },
    }),
    canManageMembers
      ? prisma.workspaceInvitation.findMany({
          where: { workspaceId: workspace.id },
          orderBy: { createdAt: "desc" },
          take: 10,
        })
      : Promise.resolve([]),
  ]);
  const message = inviteMessage(params.invite);

  return (
    <section className="grid max-w-4xl gap-6">
      <div className="rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-medium text-teal-800">Settings</p>
        <h1 className="mt-1 text-2xl font-semibold">Workspace profile</h1>
        <dl className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="rounded-md border border-stone-200 p-4">
            <dt className="text-sm text-stone-500">Workspace name</dt>
            <dd className="mt-1 font-semibold">{workspace.name}</dd>
          </div>
          <div className="rounded-md border border-stone-200 p-4">
            <dt className="text-sm text-stone-500">Plan</dt>
            <dd className="mt-1 font-semibold">{workspace.planCode}</dd>
          </div>
          <div className="rounded-md border border-stone-200 p-4">
            <dt className="text-sm text-stone-500">Timezone</dt>
            <dd className="mt-1 font-semibold">{settings.churchProfile?.timezone ?? "Not set"}</dd>
          </div>
          <div className="rounded-md border border-stone-200 p-4">
            <dt className="text-sm text-stone-500">Primary service day</dt>
            <dd className="mt-1 font-semibold">{settings.churchProfile?.serviceDay ?? "Not set"}</dd>
          </div>
        </dl>
      </div>

      <div className="rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-medium text-teal-800">Members</p>
        <h2 className="mt-1 text-xl font-semibold">Workspace access</h2>
        <div className="mt-5 overflow-hidden rounded-md border border-stone-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id} className="border-t border-stone-100">
                  <td className="px-4 py-3">{member.user.email}</td>
                  <td className="px-4 py-3">{titleCaseStatus(member.role)}</td>
                  <td className="px-4 py-3">{titleCaseStatus(member.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canManageMembers ? (
          <div className="mt-6 grid gap-5 rounded-md border border-stone-200 p-4">
            <div>
              <h3 className="font-semibold">Invite a teammate</h3>
              <p className="mt-1 text-sm text-stone-500">
                Invite editors, approvers, viewers, or admins by email. Invite links expire after 14 days.
              </p>
            </div>
            {message ? (
              <div className="rounded-md border border-teal-100 bg-teal-50 p-3 text-sm text-teal-900">
                {message}
              </div>
            ) : null}
            <form action={inviteWorkspaceMemberAction} className="grid gap-3 sm:grid-cols-[1fr_180px_auto]">
              <input
                type="email"
                name="email"
                placeholder="teammate@example.com"
                required
                className="rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
              />
              <select
                name="role"
                defaultValue="EDITOR"
                className="rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
              >
                <option value="ADMIN">Admin</option>
                <option value="EDITOR">Editor</option>
                <option value="APPROVER">Approver</option>
                <option value="VIEWER">Viewer</option>
              </select>
              <button
                type="submit"
                className="rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800"
              >
                Send invite
              </button>
            </form>

            {invitations.length > 0 ? (
              <div className="overflow-hidden rounded-md border border-stone-200">
                <table className="w-full text-left text-sm">
                  <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
                    <tr>
                      <th className="px-4 py-3">Pending invite</th>
                      <th className="px-4 py-3">Role</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Expires</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invitations.map((invite) => (
                      <tr key={invite.id} className="border-t border-stone-100">
                        <td className="px-4 py-3">{invite.email}</td>
                        <td className="px-4 py-3">{titleCaseStatus(invite.role)}</td>
                        <td className="px-4 py-3">{titleCaseStatus(invite.status)}</td>
                        <td className="px-4 py-3">{formatDate(invite.expiresAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
