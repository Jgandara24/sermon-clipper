import { createHmac, timingSafeEqual } from "node:crypto";

export const DEFAULT_MEDIA_URL_TTL_SECONDS = 15 * 60;
export const DEFAULT_UPLOAD_URL_TTL_SECONDS = 15 * 60;

type SignedMediaUrlInput = {
  key: string;
  workspaceId: string;
  expiresInSeconds?: number;
  contentType?: string;
  filename?: string;
  disposition?: "inline" | "attachment";
};

type SignedUploadUrlInput = {
  uploadId: string;
  workspaceId: string;
  expiresInSeconds?: number;
};

export type VerifiedSignedMediaUrl =
  | {
      ok: true;
      key: string;
      workspaceId: string;
      contentType: string;
      filename: string | null;
      disposition: "inline" | "attachment";
      expiresAt: number;
    }
  | { ok: false; reason: "missing" | "expired" | "invalid" };

export type VerifiedSignedUploadUrl =
  | { ok: true; uploadId: string; workspaceId: string; expiresAt: number }
  | { ok: false; reason: "missing" | "expired" | "invalid" };

function getSigningSecret(): string {
  const secret = process.env.MEDIA_URL_SECRET ?? process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (secret) return secret;

  if (process.env.NODE_ENV === "production") {
    throw new Error("MEDIA_URL_SECRET must be configured in production.");
  }

  return "dev-only-sermon-clipper-media-url-secret";
}

function expiresAtFromNow(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

function signPayload(payload: string): string {
  return createHmac("sha256", getSigningSecret()).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function mediaPayload(params: {
  key: string;
  workspaceId: string;
  expiresAt: string;
  contentType: string;
  filename: string;
  disposition: string;
}) {
  return [
    "media",
    params.key,
    params.workspaceId,
    params.expiresAt,
    params.contentType,
    params.filename,
    params.disposition,
  ].join("\n");
}

function uploadPayload(params: { uploadId: string; workspaceId: string; expiresAt: string }) {
  return ["upload", params.uploadId, params.workspaceId, params.expiresAt].join("\n");
}

export function createSignedMediaUrl({
  key,
  workspaceId,
  expiresInSeconds = DEFAULT_MEDIA_URL_TTL_SECONDS,
  contentType = "application/octet-stream",
  filename,
  disposition = "inline",
}: SignedMediaUrlInput): string {
  const expiresAt = String(expiresAtFromNow(expiresInSeconds));
  const params = new URLSearchParams({
    key,
    workspaceId,
    expiresAt,
    contentType,
    disposition,
  });
  if (filename) params.set("filename", filename);

  params.set(
    "signature",
    signPayload(
      mediaPayload({
        key,
        workspaceId,
        expiresAt,
        contentType,
        filename: filename ?? "",
        disposition,
      }),
    ),
  );

  return `/api/media/signed?${params.toString()}`;
}

export function verifySignedMediaUrl(searchParams: URLSearchParams): VerifiedSignedMediaUrl {
  const key = searchParams.get("key");
  const workspaceId = searchParams.get("workspaceId");
  const expiresAt = searchParams.get("expiresAt");
  const signature = searchParams.get("signature");
  const contentType = searchParams.get("contentType") ?? "application/octet-stream";
  const filename = searchParams.get("filename");
  const disposition = searchParams.get("disposition") === "attachment" ? "attachment" : "inline";

  if (!key || !workspaceId || !expiresAt || !signature) {
    return { ok: false, reason: "missing" };
  }

  const expiresAtNumber = Number(expiresAt);
  if (!Number.isInteger(expiresAtNumber)) {
    return { ok: false, reason: "invalid" };
  }

  if (expiresAtNumber <= Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "expired" };
  }

  const expected = signPayload(
    mediaPayload({
      key,
      workspaceId,
      expiresAt,
      contentType,
      filename: filename ?? "",
      disposition,
    }),
  );

  if (!safeEqual(signature, expected)) {
    return { ok: false, reason: "invalid" };
  }

  return { ok: true, key, workspaceId, contentType, filename, disposition, expiresAt: expiresAtNumber };
}

export function createSignedUploadUrl({
  uploadId,
  workspaceId,
  expiresInSeconds = DEFAULT_UPLOAD_URL_TTL_SECONDS,
}: SignedUploadUrlInput): string {
  const expiresAt = String(expiresAtFromNow(expiresInSeconds));
  const params = new URLSearchParams({ workspaceId, expiresAt });
  params.set("signature", signPayload(uploadPayload({ uploadId, workspaceId, expiresAt })));
  return `/api/uploads/${uploadId}?${params.toString()}`;
}

export function verifySignedUploadUrl(
  uploadId: string,
  searchParams: URLSearchParams,
): VerifiedSignedUploadUrl {
  const workspaceId = searchParams.get("workspaceId");
  const expiresAt = searchParams.get("expiresAt");
  const signature = searchParams.get("signature");

  if (!workspaceId || !expiresAt || !signature) {
    return { ok: false, reason: "missing" };
  }

  const expiresAtNumber = Number(expiresAt);
  if (!Number.isInteger(expiresAtNumber)) {
    return { ok: false, reason: "invalid" };
  }

  if (expiresAtNumber <= Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "expired" };
  }

  const expected = signPayload(uploadPayload({ uploadId, workspaceId, expiresAt }));
  if (!safeEqual(signature, expected)) {
    return { ok: false, reason: "invalid" };
  }

  return { ok: true, uploadId, workspaceId, expiresAt: expiresAtNumber };
}
