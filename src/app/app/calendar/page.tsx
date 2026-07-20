import { PlatformPicker } from "@/components/platform-picker";
import { requireCurrentUser, requirePrimaryWorkspaceMembership } from "@/lib/auth";
import { hasWorkspacePermission } from "@/lib/authorization";
import { isEligibleForAutoPost, parseFacebookConnection } from "@/lib/facebook-connection";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const DAYS_AHEAD = 13;

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

// scheduledDate is a date-only column (calendar day, no time); formatting must pin to
// UTC or a server west of UTC would render it as the day before.
function formatDayLabel(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function publishStatusBadge(publishStatus: string) {
  switch (publishStatus) {
    case "SUCCEEDED":
      return { label: "Posted", className: "bg-teal-100 text-teal-900" };
    case "IN_PROGRESS":
      return { label: "Posting…", className: "bg-amber-100 text-amber-900" };
    case "FAILED":
      return { label: "Post failed", className: "bg-red-100 text-red-800" };
    default:
      return null;
  }
}

export default async function CalendarPage() {
  const user = await requireCurrentUser();
  const membership = await requirePrimaryWorkspaceMembership(user.id);
  const canManageSchedule = hasWorkspacePermission(membership.role, "MANAGE_SCHEDULE");
  const facebookConnection = parseFacebookConnection(membership.workspace.settings);
  const isLive = isEligibleForAutoPost(facebookConnection);

  const rangeStart = startOfUtcDay(new Date());
  const rangeEnd = addUtcDays(rangeStart, DAYS_AHEAD);

  const scheduledPosts = await prisma.scheduledPost.findMany({
    where: {
      workspaceId: membership.workspace.id,
      scheduledDate: { gte: rangeStart, lte: rangeEnd },
    },
    orderBy: [{ scheduledDate: "asc" }],
    include: {
      clip: {
        select: { title: true, rank: true, project: { select: { name: true } } },
      },
    },
  });

  const postsByDate = new Map<string, typeof scheduledPosts>();
  for (const post of scheduledPosts) {
    const key = dateKey(post.scheduledDate);
    const existing = postsByDate.get(key);
    if (existing) {
      existing.push(post);
    } else {
      postsByDate.set(key, [post]);
    }
  }

  const days = Array.from({ length: DAYS_AHEAD + 1 }, (_, i) => addUtcDays(rangeStart, i));

  return (
    <section className="grid max-w-4xl gap-6">
      <div className="rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-medium text-teal-800">Calendar</p>
        <h1 className="mt-1 text-2xl font-semibold">Weekly posting plan</h1>
        <p className="mt-2 text-sm text-stone-500">
          {isLive ? (
            <>
              <span className="font-semibold text-red-700">Live:</span> Facebook posts on this plan
              publish automatically once exported. Instagram, TikTok, and YouTube are shown for when
              they&apos;re ready.
            </>
          ) : (
            <>
              This is a plan, not an action — nothing here posts automatically yet. Facebook is the
              only platform that&apos;s live today; Instagram, TikTok, and YouTube are shown so the
              schedule is ready for them later.
            </>
          )}
        </p>
      </div>

      <div className="grid gap-4">
        {days.map((day) => {
          const key = dateKey(day);
          const posts = postsByDate.get(key) ?? [];

          return (
            <div key={key} className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-stone-700">{formatDayLabel(day)}</h2>
              {posts.length === 0 ? (
                <p className="mt-3 text-sm text-stone-400">No clips scheduled.</p>
              ) : (
                <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {posts.map((post) => {
                    const badge = publishStatusBadge(post.publishStatus);
                    return (
                      <div key={post.id} className="rounded-md border border-stone-200 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-xs font-medium uppercase tracking-wide text-stone-400">
                            {post.clip?.project.name ?? "Earlier clip set"}
                          </p>
                          {badge ? (
                            <span
                              className={`inline-block shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${badge.className}`}
                            >
                              {badge.label}
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 text-sm font-semibold">
                          {post.clip?.title ?? "Posted clip (regenerated since)"}
                        </p>
                        {post.clip ? (
                          <p className="mt-1 text-xs text-stone-500">Rank #{post.clip.rank}</p>
                        ) : null}
                        <div className="mt-3">
                          {canManageSchedule ? (
                            <PlatformPicker scheduledPostId={post.id} platform={post.platform} />
                          ) : (
                            <span className="inline-block rounded-full bg-stone-100 px-2 py-1 text-xs font-medium text-stone-600">
                              {post.platform}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
