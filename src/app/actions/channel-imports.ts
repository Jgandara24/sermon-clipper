"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireCurrentUser, requirePrimaryWorkspacePermission } from "@/lib/auth";
import {
  ChannelImportInputError,
  DuplicateChannelImportError,
  registerChannelImportSource,
  setChannelImportSourceEnabled,
} from "@/lib/channel-import-service";
import {
  YouTubeApiAuthError,
  YouTubeApiError,
  YouTubeChannelNotFoundError,
} from "@/lib/integrations/youtube";
import { prisma } from "@/lib/prisma";

const IMPORTS_PATH = "/app/settings/imports";

const registerSchema = z.object({
  channel: z.string().trim().min(1).max(200),
});

const setEnabledSchema = z.object({
  sourceId: z.string().uuid(),
  enabled: z.enum(["true", "false"]),
});

export async function registerChannelImportAction(formData: FormData) {
  const user = await requireCurrentUser();
  const membership = await requirePrimaryWorkspacePermission(user.id, "MANAGE_OPERATIONS");

  const parsed = registerSchema.safeParse({ channel: formData.get("channel") });
  if (!parsed.success) {
    redirect(`${IMPORTS_PATH}?imports=invalid-input`);
  }

  try {
    await registerChannelImportSource(prisma, membership.workspace.id, parsed.data.channel);
  } catch (error) {
    if (error instanceof ChannelImportInputError) {
      redirect(`${IMPORTS_PATH}?imports=invalid-input`);
    }
    if (error instanceof YouTubeChannelNotFoundError) {
      redirect(`${IMPORTS_PATH}?imports=channel-not-found`);
    }
    if (error instanceof DuplicateChannelImportError) {
      redirect(`${IMPORTS_PATH}?imports=duplicate`);
    }
    if (error instanceof YouTubeApiAuthError) {
      redirect(`${IMPORTS_PATH}?imports=api-auth`);
    }
    if (error instanceof YouTubeApiError) {
      redirect(`${IMPORTS_PATH}?imports=api-error`);
    }
    throw error;
  }

  revalidatePath(IMPORTS_PATH);
  redirect(`${IMPORTS_PATH}?imports=registered`);
}

export async function setChannelImportEnabledAction(formData: FormData) {
  const user = await requireCurrentUser();
  const membership = await requirePrimaryWorkspacePermission(user.id, "MANAGE_OPERATIONS");

  const parsed = setEnabledSchema.safeParse({
    sourceId: formData.get("sourceId"),
    enabled: formData.get("enabled"),
  });
  if (!parsed.success) {
    redirect(`${IMPORTS_PATH}?imports=invalid-input`);
  }

  try {
    await setChannelImportSourceEnabled(
      prisma,
      membership.workspace.id,
      parsed.data.sourceId,
      parsed.data.enabled === "true",
    );
  } catch (error) {
    if (error instanceof ChannelImportInputError) {
      redirect(`${IMPORTS_PATH}?imports=not-found`);
    }
    throw error;
  }

  revalidatePath(IMPORTS_PATH);
  redirect(IMPORTS_PATH);
}
