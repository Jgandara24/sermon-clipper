/**
 * Table-driven authorization matrix over every API route handler.
 *
 * For each session-authenticated route the matrix asserts:
 *   (a) unauthenticated request -> 401
 *   (b) every role WITHOUT the required permission -> 403
 *   (c) an authorized member of workspace A probing a workspace-B resource -> 403/404, never 2xx
 *
 * Special-surface routes (public health, webhooks, HMAC-signed URLs) are asserted against their
 * own contracts below the matrix. A completeness guard walks src/app/api at test time and fails
 * if a route file (or an exported HTTP method) exists that isn't represented in the ROUTES table,
 * so adding a route without a matrix row breaks this test.
 *
 * Adding a route = one entry in ROUTES (import the module, pick auth kind, optionally a
 * foreignParams factory pointing at the workspace-B fixture that route serves).
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemberStatus, PrismaClient, WorkspaceRole } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// vi.mock factories are hoisted above imports, so the mutable cookie state must be hoisted too.
// The cookie name is hard-coded here (factories can't touch imported bindings); a guard test
// below pins it against AUTH_SESSION_COOKIE so a rename can't silently defeat the mock.
const cookieState = vi.hoisted(() => ({ sessionToken: null as string | null }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieState.sessionToken && name === "sermon_clipper_session"
        ? { name, value: cookieState.sessionToken }
        : undefined,
  }),
}));

import { AUTH_SESSION_COOKIE, createSessionToken, hashSecret } from "@/lib/auth/email-otp";
import { hasWorkspacePermission, type WorkspacePermission } from "@/lib/authorization";
import { createSignedMediaUrl, createSignedUploadUrl } from "@/lib/media/signed-url";

import * as billingCheckoutRoute from "@/app/api/billing/checkout/route";
import * as billingPortalRoute from "@/app/api/billing/portal/route";
import * as clipApprovalRoute from "@/app/api/clips/[id]/approval/route";
import * as clipEditStateRoute from "@/app/api/clips/[id]/edit-state/route";
import * as clipExportsRoute from "@/app/api/clips/[id]/exports/route";
import * as clipRoute from "@/app/api/clips/[id]/route";
import * as exportDownloadRoute from "@/app/api/exports/[id]/download/route";
import * as exportResignRoute from "@/app/api/exports/[id]/resign/route";
import * as exportRetryRoute from "@/app/api/exports/[id]/retry/route";
import * as exportRoute from "@/app/api/exports/[id]/route";
import * as exportsRoute from "@/app/api/exports/route";
import * as healthRoute from "@/app/api/health/route";
import * as pulpitWebhookRoute from "@/app/api/integrations/pulpit-engine/webhook/route";
import * as mediaSignedRoute from "@/app/api/media/signed/route";
import * as projectCancelRoute from "@/app/api/projects/[id]/cancel/route";
import * as projectClipsRoute from "@/app/api/projects/[id]/clips/route";
import * as projectRoute from "@/app/api/projects/[id]/route";
import * as storageRoute from "@/app/api/storage/[...key]/route";
import * as stripeWebhookRoute from "@/app/api/stripe/webhook/route";
import * as uploadCompleteRoute from "@/app/api/uploads/[uploadId]/complete/route";
import * as uploadPutRoute from "@/app/api/uploads/[uploadId]/route";
import * as uploadPresignRoute from "@/app/api/uploads/presign/route";
import * as videoSourceRoute from "@/app/api/videos/[id]/source/route";
import * as videoSrtRoute from "@/app/api/videos/[id]/srt/route";
import * as videoTranscriptRoute from "@/app/api/videos/[id]/transcript/route";

const prisma = new PrismaClient();

const ALL_ROLES = [
  WorkspaceRole.OWNER,
  WorkspaceRole.ADMIN,
  WorkspaceRole.EDITOR,
  WorkspaceRole.APPROVER,
  WorkspaceRole.VIEWER,
] as const;

// Handlers that end in next/navigation redirect() are inferred as possibly returning undefined.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteHandler = (request: Request, context: any) => Promise<Response | undefined>;

type RouteAuth =
  | {
      kind: "session";
      /** Permission passed to requireApiWorkspace; undefined = any active member. */
      permission?: WorkspacePermission;
      /** Route params pointing at a workspace-B resource — enables the cross-tenant probe. */
      foreignParams?: () => Record<string, string | string[]>;
      /** Params for cases that never reach the resource (auth is checked first). */
      params?: () => Record<string, string | string[]>;
    }
  | { kind: "signed-url" }
  | { kind: "public" }
  | { kind: "stripe-webhook" }
  | { kind: "not-implemented" };

