import { redirect } from "next/navigation";
import { requireApiWorkspace } from "@/lib/api/auth";
import { apiError } from "@/lib/api/response";
import { createSignedMediaUrl } from "@/lib/media/signed-url";

// Authenticated compatibility shim. Only thumbnails are browser-servable from this route.
export async function GET(_request: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const auth = await requireApiWorkspace();
  if ("error" in auth) return auth.error;
  const { workspace } = auth;

  const { key: keyParts } = await params;
  const key = keyParts.join("/");

  if (!key.startsWith(`thumbs/${workspace.id}/`)) {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 403 });
  }

  redirect(createSignedMediaUrl({ key, workspaceId: workspace.id, contentType: "image/jpeg" }));
}
