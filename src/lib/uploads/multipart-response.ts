import { apiError } from "@/lib/api/response";

export function multipartErrorResponse(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code === "MULTIPART_UPLOAD_NOT_FOUND") return apiError("NOT_FOUND", "This upload does not exist.", { status: 404 });
  if (code === "MULTIPART_UPLOAD_EXPIRED") return apiError("UPLOAD_EXPIRED", "This upload expired. Start a new upload.", { status: 410 });
  if (code === "MULTIPART_PLAN_LIMIT_EXCEEDED") return apiError("PLAN_LIMIT_EXCEEDED", "This file exceeds your upload limit.", { status: 413 });
  if (code === "MULTIPART_INCOMPLETE") return apiError("UPLOAD_INCOMPLETE", "Upload all file parts before completion.", { status: 409 });
  if (["MULTIPART_INVALID_PART_NUMBER", "MULTIPART_INVALID_URL_EXPIRY"].includes(code)) {
    return apiError("INVALID_UPLOAD_REQUEST", "This upload request is invalid.");
  }
  if (["MULTIPART_UPLOAD_UNCERTAIN", "MULTIPART_UPLOAD_STATE_CHANGED", "MULTIPART_UPLOAD_NOT_STARTABLE",
    "MULTIPART_UPLOAD_NOT_WRITABLE", "MULTIPART_UPLOAD_NOT_COMPLETABLE", "MULTIPART_UPLOAD_NOT_ABORTABLE",
    "MULTIPART_COMPLETED_SOURCE_REMOVED", "MULTIPART_UPLOAD_IDENTITY_CONFLICT",
    "MULTIPART_CANCELLATION_NOT_RECOVERABLE", "MULTIPART_CANCELLATION_NOT_CONFIRMED",
    "MULTIPART_INITIATION_NOT_RECOVERABLE", "MULTIPART_INITIATION_NOT_CONFIRMED",
    "MULTIPART_INITIATION_AMBIGUOUS", "MULTIPART_INITIATION_OBJECT_PRESENT", "MULTIPART_COMPLETION_NOT_CONFIRMED", "MULTIPART_COMPLETION_NOT_RECOVERABLE", "MULTIPART_COMPLETED_OBJECT_MISMATCH"].includes(code)) {
    return apiError("UPLOAD_REVIEW_REQUIRED", "Check the upload status before another attempt.", { status: 409 });
  }
  // Provider messages can contain signed URLs or request details. Never expose them to the browser.
  return apiError("STORAGE_UNAVAILABLE", "Upload storage is unavailable. Try again later.", { status: 503 });
}
