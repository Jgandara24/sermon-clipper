import { createWorkspaceAction } from "@/app/actions/auth";
import { requireCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  await requireCurrentUser();

  return (
    <main className="min-h-screen bg-[#f6f5f0] px-5 py-10 text-stone-950">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-xl items-center">
        <section className="w-full rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-medium text-teal-800">Workspace setup</p>
          <h1 className="mt-2 text-2xl font-semibold">Create a church workspace</h1>
          <form action={createWorkspaceAction} className="mt-6 grid gap-4">
            <div>
              <label htmlFor="workspaceName" className="text-sm font-medium">
                Church or workspace name
              </label>
              <input
                id="workspaceName"
                name="workspaceName"
                required
                defaultValue="First Baptist Demo"
                className="mt-2 w-full rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="timezone" className="text-sm font-medium">
                  Timezone
                </label>
                <input
                  id="timezone"
                  name="timezone"
                  required
                  defaultValue="America/Chicago"
                  className="mt-2 w-full rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
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
                  defaultValue="Sunday"
                  className="mt-2 w-full rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
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
                  defaultValue="1"
                  className="mt-2 w-full rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
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
                  defaultValue="Wednesday"
                  className="mt-2 w-full rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
                />
                <p className="mt-1 text-xs text-stone-500">Only used if you selected 2 sermons per week.</p>
              </div>
            </div>
            <button
              type="submit"
              className="rounded-md bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-800"
            >
              Create workspace
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