type RouteSpec = {
  /** Path of the route file relative to src/app/api — checked by the completeness guard. */
  file: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  module: Record<string, unknown>;
  handler: RouteHandler;
  auth: RouteAuth;
};

// Fixture state, populated in beforeAll. Foreign* are workspace-B resources used to prove a
// workspace-A session can't reach another tenant's rows.
const sessionTokens = {} as Record<WorkspaceRole, string>;
const fixtures = {
  workspaceAId: "",
  workspaceBId: "",
  foreignVideoId: "",
  foreignProjectId: "",
  foreignClipId: "",
  foreignExportJobId: "",
};

const ROUTES: RouteSpec[] = [
  {
    file: "billing/checkout/route.ts",
    method: "POST",
    module: billingCheckoutRoute,
    handler: billingCheckoutRoute.POST,
    auth: { kind: "session", permission: "MANAGE_BILLING" },
  },
  {
    file: "billing/portal/route.ts",
    method: "POST",
    module: billingPortalRoute,
    handler: billingPortalRoute.POST,
    auth: { kind: "session", permission: "MANAGE_BILLING" },
  },
  {
    file: "clips/[id]/approval/route.ts",
    method: "POST",
    module: clipApprovalRoute,
    handler: clipApprovalRoute.POST,
    auth: {
      kind: "session",
      permission: "REQUEST_APPROVAL",
      foreignParams: () => ({ id: fixtures.foreignClipId }),
    },
  },
  {
    file: "clips/[id]/edit-state/route.ts",
    method: "GET",
    module: clipEditStateRoute,
    handler: clipEditStateRoute.GET,
    auth: { kind: "session", foreignParams: () => ({ id: fixtures.foreignClipId }) },
  },
  {
    file: "clips/[id]/edit-state/route.ts",
    method: "PUT",
    module: clipEditStateRoute,
    handler: clipEditStateRoute.PUT,
    auth: {
      kind: "session",
      permission: "EDIT_CLIP",
      foreignParams: () => ({ id: fixtures.foreignClipId }),
    },
  },
  {
    file: "clips/[id]/exports/route.ts",
    method: "POST",
    module: clipExportsRoute,
    handler: clipExportsRoute.POST,
    auth: {
      kind: "session",
      permission: "EXPORT_CLIP",
      foreignParams: () => ({ id: fixtures.foreignClipId }),
    },
  },
  {
    file: "clips/[id]/route.ts",
    method: "PATCH",
    module: clipRoute,
    handler: clipRoute.PATCH,
    auth: {
      kind: "session",
      permission: "EDIT_CLIP",
      foreignParams: () => ({ id: fixtures.foreignClipId }),
    },
  },
  {
    file: "exports/[id]/download/route.ts",
    method: "GET",
    module: exportDownloadRoute,
    handler: exportDownloadRoute.GET,
    auth: { kind: "session", foreignParams: () => ({ id: fixtures.foreignExportJobId }) },
  },
  {
    file: "exports/[id]/resign/route.ts",
    method: "POST",
    module: exportResignRoute,
    handler: exportResignRoute.POST,
    auth: {
      kind: "session",
      permission: "EXPORT_CLIP",
      foreignParams: () => ({ id: fixtures.foreignExportJobId }),
    },
  },
  {
    file: "exports/[id]/retry/route.ts",
    method: "POST",
    module: exportRetryRoute,
    handler: exportRetryRoute.POST,
    auth: {
      kind: "session",
      permission: "EXPORT_CLIP",
      foreignParams: () => ({ id: fixtures.foreignExportJobId }),
    },
  },
  {
    file: "exports/[id]/route.ts",
    method: "GET",
    module: exportRoute,
    handler: exportRoute.GET,
    auth: { kind: "session", foreignParams: () => ({ id: fixtures.foreignExportJobId }) },
  },
  {
    file: "exports/route.ts",
    method: "GET",
    module: exportsRoute,
    handler: exportsRoute.GET,
    auth: { kind: "session" },
  },
  {
    file: "health/route.ts",
    method: "GET",
    module: healthRoute,
    handler: healthRoute.GET,
    auth: { kind: "public" },
  },
  {
    file: "integrations/pulpit-engine/webhook/route.ts",
    method: "POST",
    module: pulpitWebhookRoute,
    handler: pulpitWebhookRoute.POST,
    auth: { kind: "not-implemented" },
  },
  {
    file: "media/signed/route.ts",
    method: "GET",
    module: mediaSignedRoute,
    handler: mediaSignedRoute.GET,
    auth: { kind: "signed-url" },
  },
  {
    file: "projects/[id]/cancel/route.ts",
    method: "POST",
    module: projectCancelRoute,
    handler: projectCancelRoute.POST,
    auth: {
      kind: "session",
      permission: "CANCEL_PROJECT",
      foreignParams: () => ({ id: fixtures.foreignProjectId }),
    },
  },
  {
    file: "projects/[id]/clips/route.ts",
    method: "GET",
    module: projectClipsRoute,
    handler: projectClipsRoute.GET,
    auth: { kind: "session", foreignParams: () => ({ id: fixtures.foreignProjectId }) },
  },
  {
    file: "projects/[id]/route.ts",
    method: "GET",
    module: projectRoute,
    handler: projectRoute.GET,
    auth: { kind: "session", foreignParams: () => ({ id: fixtures.foreignProjectId }) },
  },
  {
    file: "storage/[...key]/route.ts",
    method: "GET",
    module: storageRoute,
    handler: storageRoute.GET,
    auth: {
      kind: "session",
      // A thumbnail key under workspace B's prefix: the route must refuse to sign it for A.
      foreignParams: () => ({ key: ["thumbs", fixtures.workspaceBId, "thumb.jpg"] }),
    },
  },
  {
    file: "stripe/webhook/route.ts",
    method: "POST",
    module: stripeWebhookRoute,
    handler: stripeWebhookRoute.POST,
    auth: { kind: "stripe-webhook" },
  },
  {
    file: "uploads/[uploadId]/complete/route.ts",
    method: "POST",
    module: uploadCompleteRoute,
    handler: uploadCompleteRoute.POST,
    // uploadId is not a tenant-owned row (temp storage is prefixed by the CALLER's workspace),
    // so there is no cross-tenant probe for this route.
    auth: {
      kind: "session",
      permission: "IMPORT_MEDIA",
      params: () => ({ uploadId: "authz-matrix-upload" }),
    },
  },
  {
    file: "uploads/[uploadId]/route.ts",
    method: "PUT",
    module: uploadPutRoute,
    handler: uploadPutRoute.PUT,
    auth: { kind: "signed-url" },
  },
  {
    file: "uploads/presign/route.ts",
    method: "POST",
    module: uploadPresignRoute,
    handler: uploadPresignRoute.POST,
    auth: { kind: "session", permission: "IMPORT_MEDIA" },
  },
  {
    file: "videos/[id]/source/route.ts",
    method: "GET",
    module: videoSourceRoute,
    handler: videoSourceRoute.GET,
    auth: { kind: "session", foreignParams: () => ({ id: fixtures.foreignVideoId }) },
  },
  {
    file: "videos/[id]/srt/route.ts",
    method: "POST",
    module: videoSrtRoute,
    handler: videoSrtRoute.POST,
    auth: {
      kind: "session",
      permission: "EDIT_CLIP",
      foreignParams: () => ({ id: fixtures.foreignVideoId }),
    },
  },
  {
    file: "videos/[id]/transcript/route.ts",
    method: "GET",
    module: videoTranscriptRoute,
    handler: videoTranscriptRoute.GET,
    auth: { kind: "session", foreignParams: () => ({ id: fixtures.foreignVideoId }) },
  },
];

