export type SmokeStatus = "ok" | "warning" | "fail";

export type SmokeCheck = {
  name: string;
  status: SmokeStatus;
  message: string;
};

export type SmokeResult = {
  status: SmokeStatus;
  checks: SmokeCheck[];
};

export type ProductionSmokeOptions = {
  baseUrl: string;
  timeoutMs?: number;
  expectProduction?: boolean;
  expectedCommitSha?: string;
  fetchImpl?: typeof fetch;
};

type SmokeFetchInit = RequestInit & { signal?: AbortSignal };

const REQUIRED_HEALTH_CHECKS = [
  "DATABASE_URL",
  "NEXT_PUBLIC_APP_URL",
  "MEDIA_URL_SECRET",
  "SENDGRID_API_KEY",
  "AUTH_EMAIL_FROM",
  "approval_notifications",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_STARTER",
  "STRIPE_PRICE_PRO",
  "WHISPER_MODEL_PATH",
  "ANTHROPIC_API_KEY",
  "STORAGE_PROVIDER",
  "storage",
  "database",
  "migrations",
  "worker_heartbeat",
];

function summarizeSmoke(checks: SmokeCheck[]): SmokeStatus {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "ok";
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/$/, "");
}

function checkBaseUrl(baseUrl: string, expectProduction: boolean): SmokeCheck {
  try {
    const url = new URL(baseUrl);
    if (expectProduction && url.protocol !== "https:") {
      return { name: "base-url", status: "fail", message: "Production smoke base URL must use HTTPS." };
    }
    return { name: "base-url", status: "ok", message: "Smoke base URL is valid." };
  } catch {
    return { name: "base-url", status: "fail", message: "Smoke base URL must be a valid URL." };
  }
}

