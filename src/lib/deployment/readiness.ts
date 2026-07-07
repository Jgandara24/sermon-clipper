import type { PrismaClient } from "@prisma/client";
import { getStorageProvider } from "@/lib/storage";

export type ReadinessStatus = "ok" | "warning" | "fail";

export type ReadinessCheck = {
  name: string;
  status: ReadinessStatus;
  message: string;
};

export type DeploymentReadiness = {
  status: "ok" | "degraded" | "fail";
  checks: ReadinessCheck[];
};

type EnvLike = Record<string, string | undefined>;

function checkRequiredEnv(env: EnvLike, name: string): ReadinessCheck {
  return env[name]
    ? { name, status: "ok", message: `${name} is configured.` }
    : { name, status: "fail", message: `${name} is required.` };
}

function checkAuthEmailEnv(env: EnvLike): ReadinessCheck[] {
  if (env.NODE_ENV !== "production") return [];

  return [
    env.SENDGRID_API_KEY
      ? { name: "SENDGRID_API_KEY", status: "ok", message: "SendGrid is configured for auth email." }
      : {
          name: "SENDGRID_API_KEY",
          status: "fail",
          message: "SENDGRID_API_KEY is required in production for email OTP sign-in.",
        },
    env.AUTH_EMAIL_FROM || env.NOTIFICATIONS_FROM_EMAIL
      ? {
          name: "AUTH_EMAIL_FROM",
          status: "ok",
          message: "Auth email sender is configured.",
        }
      : {
          name: "AUTH_EMAIL_FROM",
          status: "fail",
          message: "AUTH_EMAIL_FROM or NOTIFICATIONS_FROM_EMAIL is required in production.",
        },
  ];
}

export function checkDeploymentEnvironment(env: EnvLike = process.env): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [
    checkRequiredEnv(env, "DATABASE_URL"),
    checkRequiredEnv(env, "NEXT_PUBLIC_APP_URL"),
    checkRequiredEnv(env, "MEDIA_URL_SECRET"),
    ...checkAuthEmailEnv(env),
  ];

  const storageProvider = env.STORAGE_PROVIDER ?? "local";
  if (env.NODE_ENV === "production" && storageProvider !== "s3") {
    checks.push({
      name: "STORAGE_PROVIDER",
      status: "fail",
      message: "Production deployments must use STORAGE_PROVIDER=s3.",
    });
  } else {
    checks.push({
      name: "STORAGE_PROVIDER",
      status: "ok",
      message: `Storage provider is ${storageProvider}.`,
    });
  }

  if (storageProvider === "s3") {
    for (const name of ["STORAGE_S3_BUCKET", "STORAGE_S3_ACCESS_KEY_ID", "STORAGE_S3_SECRET_ACCESS_KEY"]) {
      checks.push(checkRequiredEnv(env, name));
    }
    checks.push({
      name: "STORAGE_S3_REGION",
      status: "ok",
      message: `S3 region is ${env.STORAGE_S3_REGION ?? "auto"}.`,
    });
  }

  checks.push(
    env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
      ? {
          name: "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
          status: "ok",
          message: "Server Action encryption key is stable across instances.",
        }
      : {
          name: "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
          status: "warning",
          message: "Set this for multi-instance or self-hosted deployments.",
        },
  );

  return checks;
}

export async function checkDatabaseReadiness(client: PrismaClient): Promise<ReadinessCheck[]> {
  try {
    await client.$queryRaw`SELECT 1`;
  } catch (error) {
    return [
      {
        name: "database",
        status: "fail",
        message: error instanceof Error ? error.message : "Database query failed.",
      },
    ];
  }

  try {
    const failedMigrations = await client.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint
      FROM "_prisma_migrations"
      WHERE finished_at IS NULL
        AND rolled_back_at IS NULL
    `;
    const count = Number(failedMigrations[0]?.count ?? 0);
    return [
      { name: "database", status: "ok", message: "Database is reachable." },
      count === 0
        ? { name: "migrations", status: "ok", message: "No incomplete Prisma migrations found." }
        : { name: "migrations", status: "fail", message: `${count} Prisma migration(s) are incomplete.` },
    ];
  } catch (error) {
    return [
      { name: "database", status: "ok", message: "Database is reachable." },
      {
        name: "migrations",
        status: "warning",
        message: error instanceof Error ? error.message : "Could not inspect Prisma migrations.",
      },
    ];
  }
}

export function checkStorageReadiness(): ReadinessCheck {
  try {
    getStorageProvider();
    return { name: "storage", status: "ok", message: "Storage provider is configured." };
  } catch (error) {
    return {
      name: "storage",
      status: "fail",
      message: error instanceof Error ? error.message : "Storage provider is not configured.",
    };
  }
}

export function summarizeReadiness(checks: ReadinessCheck[]): DeploymentReadiness["status"] {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warning")) return "degraded";
  return "ok";
}

export async function checkDeploymentReadiness(
  client: PrismaClient,
  env: EnvLike = process.env,
): Promise<DeploymentReadiness> {
  const checks = [
    ...checkDeploymentEnvironment(env),
    ...(await checkDatabaseReadiness(client)),
    checkStorageReadiness(),
  ];
  return { status: summarizeReadiness(checks), checks };
}
