import { acceptWorkspaceInvitationAction } from "@/app/actions/members";
import { getCurrentUser } from "@/lib/auth";
import { findWorkspaceInvitationByToken, workspaceInvitationPath } from "@/lib/workspace-invitations";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

function errorMessage(error: string | undefined) {
  switch (error) {
    case "email-mismatch":
      return "Sign in with the email address that received this invitation.";
    case "expired":
      return "This invitation expired. Ask a workspace admin for a new invite.";
    case "unavailable":
      return "This invitation is no longer available.";
    default:
      return null;
  }
}

export default async function JoinWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const user = await getCurrentUser();
  const invitation = await findWorkspaceInvitationByToken(prisma, token);
  const message = errorMessage(query.error);
  const nextPath = workspaceInvitationPath(token);

  if (!invitation || invitation.status !== "PENDING") {
    return (
      <main className="min-h-screen bg-[#f6f5f0] px-5 py-10 text-stone-950">
        <section className="mx-auto max-w-md rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-medium text-teal-800">Workspace invitation</p>
          <h1 className="mt-1 text-2xl font-semibold">Invitation unavailable</h1>
          <p className="mt-3 text-sm text-stone-600">
            This invite is missing, expired, already accepted, or revoked. Ask a workspace admin for
            a new invitation.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#f6f5f0] px-5 py-10 text-stone-950">
      <section className="mx-auto max-w-md rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-medium text-teal-800">Workspace invitation</p>
        <h1 className="mt-1 text-2xl font-semibold">Join {invitation.workspace.name}</h1>
        <p className="mt-3 text-sm text-stone-600">
          You were invited as {invitation.role.toLowerCase()} using {invitation.email}. This invite
          expires {invitation.expiresAt.toLocaleDateString()}.
        </p>

        {message ? (
          <div className="mt-5 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            {message}
          </div>
        ) : null}

        {!user ? (
          <a
            href={`/login?email=${encodeURIComponent(invitation.email)}&next=${encodeURIComponent(nextPath)}`}
            className="mt-6 inline-flex w-full justify-center rounded-md bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-800"
          >
            Sign in to accept
          </a>
        ) : user.email.toLowerCase() !== invitation.email ? (
          <div className="mt-5 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            You are signed in as {user.email}. Sign out and use {invitation.email} to accept this
            invite.
          </div>
        ) : (
          <form action={acceptWorkspaceInvitationAction} className="mt-6">
            <input type="hidden" name="token" value={token} />
            <button
              type="submit"
              className="w-full rounded-md bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-800"
            >
              Join workspace
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