function commitsMatch(actual: string, expected: string) {
  const normalizedActual = actual.trim().toLowerCase();
  const normalizedExpected = expected.trim().toLowerCase();
  return (
    normalizedActual.length > 0 &&
    normalizedExpected.length > 0 &&
    (normalizedActual.startsWith(normalizedExpected) || normalizedExpected.startsWith(normalizedActual))
  );
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: SmokeFetchInit,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readText(response: Response) {
  const text = await response.text();
  return text.slice(0, 10_000);
}

async function runCheck(name: string, check: () => Promise<SmokeCheck>): Promise<SmokeCheck> {
  try {
    return await check();
  } catch (error) {
    return {
      name,
      status: "fail",
      message: error instanceof Error ? error.message : "Smoke check failed.",
    };
  }
}

function healthCheckNames(checks: unknown[]) {
  return new Set(
    checks
      .map((check) => (check && typeof check === "object" && "name" in check ? check.name : null))
      .filter((name): name is string => typeof name === "string" && name.length > 0),
  );
}

function healthHasNonOkCheck(checks: unknown[]) {
  return checks.some((check) => {
    if (!check || typeof check !== "object" || !("status" in check)) return true;
    return check.status !== "ok";
  });
}

export async function runProductionSmoke(options: ProductionSmokeOptions): Promise<SmokeResult> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const expectProduction = options.expectProduction ?? true;
  const expectedCommitSha = options.expectedCommitSha?.trim();
  const baseUrlCheck = checkBaseUrl(baseUrl, expectProduction);
  if (baseUrlCheck.status === "fail") {
    return { status: "fail", checks: [baseUrlCheck] };
  }

  const checks = await Promise.all([
    Promise.resolve(baseUrlCheck),
    runCheck("health", async () => {
      const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/api/health`, { cache: "no-store" }, timeoutMs);
      const payload = (await response.json().catch(() => null)) as {
        status?: string;
        checks?: unknown[];
        deployment?: { commitSha?: string | null };
      } | null;
      if (!response.ok) {
        return {
          name: "health",
          status: "fail",
          message: `/api/health returned HTTP ${response.status}.`,
        };
      }
      if (!payload?.status || !Array.isArray(payload.checks)) {
        return { name: "health", status: "fail", message: "/api/health returned an invalid payload." };
      }
      if (payload.status === "fail") {
        return { name: "health", status: "fail", message: "Deployment readiness is failing." };
      }
      if (payload.status === "degraded") {
        return { name: "health", status: "warning", message: "Deployment readiness is degraded." };
      }
      const names = healthCheckNames(payload.checks);
      const missing = REQUIRED_HEALTH_CHECKS.filter((name) => !names.has(name));
      if (missing.length > 0) {
        return {
          name: "health",
          status: "fail",
          message: `/api/health is missing required readiness check(s): ${missing.join(", ")}.`,
        };
      }
      if (healthHasNonOkCheck(payload.checks)) {
        return {
          name: "health",
          status: "fail",
          message: "/api/health reported status ok but included a non-ok readiness check.",
        };
      }
      if (expectedCommitSha) {
        const actualCommitSha = payload.deployment?.commitSha;
        if (!actualCommitSha) {
          return { name: "health", status: "fail", message: "/api/health did not include deployment commit metadata." };
        }
        if (!commitsMatch(actualCommitSha, expectedCommitSha)) {
          return {
            name: "health",
            status: "fail",
            message: `/api/health commit ${actualCommitSha} does not match expected commit ${expectedCommitSha}.`,
          };
        }
      }
      return { name: "health", status: "ok", message: "Deployment readiness is ok." };
    }),
    runCheck("login", async () => {
      const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/login`, { cache: "no-store" }, timeoutMs);
      const html = await readText(response);
      if (!response.ok) {
        return { name: "login", status: "fail", message: `/login returned HTTP ${response.status}.` };
      }
      if (!html.includes("Sermon Clipper") || !html.includes("Email me a sign-in code")) {
        return { name: "login", status: "fail", message: "/login did not render the email OTP form." };
      }
      if (expectProduction && html.includes("Use development login")) {
        return { name: "login", status: "fail", message: "Development login is visible on production login." };
      }
      return { name: "login", status: "ok", message: "Login page renders email OTP form." };
    }),
    runCheck("protected-app", async () => {
      const response = await fetchWithTimeout(
        fetchImpl,
        `${baseUrl}/app`,
        { cache: "no-store", redirect: "manual" },
        timeoutMs,
      );
      const location = response.headers.get("location") ?? "";
      if (response.status < 300 || response.status >= 400) {
        return {
          name: "protected-app",
          status: "fail",
          message: `/app should redirect unauthenticated users, got HTTP ${response.status}.`,
        };
      }
      if (!location.includes("/login")) {
        return {
          name: "protected-app",
          status: "fail",
          message: `/app redirected somewhere other than login: ${location || "(missing location)"}.`,
        };
      }
      return { name: "protected-app", status: "ok", message: "/app redirects unauthenticated users." };
    }),
    runCheck("join-invalid", async () => {
      const response = await fetchWithTimeout(
        fetchImpl,
        `${baseUrl}/join/smoke-invalid-token`,
        { cache: "no-store" },
        timeoutMs,
      );
      const html = await readText(response);
      if (!response.ok) {
        return { name: "join-invalid", status: "fail", message: `/join invalid returned HTTP ${response.status}.` };
      }
      if (!html.includes("Invitation unavailable")) {
        return { name: "join-invalid", status: "fail", message: "Invalid join token did not show safe fallback UI." };
      }
      return { name: "join-invalid", status: "ok", message: "Invalid join token is handled safely." };
    }),
    runCheck("review-invalid", async () => {
      const response = await fetchWithTimeout(
        fetchImpl,
        `${baseUrl}/review/smoke-invalid-token`,
        { cache: "no-store" },
        timeoutMs,
      );
      const html = await readText(response);
      if (!response.ok) {
        return { name: "review-invalid", status: "fail", message: `/review invalid returned HTTP ${response.status}.` };
      }
      if (!html.includes("Review link unavailable")) {
        return { name: "review-invalid", status: "fail", message: "Invalid review token did not show safe fallback UI." };
      }
      return { name: "review-invalid", status: "ok", message: "Invalid review token is handled safely." };
    }),
    runCheck("signed-media-rejects-invalid", async () => {
      const response = await fetchWithTimeout(
        fetchImpl,
        `${baseUrl}/api/media/signed`,
        { cache: "no-store" },
        timeoutMs,
      );
      if (response.status !== 403) {
        return {
          name: "signed-media-rejects-invalid",
          status: "fail",
          message: `Unsigned media request returned HTTP ${response.status}, expected 403.`,
        };
      }
      return {
        name: "signed-media-rejects-invalid",
        status: "ok",
        message: "Unsigned media requests are rejected.",
      };
    }),
    runCheck("signed-upload-rejects-invalid", async () => {
      const response = await fetchWithTimeout(
        fetchImpl,
        `${baseUrl}/api/uploads/smoke-invalid-upload`,
        { method: "PUT", cache: "no-store" },
        timeoutMs,
      );
      if (response.status !== 403) {
        return {
          name: "signed-upload-rejects-invalid",
          status: "fail",
          message: `Unsigned upload request returned HTTP ${response.status}, expected 403.`,
        };
      }
      return {
        name: "signed-upload-rejects-invalid",
        status: "ok",
        message: "Unsigned upload requests are rejected.",
      };
    }),
    runCheck("storage-shim-rejects-unauthenticated", async () => {
      const response = await fetchWithTimeout(
        fetchImpl,
        `${baseUrl}/api/storage/thumbs/smoke-workspace/smoke.jpg`,
        { cache: "no-store", redirect: "manual" },
        timeoutMs,
      );
      if (response.status !== 401 && response.status !== 403) {
        return {
          name: "storage-shim-rejects-unauthenticated",
          status: "fail",
          message: `Unauthenticated storage shim request returned HTTP ${response.status}, expected 401 or 403.`,
        };
      }
      return {
        name: "storage-shim-rejects-unauthenticated",
        status: "ok",
        message: "Unauthenticated storage shim requests are rejected.",
      };
    }),
    runCheck("stripe-webhook-signature", async () => {
      const response = await fetchWithTimeout(
        fetchImpl,
        `${baseUrl}/api/stripe/webhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          cache: "no-store",
        },
        timeoutMs,
      );
      if (response.status === 503) {
        return {
          name: "stripe-webhook-signature",
          status: "fail",
          message: "Stripe webhook endpoint reports missing configuration.",
        };
      }
      if (response.status !== 400) {
        return {
          name: "stripe-webhook-signature",
          status: "fail",
          message: `Unsigned Stripe webhook returned HTTP ${response.status}, expected 400.`,
        };
      }
      return {
        name: "stripe-webhook-signature",
        status: "ok",
        message: "Stripe webhook rejects unsigned payloads.",
      };
    }),
  ]);

  return { status: summarizeSmoke(checks), checks };
}
