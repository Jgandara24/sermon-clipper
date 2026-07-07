import { FileVideo, Sparkles } from "lucide-react";
import Image from "next/image";
import { notFound } from "next/navigation";
import { ClipList } from "@/components/clip-list";
import { ProcessingStatusTracker } from "@/components/processing-status-tracker";
import { StatusBadge } from "@/components/status-badge";
import { TranscriptViewer } from "@/components/transcript-viewer";
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
        include: {
          score: true,
          scriptureReferences: { orderBy: { createdAt: "asc" } },
          approvals: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      },
    },
  });

  if (!project) {
    notFound();
  }

  assertWorkspaceScope(project.workspaceId, workspace.id, "project");
  const transcriptionUnavailable = project.processingJobs.some(
    (job) =>
      job.errorCode === "TRANSCRIBE_PROVIDER_UNAVAILABLE" ||
      job.errorMessageUser?.toLowerCase().includes("transcription isn't configured"),
  );

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
            {project.sourceVideo?.durationS ? (
              <div>
                <dt className="text-stone-500">Duration / resolution</dt>
                <dd className="mt-1 font-medium">
                  {Math.round(project.sourceVideo.durationS.toNumber())}s
                  {project.sourceVideo.width && project.sourceVideo.height
                    ? ` · ${project.sourceVideo.width}×${project.sourceVideo.height}`
                    : ""}
                </dd>
              </div>
            ) : null}
          </dl>
          {project.sourceVideo?.thumbnailKey ? (
            <Image
              src={`/api/storage/${project.sourceVideo.thumbnailKey}`}
              alt=""
              width={640}
              height={360}
              unoptimized
              className="mt-4 aspect-video w-full rounded-md object-cover"
            />
          ) : null}
        </div>

        <ProcessingStatusTracker
          projectId={project.id}
          initialStatus={project.status}
          initialJobs={project.processingJobs.map((job) => ({
            id: job.id,
            type: job.type,
            state: job.state,
            errorCode: job.errorCode,
            errorMessageUser: job.errorMessageUser,
          }))}
        />
      </section>

      {transcriptionUnavailable ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 shadow-sm">
          Local speech-to-text is not configured for this environment. Upload an SRT file in the
          transcript panel below to keep going with clip analysis.
        </p>
      ) : null}

      {project.sourceVideo ? (
        <TranscriptViewer
          sourceVideoId={project.sourceVideo.id}
          transcriptionUnavailable={transcriptionUnavailable}
        />
      ) : null}

      <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <Sparkles size={18} aria-hidden="true" className="text-teal-800" />
          <h2 className="font-semibold">Suggested clips</h2>
        </div>
        <div className="mt-4">
          <ClipList
            initialClips={project.generatedClips.map((clip) => ({
              id: clip.id,
              rank: clip.rank,
              startMs: clip.startMs,
              endMs: clip.endMs,
              title: clip.title,
              hookText: clip.hookText,
              summary: clip.summary,
              status: clip.status,
              liked: clip.liked,
              score: clip.score
                ? {
                    total: clip.score.total,
                    subscores: clip.score.subscores as Record<
                      string,
                      { score: number; letter: string; note: string }
                    >,
                    modelVersion: clip.score.modelVersion,
                    excerpt: clip.score.excerpt,
                  }
                : null,
              scriptureReferences: clip.scriptureReferences.map((ref) => ({
                id: ref.id,
                normalized: ref.normalized,
                detectedText: ref.detectedText,
              })),
              approval: clip.approvals[0]
                ? {
                    state: clip.approvals[0].state,
                    reviewUrl: `/review/${clip.approvals[0].reviewToken}`,
                  }
                : null,
            }))}
          />
        </div>
      </section>
    </div>
  );
}
