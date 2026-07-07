import { describe, expect, it } from "vitest";
import { runProductionSmoke } from "@/lib/deployment/production-smoke";

function response(body: string | object, init?: ResponseInit) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), init);
}

function fetchFor(routes: Record<string, Response>): typeof fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) return response("not found", { status: 404 });
    return route.clone();
  };
}

describe("production smoke checks", () => {
  it("passes when deployed critical unauthenticated surfaces behave correctly", async () => {
    const result = await runProductionSmoke({
      baseUrl: "https://clips.example.com",
      fetchImpl: fetchFor({
        "/api/health": response({ status: "ok", checks: [] }, { status: 200 }),
        "/login": response("Sermon Clipper Email me a sign-in code", { status: 200 }),
        "/app": response("", { status: 307, headers: { location: "/login" } }),
        "/join/smoke-invalid-token": response("Invitation unavailable", { status: 200 }),
        "/api/media/signed": response({ error: { code: "PERMISSION_DENIED" } }, { status: 403 }),
        "/api/stripe/webhook": response({ error: { code: "STRIPE_WEBHOOK_INVALID" } }, { status: 400 }),
      }),
    });

    expect(result.status).toBe("ok");
    expect(result.checks.every((check) => check.status === "ok")).toBe(true);
  });

  it("passes when expected commit matches health deployment metadata", async () => {
    const result = await runProductionSmoke({
      baseUrl: "https://clips.example.com",
      expectedCommitSha: "abc1234",
      fetchImpl: fetchFor({
        "/api/health": response(
          { status: "ok", deployment: { commitSha: "abc1234def5678" }, checks: [] },
          { status: 200 },
        ),
        "/login": response("Sermon Clipper Email me a sign-in code", { status: 200 }),
        "/app": response("", { status: 307, headers: { location: "/login" } }),
        "/join/smoke-invalid-token": response("Invitation unavailable", { status: 200 }),
        "/api/media/signed": response({ error: { code: "PERMISSION_DENIED" } }, { status: 403 }),
        "/api/stripe/webhook": response({ error: { code: "STRIPE_WEBHOOK_INVALID" } }, { status: 400 }),
      }),
    });

    expect(result.status).toBe("ok");
  });

  it("fails when expected commit does not match health deployment metadata", async () => {
    const result = await runProductionSmoke({
      baseUrl: "https://clips.example.com",
      expectedCommitSha: "abc1234",
      fetchImpl: fetchFor({
        "/api/health": response(
          { status: "ok", deployment: { commitSha: "fffffff" }, checks: [] },
          { status: 200 },
        ),
        "/login": response("Sermon Clipper Email me a sign-in code", { status: 200 }),
        "/app": response("", { status: 307, headers: { location: "/login" } }),
        "/join/smoke-invalid-token": response("Invitation unavailable", { status: 200 }),
        "/api/media/signed": response({ error: { code: "PERMISSION_DENIED" } }, { status: 403 }),
        "/api/stripe/webhook": response({ error: { code: "STRIPE_WEBHOOK_INVALID" } }, { status: 400 }),
      }),
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "health", status: "fail" })]),
    );
  });

  it("warns when health is degraded", async () => {
    const result = await runProductionSmoke({
      baseUrl: "https://clips.example.com",
      fetchImpl: fetchFor({
        "/api/health": response({ status: "degraded", checks: [] }, { status: 200 }),
        "/login": response("Sermon Clipper Email me a sign-in code", { status: 200 }),
        "/app": response("", { status: 307, headers: { location: "/login" } }),
        "/join/smoke-invalid-token": response("Invitation unavailable", { status: 200 }),
        "/api/media/signed": response({ error: { code: "PERMISSION_DENIED" } }, { status: 403 }),
        "/api/stripe/webhook": response({ error: { code: "STRIPE_WEBHOOK_INVALID" } }, { status: 400 }),
      }),
    });

    expect(result.status).toBe("warning");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "health", status: "warning" })]),
    );
  });

  it("fails when development login is exposed in production", async () => {
    const result = await runProductionSmoke({
      baseUrl: "https://clips.example.com",
      fetchImpl: fetchFor({
        "/api/health": response({ status: "ok", checks: [] }, { status: 200 }),
        "/login": response("Sermon Clipper Email me a sign-in code Use development login", { status: 200 }),
        "/app": response("", { status: 307, headers: { location: "/login" } }),
        "/join/smoke-invalid-token": response("Invitation unavailable", { status: 200 }),
        "/api/media/signed": response({ error: { code: "PERMISSION_DENIED" } }, { status: 403 }),
        "/api/stripe/webhook": response({ error: { code: "STRIPE_WEBHOOK_INVALID" } }, { status: 400 }),
      }),
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "login", status: "fail" })]),
    );
  });

  it("fails when Stripe webhook configuration is missing", async () => {
    const result = await runProductionSmoke({
      baseUrl: "https://clips.example.com",
      fetchImpl: fetchFor({
        "/api/health": response({ status: "ok", checks: [] }, { status: 200 }),
        "/login": response("Sermon Clipper Email me a sign-in code", { status: 200 }),
        "/app": response("", { status: 307, headers: { location: "/login" } }),
        "/join/smoke-invalid-token": response("Invitation unavailable", { status: 200 }),
        "/api/media/signed": response({ error: { code: "PERMISSION_DENIED" } }, { status: 403 }),
        "/api/stripe/webhook": response({ error: { code: "STRIPE_WEBHOOK_INVALID" } }, { status: 503 }),
      }),
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "stripe-webhook-signature", status: "fail" })]),
    );
  });
});
