import {
  registerChannelImportAction,
  setChannelImportEnabledAction,
} from "@/app/actions/channel-imports";
import { requireCurrentUser, requirePrimaryWorkspacePermission } from "@/lib/auth";
import { listChannelImportSources } from "@/lib/channel-import-service";
import { formatDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

function importsMessage(status: string | undefined) {
  switch (status) {
    case "registered":
      return { tone: "ok" as const, text: "Channel registered. New uploads will be imported automatically once polling runs." };
    case "invalid-input":
      return {
        tone: "error" as const,
        text: 'Enter a channel handle (like "@churchname"), a channel id (starting with "UC"), or a youtube.com channel URL. Legacy /c/ and /user/ URLs are not supported.',
      };
    case "channel-not-found":
      return { tone: "error" as const, text: "No YouTube channel was found for that handle, id, or URL. Check the spelling and try again." };
    case "duplicate":
      return { tone: "error" as const, text: "That channel is already registered for this workspace." };
    case "api-auth":
      return {
        tone: "error" as const,
        text: "The YouTube API rejected the request — the API key may be missing/invalid or the daily quota exhausted. Try again later or check YOUTUBE_API_KEY.",
      };
    case "api-error":
      return { tone: "error" as const, text: "The YouTube API could not be reached. Try again in a few minutes." };
    case "not-found":
      return { tone: "error" as const, text: "That channel registration no longer exists." };
    default:
      return null;
  }
}

export default async function ImportsPage({
  searchParams,
}: {
  searchParams: Promise<{ imports?: string }>;
}) {
  const user = await requireCurrentUser();
  const membership = await requirePrimaryWorkspacePermission(user.id, "MANAGE_OPERATIONS");
  const workspace = membership.workspace;
  const params = await searchParams;
  const sources = await listChannelImportSources(prisma, workspace.id);
  const message = importsMessage(params.imports);

  return (
    <section className="grid gap-6">
      <div className="rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-medium text-teal-800">Auto-import</p>
        <h1 className="mt-1 text-2xl font-semibold">Channel imports</h1>
        <p className="mt-2 max-w-3xl text-sm text-stone-500">
          Register a public YouTube channel and new uploads are turned into projects
          automatically — the same pipeline as pasting a video URL, without the clicking. Only
          videos published after registration are imported; nothing is backfilled.
        </p>
      </div>

      <div className="rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold">Register a channel</h2>
        <p className="mt-1 text-sm text-stone-500">
          Paste the channel&apos;s handle (like &quot;@churchname&quot;), its channel id, or a
          youtube.com channel URL.
        </p>
        {message ? (
          <div
            className={`mt-4 rounded-md border p-3 text-sm ${
              message.tone === "ok"
                ? "border-teal-100 bg-teal-50 text-teal-900"
                : "border-red-100 bg-red-50 text-red-800"
            }`}
          >
            {message.text}
          </div>
        ) : null}
        <form action={registerChannelImportAction} className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
          <input
            type="text"
            name="channel"
            placeholder="@churchname or https://www.youtube.com/@churchname"
            required
            maxLength={200}
            className="rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
          />
          <button
            type="submit"
            className="rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800"
          >
            Register channel
          </button>
        </form>
      </div>

      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <th className="px-4 py-3">Channel</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Registered</th>
              <th className="px-4 py-3">Last polled</th>
              <th className="px-4 py-3">Last poll error</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => (
              <tr key={source.id} className="border-t border-stone-100 align-top">
                <td className="px-4 py-3">
                  <p className="font-medium">{source.channelTitle}</p>
                  <p className="text-xs text-stone-500">{source.channelHandle ?? source.channelId}</p>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      source.enabled ? "bg-teal-100 text-teal-900" : "bg-stone-100 text-stone-700"
                    }`}
                  >
                    {source.enabled ? "Enabled" : "Disabled"}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-stone-500">
                  {formatDate(source.registeredAt)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-stone-500">
                  {source.lastPolledAt ? formatDate(source.lastPolledAt) : "Never"}
                </td>
                <td className="px-4 py-3 text-stone-700">
                  {source.lastPollErrorMessage ? (
                    <>
                      <p className="text-red-800">{source.lastPollErrorMessage}</p>
                      {source.lastPollErrorAt ? (
                        <p className="mt-1 text-xs text-stone-500">{formatDate(source.lastPollErrorAt)}</p>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-stone-400">None</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <form action={setChannelImportEnabledAction}>
                    <input type="hidden" name="sourceId" value={source.id} />
                    <input type="hidden" name="enabled" value={source.enabled ? "false" : "true"} />
                    <button
                      type="submit"
                      className="rounded-md border border-stone-300 px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50"
                    >
                      {source.enabled ? "Disable" : "Enable"}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sources.length === 0 ? (
          <p className="border-t border-stone-100 px-4 py-6 text-sm text-stone-500">
            No channels registered yet.
          </p>
        ) : null}
      </div>
    </section>
  );
}
