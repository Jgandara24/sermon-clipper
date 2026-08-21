import type { BrowserContext } from "@playwright/test";
import {
  AUTH_SESSION_COOKIE,
  AUTH_SESSION_TTL_MS,
  createSessionToken,
  hashSecret,
} from "../../src/lib/auth/email-otp";
import { prisma } from "../../src/lib/prisma";

/**
 * Signs a browser context in the way the application signs a real visitor in: an `AuthSession` row
 * holding the hash of a fresh token, and the session cookie holding the token itself.
 *
 * The suite used to set `DEV_SESSION_COOKIE` instead. `getCurrentUser` only reads that cookie
 * behind `process.env.NODE_ENV !== "production"`, so the branch is eliminated from a production
 * build and those fixtures authenticated against `next dev` and nothing else. A real session works
 * against either server, because it is the path production itself uses — no bypass, no
 * build-mode-only branch, and no new environment variable.
 *
 * The token is returned to no one. It exists only inside the browser's cookie jar and as a hash in
 * the row, exactly as it does for a real visitor.
 */

export type TestSession = { id: string };

export type SignInOptions = {
  /** Defaults to the application's own session lifetime. */
  expiresAt?: Date;
  /** Set to sign in with a session that has already been revoked. */
  revokedAt?: Date;
};

const createdSessionIds = new Set<string>();

export async function signInAs(
  context: BrowserContext,
  userId: string,
  options: SignInOptions = {},
): Promise<TestSession> {
  const token = createSessionToken();
  const session = await prisma.authSession.create({
    data: {
      userId,
      tokenHash: hashSecret(token),
      expiresAt: options.expiresAt ?? new Date(Date.now() + AUTH_SESSION_TTL_MS),
      revokedAt: options.revokedAt ?? null,
    },
  });
  createdSessionIds.add(session.id);

  await context.addCookies([
    {
      name: AUTH_SESSION_COOKIE,
      value: token,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);

  return { id: session.id };
}

/**
 * Deletes every session signed in so far. Call it before the fixture's own teardown: deleting the
 * user cascades to its sessions, so afterwards this would have nothing left to do.
 */
export async function signOutTestSessions() {
  if (createdSessionIds.size === 0) return;
  const ids = [...createdSessionIds];
  createdSessionIds.clear();
  await prisma.authSession.deleteMany({ where: { id: { in: ids } } });
}