const workspaceIdsToDelete: string[] = [];
const userEmailsToDelete: string[] = [];
const originalEnv = { ...process.env };

function uniqueEmail(label: string) {
  const email = `authz-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  userEmailsToDelete.push(email);
  return email;
}

async function createUserWithSession(label: string) {
  const user = await prisma.user.create({ data: { email: uniqueEmail(label) } });
  const token = createSessionToken();
  await prisma.authSession.create({
    data: {
      userId: user.id,
      tokenHash: hashSecret(token),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return { user, token };
}

beforeAll(async () => {
  // Dummy Stripe config so the webhook route exercises its signature check (400) instead of
  // short-circuiting on missing configuration (503). Never used for a real API call here.
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_authz_matrix_test_secret";
  process.env.STRIPE_SECRET_KEY = "sk_test_authz_matrix_dummy";

  // Workspace A: one member per role, each with a real hashed-token AuthSession.
  const owner = await createUserWithSession("owner");
  sessionTokens[WorkspaceRole.OWNER] = owner.token;
  const workspaceA = await prisma.workspace.create({
    data: {
      name: "Authz Matrix Church A",
      ownerId: owner.user.id,
      members: {
        create: { userId: owner.user.id, role: WorkspaceRole.OWNER, status: MemberStatus.ACTIVE },
      },
    },
  });
  workspaceIdsToDelete.push(workspaceA.id);
  fixtures.workspaceAId = workspaceA.id;

  for (const role of ALL_ROLES) {
    if (role === WorkspaceRole.OWNER) continue;
    const member = await createUserWithSession(role.toLowerCase());
    sessionTokens[role] = member.token;
    await prisma.workspaceMember.create({
      data: {
        workspaceId: workspaceA.id,
        userId: member.user.id,
        role,
        status: MemberStatus.ACTIVE,
      },
    });
  }

  // Workspace B: a foreign tenant owning one of each resource the routes can address by id.
  const ownerB = await prisma.user.create({ data: { email: uniqueEmail("owner-b") } });
  const workspaceB = await prisma.workspace.create({
    data: {
      name: "Authz Matrix Church B",
      ownerId: ownerB.id,
      members: {
        create: { userId: ownerB.id, role: WorkspaceRole.OWNER, status: MemberStatus.ACTIVE },
      },
    },
  });
  workspaceIdsToDelete.push(workspaceB.id);
  fixtures.workspaceBId = workspaceB.id;

  const videoB = await prisma.sourceVideo.create({
    data: {
      workspaceId: workspaceB.id,
      origin: "UPLOAD",
      filename: "foreign.mp4",
      storageKey: `src/${workspaceB.id}/foreign.mp4`,
      language: "en",
    },
  });
  fixtures.foreignVideoId = videoB.id;

  const projectB = await prisma.project.create({
    data: { workspaceId: workspaceB.id, name: "Foreign Project", sourceVideoId: videoB.id },
  });
  fixtures.foreignProjectId = projectB.id;

  const clipB = await prisma.generatedClip.create({
    data: {
      workspaceId: workspaceB.id,
      projectId: projectB.id,
      rank: 1,
      startMs: 0,
      endMs: 30_000,
      title: "Foreign Clip",
      summary: "A clip belonging to workspace B.",
    },
  });
  fixtures.foreignClipId = clipB.id;

  const exportJobB = await prisma.exportJob.create({
    data: {
      clipId: clipB.id,
      workspaceId: workspaceB.id,
      filename: "foreign-export.mp4",
      idempotencyKey: `authz-matrix-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  });
  fixtures.foreignExportJobId = exportJobB.id;
});

