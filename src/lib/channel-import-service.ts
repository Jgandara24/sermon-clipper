import { ChannelImportPlatform, Prisma, type PrismaClient } from "@prisma/client";
import { resolveUploadsPlaylist, type YouTubeChannel } from "@/lib/integrations/youtube";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { assertWorkspaceScope } from "@/lib/project-service";

/**
 * Channel auto-import registration and workspace-scoped management.
 *
 * Registration resolves the channel against the YouTube API *synchronously* so a bad
 * handle/URL fails fast with a clear error instead of persisting a silently-broken row.
 * No bulk backfill happens on registration — only videos published after registration are
 * ever imported (confirmed decision; see docs/AUTO_IMPORT_LOOP.md and DECISIONS.md).
 * Polling itself is the worker's job (Phase 3), not this module's.
 */

/** User-correctable problem with the channel input (empty, unrecognized shape, bad URL form). */
export class ChannelImportInputError extends Error {}

/** The workspace already has this exact channel registered (unique-constraint backed). */
export class DuplicateChannelImportError extends Error {}

const CHANNEL_ID_PATTERN = /^UC[0-9A-Za-z_-]{22}$/;
// YouTube handles are 3-30 chars of letters, digits, underscores, hyphens, and periods.
const HANDLE_PATTERN = /^@?[A-Za-z0-9._-]{3,30}$/;

const INPUT_HINT =
  'Enter a channel handle (like "@churchname"), a channel id (starting with "UC"), or a youtube.com channel URL.';

/**
 * Normalizes flexible user input — "@handle", bare handle, "UC..." channel id, or a full
 * youtube.com channel URL — into the id-or-handle string the YouTube client accepts.
 * Throws `ChannelImportInputError` for anything else.
 */
export function normalizeChannelInput(raw: string): string {
  const input = raw.trim();
  if (!input) {
    throw new ChannelImportInputError(`Channel is required. ${INPUT_HINT}`);
  }

  if (CHANNEL_ID_PATTERN.test(input)) {
    return input;
  }

  if (/youtube\.com/i.test(input)) {
    return normalizeChannelUrl(input);
  }

  if (HANDLE_PATTERN.test(input)) {
    return input.startsWith("@") ? input : `@${input}`;
  }

  throw new ChannelImportInputError(`That doesn't look like a YouTube channel. ${INPUT_HINT}`);
}

function normalizeChannelUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new ChannelImportInputError(`That URL could not be parsed. ${INPUT_HINT}`);
  }
  if (!/(^|\.)youtube\.com$/i.test(url.hostname)) {
    throw new ChannelImportInputError(`Only youtube.com channel URLs are supported. ${INPUT_HINT}`);
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const [first, second] = segments;

  if (first === "channel" && second && CHANNEL_ID_PATTERN.test(second)) {
    return second;
  }
  if (first?.startsWith("@") && HANDLE_PATTERN.test(first)) {
    return first;
  }
  if (first === "c" || first === "user") {
    throw new ChannelImportInputError(
      `Legacy /c/ and /user/ URLs can't be resolved reliably. ${INPUT_HINT}`,
    );
  }

  throw new ChannelImportInputError(`That URL doesn't point at a YouTube channel. ${INPUT_HINT}`);
}

type ResolveChannel = (channelIdOrHandle: string) => Promise<YouTubeChannel>;

/**
 * Registers a YouTube channel for auto-import. Resolves the channel via the injected resolver
 * (real YouTube client by default) before writing anything; propagates the client's typed
 * errors (unknown channel, quota/key, network) untouched so callers can message them clearly.
 */
export async function registerChannelImportSource(
  client: PrismaClient,
  workspaceId: string,
  rawInput: string,
  resolveChannel: ResolveChannel = resolveUploadsPlaylist,
) {
  const idOrHandle = normalizeChannelInput(rawInput);
  const channel = await resolveChannel(idOrHandle);

  try {
    const source = await client.channelImportSource.create({
      data: {
        workspaceId,
        platform: ChannelImportPlatform.YOUTUBE,
        channelId: channel.channelId,
        channelHandle: channel.handle,
        channelTitle: channel.title,
        uploadsPlaylistId: channel.uploadsPlaylistId,
      },
    });
    await recordOperationalEventSafely(client, {
      workspaceId,
      category: "channel_import",
      eventType: "channel_registered",
      message: `${channel.title} registered for auto-import.`,
      metadata: {
        channelImportSourceId: source.id,
        channelId: channel.channelId,
        channelTitle: channel.title,
      },
    });
    return source;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new DuplicateChannelImportError(
        `${channel.title} is already registered for this workspace.`,
      );
    }
    throw error;
  }
}

/** Lists the workspace's registered channels, newest registration first. */
export async function listChannelImportSources(client: PrismaClient, workspaceId: string) {
  return client.channelImportSource.findMany({
    where: { workspaceId },
    orderBy: { registeredAt: "desc" },
  });
}

/** Enables or disables a source after verifying it belongs to the workspace. */
export async function setChannelImportSourceEnabled(
  client: PrismaClient,
  workspaceId: string,
  sourceId: string,
  enabled: boolean,
) {
  const source = await client.channelImportSource.findUnique({ where: { id: sourceId } });
  if (!source) {
    throw new ChannelImportInputError("That channel registration no longer exists.");
  }
  assertWorkspaceScope(source.workspaceId, workspaceId, "channel import source");

  return client.channelImportSource.update({
    where: { id: source.id },
    data: { enabled },
  });
}
