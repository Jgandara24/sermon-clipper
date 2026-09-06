import { FileVideo, Sparkles } from "lucide-react";
import Image from "next/image";
import { notFound } from "next/navigation";
import { ClipList } from "@/components/clip-list";
import { ProcessingStatusTracker } from "@/components/processing-status-tracker";
import { StatusBadge } from "@/components/status-badge";
import { TranscriptViewer } from "@/components/transcript-viewer";
import { requireCurrentUser, requirePrimaryWorkspace } from "@/lib/auth";
import { formatDate, titleCaseStatus } from "@/lib/format";
import { createSignedMediaUrl } from "@/lib/media/signed-url";
import { ProjectServiceContextForm } from "@/components/project-service-context-form";
import { assessReanalysis } from "@/lib/analysis/reanalysis-policy";
import { assertWorkspaceScope, readProjectProcessingConfig } from "@/lib/project-service";
import { loadChurchProjectPool } from "@/lib/candidates/query";
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
          // `score` is deliberately not selected. A church never sees the machine's opinion of
          // its own sermon (plan §2.2), and not loading it is a stronger guarantee than
          // remembering not to render it.
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
  // The same boundary that governs re-analysis governs correcting the service: both change which
  // days this sermon owns. Read here only to decide whether to offer the control — the action
  // checks it again, because a Server Action is reachable without the UI.
  const serviceContextLocked = !(await assessReanalysis(prisma, { projectId: project.id })).allowed;
  // Where each candidate stands in the service (P3.1), with every internal limit already removed.
  const pool = await loadChurchProjectPool(prisma, { projectId: project.id });
  const snapshot = readProjectProcessingConfig(project.processingConfig);
  const transcriptionUnavailable = project.processingJobs.some(
    (job) =>
      job.errorCode === "TRANSCRIBE_PROVIDER_UNAVAILABLE" ||
      job.errorMessageUser?.toLowerCase().includes("transcription isn't configured"),
  );

  // The pool decides presentation state and order; the project rows carry the church-only extras
  // (summary, scripture, approval, liked) that the pool has no business knowing about. Merged
  // here rather than widening the read model, which would make P3.1 a church-page module.
  const extrasByClipId = new Map(project.generatedClips.map((clip) => [clip.id, clip]));
  const candidates = (pool?.candidates ?? []).map((candidate) => {
    const extra = extrasByClipId.get(candidate.clipId);
    return {
      id: candidate.clipId,
      rank: candidate.rank,
      startMs: candidate.sourceRange.startMs,
      endMs: candidate.sourceRange.endMs,
      title: candidate.title,
      hookText: candidate.hook,
      // A borrowed fill belongs to an older service and has no row here. It is shown so this
      // service's dates read correctly, with the facts the slot supplies and nothing invented.
      summary: extra?.summary ?? "This date is filled by a clip from an earlier service.",
      status: extra?.status ?? "KEPT",
      liked: extra?.liked ?? null,
      state: candidate.state,
      scheduledDate: candidate.scheduledDate?.toISOString() ?? null,
      finalRender: candidate.boundRender
        ? { state: candidate.boundRender.state, qcStatus: candidate.boundRender.qcStatus }
        : null,
      review: candidate.review,
      borrowedFromProjectId: candidate.borrowedFromProjectId,
      scriptureReferences: (extra?.scriptureReferences ?? []).map((ref) => ({
        id: ref.id,
        normalized: ref.normalized,
        detectedText: ref.detectedText,
      })),
      approval: extra?.approvals[0]
        ? {
            state: extra.approvals[0].state,
            reviewUrl: `/review/${extra.approvals[0].reviewToken}`,
            reviewTokenExpiresAt: extra.approvals[0].reviewTokenExpiresAt.toISOString(),
          }
        : null,
    };
  });
  const poolCount = pool?.retainedCount ?? 0;

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

      <ProjectServiceContextForm
        projectId={project.id}
        sermonDate={project.sermonDate}
        serviceOccurrence={snapshot.serviceOccurrence}
        locked={serviceContextLocked}
      />

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
              src={createSignedMediaUrl({
                key: project.sourceVideo.thumbnailKey,
                workspaceId: workspace.id,
                contentType: "image/jpeg",
              })}
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
          <h2 className="font-semibold">Clips from this sermon</h2>
        </div>
        {/*
          The number that actually exists, never a ceiling. "12 ranked clips" is allowed; "12 of
          18" or "up to 18" is not, because the configured limit is a staff control a church
          cannot see or change (plan §2.2, product-owner Decision 1). A short pool is a normal
          outcome of a sermon with fewer strong moments — the system is forbidden from padding
          one — so the copy never treats it as a fault.
        */}
        <p data-testid="candidate-pool-count" className="mt-1 text-sm text-stone-500">
          {poolCount === 0
            ? "No clips yet."
            : `${poolCount} ranked ${poolCount === 1 ? "clip" : "clips"} from this service.`}
        </p>
        <div className="mt-4">
          <ClipList initialClips={candidates} />
        </div>
      </section>
    </div>
  );
}