afterAll(async () => {
  process.env = { ...originalEnv };
  if (workspaceIdsToDelete.length > 0) {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIdsToDelete } } });
  }
  if (userEmailsToDelete.length > 0) {
    await prisma.user.deleteMany({ where: { email: { in: userEmailsToDelete } } });
  }
  await prisma.$disconnect();
});

function routeLabel(spec: RouteSpec) {
  return `${spec.method} api/${spec.file.replace(/\/route\.ts$/, "")}`;
}

function buildRequest(spec: RouteSpec, url = `http://test.local/api/${spec.file.replace(/\/route\.ts$/, "")}`) {
  const hasBody = spec.method !== "GET" && spec.method !== "HEAD";
  return new Request(url, {
    method: spec.method,
    ...(hasBody
      ? {
          body: "{}",
          headers: { "content-type": "application/json" },
          // Node's undici requires duplex for request bodies; not in TS's RequestInit yet.
          duplex: "half",
        }
      : {}),
  } as RequestInit);
}

async function callRoute(
  spec: RouteSpec,
  sessionToken: string | null,
  params?: Record<string, string | string[]>,
): Promise<Response> {
  cookieState.sessionToken = sessionToken;
  try {
    const response = await spec.handler(buildRequest(spec), { params: Promise.resolve(params ?? {}) });
    if (!response) {
      throw new Error(`${routeLabel(spec)} returned no Response (redirected?)`);
    }
    return response;
  } finally {
    cookieState.sessionToken = null;
  }
}

