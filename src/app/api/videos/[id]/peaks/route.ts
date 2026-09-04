import { requireApiWorkspace } from "@/lib/api/auth";
import { apiData, apiError } from "@/lib/api/response";
import { parsePeaksQuery, readAudioPeaks } from "@/lib/media/audio-peaks";
import { WavFormatError } from "@/lib/media/wav";
import { prisma } from "@/lib/prisma";
import { assertWorkspaceScope } from "@/lib/project-service";
import { getStorageProvider } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * Real amplitude for a window of a source video, for the timeline's Audio row.
 *
 * Same-origin on purpose: the media route redirects to a signed object URL in production, and a
 * browser reading the WAV from there would need the bucket to speak CORS. Reading the range here
 * needs nothing new, and the browser receives a few hundred numbers instead of megabytes of PCM.
 * Nothing is stored: the WAV the probe already wrote is the only artifact.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiWorkspace();
  if ("error" in auth) return auth.error;

  const query = parsePeaksQuery(new URL(request.url).searchParams);
  if (!query) {
    return apiError(
      "INVALID_RANGE",
      "fromMs, toMs and buckets must describe a window inside an hour, with up to 2000 bars.",
      { status: 400 },
    );
  }

  const { id } = await params;
  const sourceVideo = await prisma.sourceVideo.findUnique({ where: { id } });
  if (!sourceVideo) {
    return apiError("NOT_FOUND", "That video does not exist.", { status: 404 });
  }
  try {
    assertWorkspaceScope(sourceVideo.workspaceId, auth.workspace.id, "source video");
  } catch {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", {
      status: 403,
    });
  }
  if (!sourceVideo.audioKey) {
    // Not a fault: the probe has not run, or ran before audio extraction existed. The row falls
    // back to what it can draw without audio.
    return apiError("AUDIO_UNAVAILABLE", "This video's audio has not been extracted yet.", {
      status: 404,
    });
  }

  try {
    const peaks = await readAudioPeaks(getStorageProvider(), sourceVideo.audioKey, query);
    return apiData(
      { fromMs: query.fromMs, toMs: query.toMs, peaks },
      { headers: { "Cache-Control": "private, max-age=300" } },
    );
  } catch (error) {
    if (error instanceof WavFormatError) {
      // The probe wrote something this cannot read. A fault worth a report, not a row drawn from
      // garbage.
      return apiError("AUDIO_UNREADABLE", "This video's extracted audio could not be read.", {
        status: 500,
      });
    }
    throw error;
  }
}
