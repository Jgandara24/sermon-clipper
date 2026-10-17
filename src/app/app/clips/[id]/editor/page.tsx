import { notFound } from "next/navigation";
import { ClipEditor } from "@/components/clip-editor";
import { isClipApprovedForPublish, publishApprovalBlockMessage } from "@/lib/approval";
import { requireCurrentUser, requirePrimaryWorkspacePermission } from "@/lib/auth";
import { parseLowerThird } from "@/lib/brand-template";
import { buildDefaultEditorState, type EditorState } from "@/lib/editor/types";
import { createSignedMediaUrl } from "@/lib/media/signed-url";
import { sermonPreparationEnabled } from "@/lib/media/preparation-config";
import { sourcePreviewUrl } from "@/lib/media/proxy-preview";
import { prisma } from "@/lib/prisma";
import { assertWorkspaceScope } from "@/lib/project-service";

export const dynamic = "force-dynamic";

export default async function ClipEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireCurrentUser();
  const membership = await requirePrimaryWorkspacePermission(user.id, "EDIT_CLIP");
  const workspace = membership.workspace;
  const { id } = await params;

  const clip = await prisma.generatedClip.findUnique({
    where: { id },
    include: {
      project: {
        include: {
          sourceVideo: {
            include: {
              transcript: { include: { segments: { orderBy: { idx: "asc" } } } },
            },
          },
        },
      },
    },
  });

  if (!clip) {
    notFound();
  }

  assertWorkspaceScope(clip.workspaceId, workspace.id, "clip");

  const sourceVideo = clip.project.sourceVideo;
  if (!sourceVideo) {
    notFound();
  }
  const sourceContentType = sourceVideo.filename?.toLowerCase().endsWith(".mov")
    ? "video/quicktime"
    : "video/mp4";
  // With preparation on, the editor plays the registered uncropped proxy, which outlives an early-deleted original.
  // Crop and caption positions are fractions of the frame, so the proxy's smaller size does not change them.
  const sourceVideoUrl = sermonPreparationEnabled()
    ? await sourcePreviewUrl(prisma, { id: sourceVideo.id, workspaceId: workspace.id, storageKey: sourceVideo.storageKey })
    : sourceVideo.storageKey
      ? createSignedMediaUrl({
          key: sourceVideo.storageKey,
          workspaceId: workspace.id,
          contentType: sourceContentType,
          filename: sourceVideo.filename ?? undefined,
        })
      : null;
  if (!sourceVideoUrl) {
    notFound();
  }

  const latestEdit = await prisma.clipEdit.findFirst({
    where: { clipId: id },
    orderBy: { version: "desc" },
  });
  const latestApproval = await prisma.clipApproval.findUnique({
    where: { clipId: id },
  });
  const brandTemplates = await prisma.brandTemplate.findMany({
    where: { workspaceId: workspace.id },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });

  const initialVersion = latestEdit?.version ?? 0;
  const initialState: EditorState = latestEdit
    ? (latestEdit.editorState as unknown as EditorState)
    : buildDefaultEditorState({
        sourceVideoId: sourceVideo.id,
        startMs: clip.startMs,
        endMs: clip.endMs,
      });

  const sourceDurationMs = sourceVideo.durationS
    ? Math.round(sourceVideo.durationS.toNumber() * 1000)
    : clip.endMs;
  return (
    <ClipEditor
      clipId={clip.id}
      clipTitle={clip.title}
      sourceVideoUrl={sourceVideoUrl}
      sourceDurationMs={sourceDurationMs}
      segments={(sourceVideo.transcript?.segments ?? []).map((segment) => ({
        id: segment.id,
        startMs: segment.startMs,
        endMs: segment.endMs,
        words: segment.words as Array<{
          word: string;
          startMs: number;
          endMs: number;
          confidence: number;
          isFiller: boolean;
          deleted: boolean;
        }>,
      }))}
      initialVersion={initialVersion}
      initialState={initialState}
      brandTemplates={brandTemplates.map((template) => ({
        id: template.id,
        name: template.name,
        churchName: template.churchName,
        speakerName: template.speakerName,
        primaryColor: template.primaryColor,
        accentColor: template.accentColor,
        captionPresetId: template.captionPresetId,
        lowerThird: parseLowerThird(template.lowerThird),
      }))}
      publishBlockedReason={
        isClipApprovedForPublish(latestApproval?.state)
          ? null
          : publishApprovalBlockMessage(latestApproval?.state)
      }
    />
  );
}
