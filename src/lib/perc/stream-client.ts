import { z } from "zod";

/**
 * Minimal Cloudflare Stream client for the isolated PERC experiment (plan item 20).
 * No production code calls it. It never logs the token or a stream key.
 * Endpoints follow https://developers.cloudflare.com/stream/ (checked 2026-10-16).
 */
export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

export class StreamApiError extends Error {
  constructor(readonly status: number, readonly codes: number[], message: string) {
    super(message); this.name = "StreamApiError";
  }
}

const envelope = z.object({ success: z.boolean(), errors: z.array(z.object({ code: z.number(), message: z.string() })).default([]),
  result: z.unknown().optional() }).passthrough();

const liveInputSchema = z.object({ uid: z.string().min(1),
  rtmps: z.object({ url: z.string().url(), streamKey: z.string().min(1) }),
  recording: z.object({ mode: z.string() }).passthrough() }).passthrough();
export type LiveInput = z.infer<typeof liveInputSchema>;

const videoSchema = z.object({ uid: z.string().min(1), readyToStream: z.boolean().optional(),
  status: z.object({ state: z.string() }).passthrough(), duration: z.number().optional(),
  input: z.object({ width: z.number().optional(), height: z.number().optional() }).passthrough().optional(),
  created: z.string().optional() }).passthrough();
export type StreamVideo = z.infer<typeof videoSchema>;

const downloadSchema = z.object({ status: z.string().nullable().optional(), url: z.string().url().optional(),
  percentComplete: z.number().optional() }).passthrough();
const downloadsSchema = z.object({ default: downloadSchema.optional() }).passthrough();
export type StreamDownloads = z.infer<typeof downloadsSchema>;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) =>
  Promise<{ status: number; json(): Promise<unknown> }>;

export class StreamClient {
  constructor(private readonly options: { accountId: string; apiToken: string; fetch: FetchLike; base?: string }) {
    if (!/^[a-f0-9]{32}$/.test(options.accountId)) throw new Error("PERC_ACCOUNT_ID_INVALID");
    if (options.apiToken.trim().length < 20) throw new Error("PERC_API_TOKEN_INVALID");
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; result: unknown }> {
    const response = await this.options.fetch(`${this.options.base ?? CLOUDFLARE_API_BASE}${path}`, { method,
      headers: { Authorization: `Bearer ${this.options.apiToken}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const payload = await response.json().catch(() => null);
    // Observed 2026-10-16: video DELETE returns HTTP 200 without the usual JSON envelope.
    if (method === "DELETE" && response.status >= 200 && response.status < 300 && payload === null) return { status: response.status, result: null };
    const parsed = envelope.safeParse(payload);
    if (response.status >= 400 || !parsed.success || !parsed.data.success) {
      const codes = parsed.success ? parsed.data.errors.map(error => error.code) : [];
      // Provider messages can echo request details. Keep only status and numeric codes.
      throw new StreamApiError(response.status, codes, `Cloudflare ${method} ${path.replace(/[a-f0-9]{32}/g, ":id")} failed with HTTP ${response.status}.`);
    }
    return { status: response.status, result: parsed.data.result };
  }

  private account(path: string) { return `/accounts/${this.options.accountId}${path}`; }

  async verifyToken(): Promise<{ status: string }> {
    const { result } = await this.call("GET", "/user/tokens/verify");
    return z.object({ status: z.string() }).passthrough().parse(result);
  }

  async createLiveInput(input: { name: string; deleteRecordingAfterDays: number }): Promise<LiveInput> {
    const { result } = await this.call("POST", this.account("/stream/live_inputs"), {
      meta: { name: input.name }, recording: { mode: "automatic" },
      // Synthetic fixture only. Retention is a safety net if explicit deletion fails.
      requireSignedURLs: false, deleteRecordingAfterDays: input.deleteRecordingAfterDays });
    return liveInputSchema.parse(result);
  }

  async listLiveInputVideos(liveInputId: string): Promise<StreamVideo[]> {
    const { result } = await this.call("GET", this.account(`/stream/live_inputs/${liveInputId}/videos`));
    return z.array(videoSchema).parse(result ?? []);
  }

  async getVideo(videoId: string): Promise<StreamVideo> {
    return videoSchema.parse((await this.call("GET", this.account(`/stream/${videoId}`))).result);
  }

  async createDownload(videoId: string): Promise<StreamDownloads> {
    return downloadsSchema.parse((await this.call("POST", this.account(`/stream/${videoId}/downloads`))).result ?? {});
  }

  async getDownloads(videoId: string): Promise<StreamDownloads> {
    return downloadsSchema.parse((await this.call("GET", this.account(`/stream/${videoId}/downloads`))).result ?? {});
  }

  async deleteVideo(videoId: string): Promise<void> { await this.call("DELETE", this.account(`/stream/${videoId}`)); }
  async deleteLiveInput(liveInputId: string): Promise<void> { await this.call("DELETE", this.account(`/stream/live_inputs/${liveInputId}`)); }

  /** Resolves true when the resource reports HTTP 404. Other failures propagate. */
  async isAbsent(kind: "video" | "liveInput" | "downloads", id: string): Promise<boolean> {
    const path = kind === "video" ? `/stream/${id}` : kind === "liveInput" ? `/stream/live_inputs/${id}` : `/stream/${id}/downloads`;
    try { await this.call("GET", this.account(path)); return false; } catch (error) {
      if (error instanceof StreamApiError && error.status === 404) return true;
      throw error;
    }
  }
}