const sessionRoutes = ROUTES.filter(
  (spec): spec is RouteSpec & { auth: Extract<RouteAuth, { kind: "session" }> } =>
    spec.auth.kind === "session",
);

describe("route authorization matrix", () => {
  it("mocks the exact cookie the auth layer reads", () => {
    expect(AUTH_SESSION_COOKIE).toBe("sermon_clipper_session");
  });

  describe("completeness guard: every route file and exported method has a matrix row", () => {
    const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/app/api");

    function discoverRouteFiles(dir: string, prefix = ""): string[] {
      const found: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          found.push(...discoverRouteFiles(path.join(dir, entry.name), rel));
        } else if (entry.name === "route.ts") {
          found.push(rel);
        }
      }
      return found.sort();
    }

    it("covers every route.ts under src/app/api", () => {
      const discovered = discoverRouteFiles(apiDir);
      const covered = [...new Set(ROUTES.map((spec) => spec.file))].sort();
      expect(covered).toEqual(discovered);
    });

    it("covers every HTTP method each route module exports", () => {
      const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
      for (const file of new Set(ROUTES.map((spec) => spec.file))) {
        const rows = ROUTES.filter((spec) => spec.file === file);
        const exported = Object.keys(rows[0].module)
          .filter((key) => HTTP_METHODS.includes(key))
          .sort();
        const tabled = [...new Set(rows.map((spec) => spec.method))].sort();
        expect(tabled, `methods for ${file}`).toEqual(exported);
      }
    });
  });

  describe("unauthenticated requests are rejected with 401", () => {
    for (const spec of sessionRoutes) {
      it(routeLabel(spec), async () => {
        const response = await callRoute(spec, null, spec.auth.foreignParams?.() ?? spec.auth.params?.());
        expect(response.status).toBe(401);
      });
    }
  });

  describe("roles without the required permission are rejected with 403", () => {
    for (const spec of sessionRoutes) {
      const permission = spec.auth.permission;
      if (!permission) continue;
      const deniedRoles = ALL_ROLES.filter((role) => !hasWorkspacePermission(role, permission));
      for (const role of deniedRoles) {
        it(`${routeLabel(spec)} denies ${role} (${permission})`, async () => {
          const response = await callRoute(
            spec,
            sessionTokens[role],
            spec.auth.foreignParams?.() ?? spec.auth.params?.(),
          );
          expect(response.status).toBe(403);
          const body = (await response.json()) as { error?: { code?: string } };
          expect(body.error?.code).toBe("PERMISSION_DENIED");
        });
      }
    }
  });

  describe("cross-tenant probes: workspace-A member requesting a workspace-B resource", () => {
    for (const spec of sessionRoutes) {
      const foreignParams = spec.auth.foreignParams;
      if (!foreignParams) continue;
      it(`${routeLabel(spec)} does not expose workspace B's resource`, async () => {
        // OWNER holds every permission, so any rejection here is tenant scoping, not RBAC.
        const response = await callRoute(spec, sessionTokens[WorkspaceRole.OWNER], foreignParams());
        expect([403, 404]).toContain(response.status);
        const body = (await response.json()) as Record<string, unknown>;
        expect(body.error).toBeTruthy();
        expect(body.data).toBeUndefined();
      });
    }
  });

  describe("special-surface routes", () => {
    it("GET api/health is public and reports readiness (200 or 503, no auth involved)", async () => {
      cookieState.sessionToken = null;
      const response = await healthRoute.GET();
      expect([200, 503]).toContain(response.status);
      const body = (await response.json()) as { service?: string };
      expect(body.service).toBe("sermon-clipper");
    });

    it("POST api/integrations/pulpit-engine/webhook is not implemented (501)", async () => {
      const response = await pulpitWebhookRoute.POST();
      expect(response.status).toBe(501);
    });

    it("POST api/stripe/webhook without a stripe-signature header is rejected (4xx)", async () => {
      const response = await stripeWebhookRoute.POST(
        new Request("http://test.local/api/stripe/webhook", {
          method: "POST",
          body: "{}",
          duplex: "half",
        } as RequestInit),
      );
      expect(response.status).toBe(400);
    });

    it("POST api/stripe/webhook with a forged stripe-signature header is rejected (4xx)", async () => {
      const response = await stripeWebhookRoute.POST(
        new Request("http://test.local/api/stripe/webhook", {
          method: "POST",
          body: "{}",
          headers: { "stripe-signature": "t=1,v1=deadbeef" },
          duplex: "half",
        } as RequestInit),
      );
      expect(response.status).toBe(400);
    });

    it("GET api/media/signed without a signature is rejected (403)", async () => {
      const response = await mediaSignedRoute.GET(
        new Request("http://test.local/api/media/signed?key=fixtures/foo.mp4"),
      );
      expect(response.status).toBe(403);
    });

    it("GET api/media/signed with a tampered signature is rejected (403)", async () => {
      const signedPath = createSignedMediaUrl({
        key: `src/${fixtures.workspaceBId}/foreign.mp4`,
        workspaceId: fixtures.workspaceBId,
        contentType: "video/mp4",
      });
      const url = new URL(`http://test.local${signedPath}`);
      const signature = url.searchParams.get("signature") ?? "";
      url.searchParams.set("signature", `${signature.slice(0, -2)}xx`);
      const response = await mediaSignedRoute.GET(new Request(url));
      expect(response.status).toBe(403);
    });

    it("GET api/media/signed with an expired (but validly signed) link is rejected (410)", async () => {
      const signedPath = createSignedMediaUrl({
        key: `src/${fixtures.workspaceBId}/foreign.mp4`,
        workspaceId: fixtures.workspaceBId,
        contentType: "video/mp4",
        expiresInSeconds: -60,
      });
      const response = await mediaSignedRoute.GET(new Request(`http://test.local${signedPath}`));
      expect(response.status).toBe(410);
    });

    it("PUT api/uploads/[uploadId] without a signature is rejected (403)", async () => {
      const response = await uploadPutRoute.PUT(
        new Request("http://test.local/api/uploads/authz-upload", {
          method: "PUT",
          body: "data",
          duplex: "half",
        } as RequestInit),
        { params: Promise.resolve({ uploadId: "authz-upload" }) },
      );
      expect(response.status).toBe(403);
    });

    it("PUT api/uploads/[uploadId] with a tampered signature is rejected (403)", async () => {
      const uploadId = "authz-upload-tampered";
      const signedPath = createSignedUploadUrl({
        uploadId,
        workspaceId: fixtures.workspaceAId,
        maxBytes: 1024,
      });
      const url = new URL(`http://test.local${signedPath}`);
      const signature = url.searchParams.get("signature") ?? "";
      url.searchParams.set("signature", `${signature.slice(0, -2)}xx`);
      const response = await uploadPutRoute.PUT(
        new Request(url, { method: "PUT", body: "data", duplex: "half" } as RequestInit),
        { params: Promise.resolve({ uploadId }) },
      );
      expect(response.status).toBe(403);
    });
  });
});
