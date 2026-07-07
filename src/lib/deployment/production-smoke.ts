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
  fetchImpl?: typeof fetch;
};

type SmokeFetchInit = RequestInit & { signal?: AbortSignal };

function summarizeSmoke(checks: SmokeCheck[]): SmokeStatus {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "ok";
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/$/, "");
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

export async function runProductionSmoke(options: ProductionSmokeOptions): Promise<SmokeResult> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const expectProduction = options.expectProduction ?? true;

  const checks = await Promise.all([
    runCheck("health", async () => {
      const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/api/health`, { cache: "no-store" }, timeoutMs);
      const payload = (await response.json().catch(() => null)) as { status?: string; checks?: unknown[] } | null;
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
