import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EditorialExceptionList } from "@/components/operator/editorial-exception-list";
import { OperatorProjectCandidatePool } from "@/components/operator/project-candidate-pool";
import { requirePlatformOperator } from "@/lib/auth";
import { loadOperatorProjectPool } from "@/lib/candidates/query";
import { createSignedMediaUrl } from "@/lib/media/signed-url";
import { prisma } from "@/lib/prisma";
import { loadShortageResolutionOptions } from "@/lib/review/prior-service-fill-options";
import {
  assertNoSelectorSignal,
  editorialExceptionsForProject,
  replacementLineageForProject,
} from "@/lib/review/query";

export const dynamic = "force-dynamic";

/**
 * One church's service, inspected by staff.
 *
 * **What this page grants, and what it does not.** The platform-operator marker is narrow on
 * purpose: it opens reading across workspaces and nothing else. There is no control here to change
 * a candidate limit, a workspace setting, a membership, a plan, or to publish anything. An
 * operator who needs to move the hidden override uses `npm run set:candidate-limit-override`,
 * which records who did it.
 *
 * **Media is signed for the church that owns it, never for the operator.** `createSignedMediaUrl`
 * refuses to mint a URL scoped to a workspace the key does not live under, so passing the
 * operator's own id would throw rather than produce a link that 403s at playback. The workspace id
 * comes from the project just loaded.
 *
 * The check runs here rather than in a layout: a layout does not stop a route segment rendering,
 * so the guard belongs next to the data (Next's own authorization guidance).
 */
export default async function OperatorProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  await requirePlatformOperator();

  const { projectId } = await params;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      sermonDate: true,
      series: true,
      speaker: true,
      workspaceId: true,
      workspace: { select: { name: true } },
      sourceVideo: { select: { thumbnailKey: true, storageKey: true } },
    },
  });
  if (!project) notFound();

  const [pool, lineage, exceptions] = await Promise.all([
    loadOperatorProjectPool(prisma, { projectId }),
    replacementLineageForProject(prisma, projectId),
    editorialExceptionsForProject(prisma, projectId),
  ]);
  if (!pool) notFound();

  // The same guard the review model runs. This page is one click from the review queue, and a
  // reviewer who has seen the machine's confidence is no longer independent of it (S14).
  assertNoSelectorSignal({ pool, lineage, exceptions }, "operatorProject");

  // One signed link to the church's recording, shared by every candidate preview (P3.4). Signed
  // for the church, like everything else here. Null once retention has purged the media, so the
  // preview says so rather than offering a link that 404s.
  const previewUrl = project.sourceVideo?.storageKey
    ? createSignedMediaUrl({
        key: project.sourceVideo.storageKey,
        workspaceId: project.workspaceId,
        contentType: "video/mp4",
        disposition: "inline",
      })
    : null;

  // Fill options, only for the dates that have nothing to post. Loaded on the page rather than
  // fetched by the form, so nothing is requested until an operator has actually opened a service
  // with a shortage — there is no request on page load for services that are fine.
  const emptySlots = pool.slots.filter(
    (slot) => slot.clipId === null && (slot.publishStatus === "UNFILLED" || slot.publishStatus === "BLOCKED"),
  );
  const shortageEntries = await Promise.all(
    emptySlots.map(async (slot) => {
      const options = await loadShortageResolutionOptions(prisma, {
        scheduledPostId: slot.scheduledPostId,
      });
      return options ? ([slot.scheduledPostId, options] as const) : null;
    }),
  );
  const shortages = Object.fromEntries(
    shortageEntries.filter((entry): entry is [string, NonNullable<typeof entry>[1]] => entry !== null),
  );

  const thumbnailUrl = project.sourceVideo?.thumbnailKey
    ? createSignedMediaUrl({
        key: project.sourceVideo.thumbnailKey,
        // The church's workspace, read from the project — never the operator's own.
        workspaceId: project.workspaceId,
        contentType: "image/jpeg",
      })
    : null;

  return (
    <div className="grid gap-6">
      <section className="rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-teal-800">Operator</p>
            <h1 className="mt-1 text-2xl font-semibold">{project.name}</h1>
            <p className="mt-2 text-sm text-stone-500">
              {project.workspace.name}
              {project.series ? ` · ${project.series}` : ""}
              {project.speaker ? ` · ${project.speaker}` : ""}
            </p>
          </div>
          <Link
            href="/app/operator/review"
            className="text-sm text-teal-800 underline"
          >
            Back to the review queue
          </Link>
        </div>
        {thumbnailUrl ? (
          <Image
            src={thumbnailUrl}
            alt=""
            width={480}
            height={270}
            unoptimized
            data-testid="operator-project-thumbnail"
            className="mt-4 aspect-video w-full max-w-sm rounded-md object-cover"
          />
        ) : null}
      </section>

      <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="font-semibold">Exceptions</h2>
        <div className="mt-3">
          <EditorialExceptionList rows={exceptions} />
        </div>
      </section>

      <OperatorProjectCandidatePool
        pool={pool}
        lineage={lineage}
        previewUrl={previewUrl}
        shortages={shortages}
      />
    </div>
  );
}
