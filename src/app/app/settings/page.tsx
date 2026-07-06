import { requireCurrentUser, requirePrimaryWorkspace } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireCurrentUser();
  const workspace = await requirePrimaryWorkspace(user.id);
  const settings = workspace.settings as {
    churchProfile?: { timezone?: string; serviceDay?: string };
  };

  return (
    <section className="max-w-3xl rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
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
      <p className="mt-6 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        Settings forms are read-only stubs in Phase 1.
      </p>
    </section>
  );
}
