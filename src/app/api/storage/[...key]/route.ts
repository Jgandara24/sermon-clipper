import { requireApiWorkspace } from "@/lib/api/auth";
import { apiError } from "@/lib/api/response";
import { getStorageProvider } from "@/lib/storage";

// Only thumbnails are browser-servable for now — originals/audio stay off-limits to this route.
export async function GET(request: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const auth = await requireApiWorkspace();
  if ("error" in auth) return auth.error;
  const { workspace } = auth;

  const { key: keyParts } = await params;
  const key = keyParts.join("/");

  if (!key.startsWith(`thumbs/${workspace.id}/`)) {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 403 });
  }

  const storage = getStorageProvider();
  if (!(await storage.exists(key))) {
    return apiError("STORAGE_UNAVAILABLE", "Storage hiccup — try again in a minute.", { status: 404 });
  }

  const buffer = await storage.readAsBuffer(key);
  return new Response(new Uint8Array(buffer), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=300" },
  });
}
