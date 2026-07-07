import { CheckCircle2, MessageSquareWarning } from "lucide-react";
import { notFound } from "next/navigation";
import { decideClipReviewAction } from "@/app/actions/review";
import { formatDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function ClipReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { token } = await params;
  const { saved } = await searchParams;
  const approval = await prisma.clipApproval.findUnique({
    where: { reviewToken: token },
    include: {
      clip: {
        include: {
          score: true,
          scriptureReferences: { orderBy: { createdAt: "asc" } },
          project: true,
        },
      },
      workspace: true,
    },
  });

  if (!approval) {
    notFound();
  }

  return (
    <main className="min-h-screen bg-[#f6f5f0] px-4 py-6 text-stone-950">
      <div className="mx-auto max-w-xl">
        <section className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-teal-800">Clip review</p>
          <h1 className="mt-1 text-2xl font-semibold">{approval.clip.title}</h1>
          <p className="mt-2 text-sm text-stone-500">
            {approval.workspace.name} · {approval.clip.project.name}
          </p>
          <p className="mt-4 rounded-lg bg-stone-50 p-3 text-sm leading-6 text-stone-700">
            {approval.clip.summary}
          </p>

          {approval.clip.scriptureReferences.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {approval.clip.scriptureReferences.map((ref) => (
                <span key={ref.id} className="rounded-full bg-teal-50 px-3 py-1 text-xs font-medium text-teal-900">
                  {ref.normalized}
                </span>
              ))}
            </div>
          ) : null}

          {approval.clip.score ? (
            <div className="mt-4 rounded-lg border border-stone-200 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-stone-500">Score</p>
              <p className="mt-1 text-3xl font-semibold text-teal-800">{approval.clip.score.total}</p>
              <p className="mt-2 text-sm text-stone-600">{approval.clip.score.excerpt}</p>
            </div>
          ) : null}
        </section>

        <section className="mt-4 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
          {saved ? (
            <p className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
              Review saved.
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-semibold">Current decision</p>
              <p className="text-sm text-stone-500">
                {approval.state.replace(/_/g, " ")}
                {approval.decidedAt ? ` · ${formatDate(approval.decidedAt)}` : ""}
              </p>
            </div>
          </div>

          <form action={decideClipReviewAction} className="mt-5 grid gap-3">
            <input type="hidden" name="token" value={approval.reviewToken} />
            <label className="grid gap-1 text-sm">
              <span className="font-medium text-stone-700">Your name</span>
              <input
                name="approverName"
                defaultValue={approval.approverName ?? ""}
                className="rounded-md border border-stone-300 px-3 py-2"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium text-stone-700">Comment</span>
              <textarea
                name="comment"
                defaultValue={approval.comment ?? ""}
                rows={4}
                className="rounded-md border border-stone-300 px-3 py-2"
                placeholder="Optional note for the media volunteer"
              />
            </label>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="submit"
                name="decision"
                value="approve"
                className="inline-flex items-center justify-center gap-2 rounded-md bg-teal-700 px-4 py-3 text-sm font-semibold text-white hover:bg-teal-800"
              >
                <CheckCircle2 size={18} aria-hidden="true" />
                Approve clip
              </button>
              <button
                type="submit"
                name="decision"
                value="changes"
                className="inline-flex items-center justify-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900 hover:bg-amber-100"
              >
                <MessageSquareWarning size={18} aria-hidden="true" />
                Request changes
              </button>
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}
