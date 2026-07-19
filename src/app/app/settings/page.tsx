import { updateFacebookConnectionAction } from "@/app/actions/facebook-connection";
import { inviteWorkspaceMemberAction } from "@/app/actions/members";
import { updateChurchProfileAction } from "@/app/actions/workspace-profile";
import { requireCurrentUser, requirePrimaryWorkspaceMembership } from "@/lib/auth";
import { hasWorkspacePermission } from "@/lib/authorization";
import { parseChurchProfile } from "@/lib/church-profile";
import { env } from "@/lib/env";
import { parseFacebookConnection } from "@/lib/facebook-connection";
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

function profileMessage(status: string | undefined) {
  switch (status) {
    case "saved":
      return "Church profile updated.";
    case "invalid":
      return "Enter valid church profile values.";
    default:
      return null;
  }
}

function facebookMessage(status: string | undefined) {
  switch (status) {
    case "saved":
      return "Facebook connection updated.";
    case "invalid":
      return "Enter a valid numeric Facebook Page ID.";
    default:
      return null;
  }
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string; profile?: string; facebook?: string }>;
}) {
  const user = await requireCurrentUser();
  const membership = await requirePrimaryWorkspaceMembership(user.id);
  const workspace = membership.workspace;
  const params = await searchParams;
  const canManageMembers = hasWorkspacePermission(membership.role, "MANAGE_MEMBERS");
  const canManageProfile = hasWorkspacePermission(membership.role, "MANAGE_WORKSPACE_PROFILE");
  const canManageFacebook = hasWorkspacePermission(membership.role, "MANAGE_FACEBOOK_CONNECTION");
  const churchProfile = parseChurchProfile(workspace.settings);
  const facebookConnection = parseFacebookConnection(workspace.settings);
  const metaCredentialsConfigured = Boolean(env.META_SYSTEM_USER_TOKEN);
  const profileStatusMessage = profileMessage(params.profile);
  const facebookStatusMessage = facebookMessage(params.facebook);
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
            <dd className="mt-1 font-semibold">{churchProfile.timezone}</dd>
          </div>
          <div className="rounded-md border border-stone-200 p-4">
            <dt className="text-sm text-stone-500">Primary service day</dt>
            <dd className="mt-1 font-semibold">{churchProfile.serviceDay}</dd>
          </div>
        </dl>
      </div>

      <div className="rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-medium text-teal-800">Settings</p>
        <h2 className="mt-1 text-xl font-semibold">Church profile</h2>
        <p className="mt-1 text-sm text-stone-500">
          Controls how many clips we generate per sermon and how many posts go out per day.
        </p>
        {profileStatusMessage ? (
          <div className="mt-4 rounded-md border border-teal-100 bg-teal-50 p-3 text-sm text-teal-900">
            {profileStatusMessage}
          </div>
        ) : null}
        {canManageProfile ? (
          <form action={updateChurchProfileAction} className="mt-5 grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="timezone" className="text-sm font-medium">
                  Timezone
                </label>
                <input
                  id="timezone"
                  name="timezone"
                  required
                  defaultValue={churchProfile.timezone}
                  className="mt-2 w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
                />
              </div>
              <div>
                <label htmlFor="serviceDay" className="text-sm font-medium">
                  Primary service day
                </label>
                <input
                  id="serviceDay"
                  name="serviceDay"
                  required
                  defaultValue={churchProfile.serviceDay}
                  className="mt-2 w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="sermonsPerWeek" className="text-sm font-medium">
                  Sermons per week
                </label>
                <select
                  id="sermonsPerWeek"
                  name="sermonsPerWeek"
                  defaultValue={String(churchProfile.sermonsPerWeek)}
                  className="mt-2 w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
                >
                  <option value="1">1 (Sunday only)</option>
                  <option value="2">2 (Sunday &amp; Wednesday)</option>
                </select>
              </div>
              <div>
                <label htmlFor="secondServiceDay" className="text-sm font-medium">
                  Second service day
                </label>
                <input
                  id="secondServiceDay"
                  name="secondServiceDay"
                  defaultValue={churchProfile.secondServiceDay ?? "Wednesday"}
                  className="mt-2 w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
                />
                <p className="mt-1 text-xs text-stone-500">Only used if you selected 2 sermons per week.</p>
              </div>
            </div>
            <div className="sm:w-48">
              <label htmlFor="postsPerDay" className="text-sm font-medium">
                Total posts per day
              </label>
              <input
                id="postsPerDay"
                name="postsPerDay"
                type="number"
                min={1}
                max={10}
                required
                defaultValue={churchProfile.postsPerDay}
                className="mt-2 w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
              />
              <p className="mt-1 text-xs text-stone-500">
                Phase 1 supports video reels only, so this must be 1 for now.
              </p>
            </div>
            <button
              type="submit"
              className="w-fit rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800"
            >
              Save church profile
            </button>
          </form>
        ) : null}
      </div>

      <div className="rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-medium text-teal-800">Settings</p>
        <h2 className="mt-1 text-xl font-semibold">Facebook auto-posting</h2>
        <p className="mt-1 text-sm text-stone-500">
          The calendar (see Calendar in the sidebar) only plans clips — nothing posts anywhere until
          you connect a Page and turn this on. Owner-only, on purpose.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <span
            className={`inline-block rounded-full px-2.5 py-1 text-xs font-medium ${
              facebookConnection.autoPostEnabled
                ? "bg-red-100 text-red-800"
                : "bg-stone-100 text-stone-600"
            }`}
          >
            {facebookConnection.autoPostEnabled ? "LIVE — posting automatically" : "Not live"}
          </span>
          <span
            className={`inline-block rounded-full px-2.5 py-1 text-xs font-medium ${
              metaCredentialsConfigured ? "bg-teal-100 text-teal-900" : "bg-amber-100 text-amber-900"
            }`}
          >
            Meta credentials: {metaCredentialsConfigured ? "configured" : "not configured"}
          </span>
        </div>
        {facebookStatusMessage ? (
          <div className="mt-4 rounded-md border border-teal-100 bg-teal-50 p-3 text-sm text-teal-900">
            {facebookStatusMessage}
          </div>
        ) : null}
        {canManageFacebook ? (
          <form action={updateFacebookConnectionAction} className="mt-5 grid gap-4">
            <div className="sm:w-72">
              <label htmlFor="pageId" className="text-sm font-medium">
                Facebook Page ID
              </label>
              <input
                id="pageId"
                name="pageId"
                inputMode="numeric"
                placeholder="e.g. 1128280933691493"
                defaultValue={facebookConnection.pageId ?? ""}
                className="mt-2 w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
              />
              <p className="mt-1 text-xs text-stone-500">
                Set after the Page has been granted to the Meta Business Manager System User.
              </p>
            </div>
            <label className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm">
              <input
                type="checkbox"
                name="autoPostEnabled"
                defaultChecked={facebookConnection.autoPostEnabled}
                className="mt-0.5"
              />
              <span>
                <span className="font-semibold text-amber-900">Enable automatic posting.</span>{" "}
                <span className="text-amber-800">
                  Once on, the worker will publish this church&apos;s scheduled clips to the Page
                  above automatically, with no further review step. Only turn this on once you&apos;ve
                  verified the Page ID and are ready for real posts.
                </span>
              </span>
            </label>
            <button
              type="submit"
              className="w-fit rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800"
            >
              Save Facebook connection
            </button>
          </form>
        ) : null}
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
