import { Clock, FileVideo, Sparkles } from "lucide-react";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/status-badge";
import { formatDate, titleCaseStatus } from "@/lib/format";
import { assertWorkspaceScope } from "@/lib/project-service";
import { requireCurrentUser, requirePrimaryWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireCurrentUser();
  const workspace = await requirePrimaryWorkspace(user.id);
  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      sourceVideo: true,
      processingJobs: { orderBy: { createdAt: "asc" } },
      generatedClips: {
        orderBy: { rank: "asc" },
        include: { score: true },
      },
    },
  });

  if (!project) {
    notFound();
  }

  assertWorkspaceScope(project.workspaceId, workspace.id, "project");

  return (
    <div className="grid gap-6">
      <section className="rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-teal-800">Project</p>
            <h1 className="mt-1 text-2xl font-semibold">{project.name}</h1>
            <p className="mt-2 text-sm text-stone-500">
              Created {formatDate(project.createdAt)}
              {project.series ? ` - ${project.series}` : ""}
              {project.speaker ? ` - ${project.speaker}` : ""}
            </p>
          </div>
          <StatusBadge status={project.status} />
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <FileVideo size={18} aria-hidden="true" className="text-teal-800" />
            <h2 className="font-semibold">Source</h2>
          </div>
          <dl className="mt-4 grid gap-3 text-sm">
            <div>
              <dt className="text-stone-500">Origin</dt>
              <dd className="mt-1 font-medium">
                {project.sourceVideo ? titleCaseStatus(project.sourceVideo.origin) : "Not attached"}
              </dd>
            </div>
            <div>
              <dt className="text-stone-500">File or URL</dt>
              <dd className="mt-1 break-words font-medium">
                {project.sourceVideo?.originUrl ?? project.sourceVideo?.filename ?? "Draft only"}
              </dd>
            </div>
          </dl>
        </div>

        <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm lg:col-span-2">
          <div className="flex items-center gap-2">
            <Clock size={18} aria-hidden="true" className="text-teal-800" />
            <h2 className="font-semibold">Processing stages</h2>
          </div>
          <div className="mt-4 grid gap-3">
            {project.processingJobs.map((job) => (
              <div
                key={job.id}
                className="flex items-center justify-between rounded-md border border-stone-200 px-3 py-2"
              >
                <div>
                  <p className="text-sm font-medium">{titleCaseStatus(job.type)}</p>
                  <p className="text-xs text-stone-500">
                    {job.errorMessageUser ?? "Waiting for later phase wiring."}
                  </p>
                </div>
                <StatusBadge status={job.state} />
              </div>
            ))}
            {project.processingJobs.length === 0 ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                Processing jobs are stubbed until upload and queue plumbing begins.
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <Sparkles size={18} aria-hidden="true" className="text-teal-800" />
          <h2 className="font-semibold">Suggested clips</h2>
        </div>
        <div className="mt-4 grid gap-3">
          {project.generatedClips.map((clip) => (
            <article key={clip.id} className="rounded-lg border border-stone-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
                    Rank {clip.rank}
                  </p>
                  <h3 className="mt-1 text-base font-semibold">{clip.title}</h3>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">{clip.summary}</p>
                </div>
                {clip.score ? (
                  <div className="rounded-lg bg-teal-700 px-4 py-3 text-center text-white">
                    <p className="text-xs">Score</p>
                    <p className="text-2xl font-semibold">{clip.score.total}</p>
                  </div>
                ) : null}
              </div>
            </article>
          ))}
          {project.generatedClips.length === 0 ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              Clip generation is intentionally stubbed in Phase 1.
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
