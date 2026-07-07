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
  deployment: DeploymentMetadata;
  checks: ReadinessCheck[];
};

type EnvLike = Record<string, string | undefined>;

export type DeploymentMetadata = {
  commitSha: string | null;
  commitSource: string | null;
};

const DEPLOYMENT_COMMIT_ENV_NAMES = [
  "SERMON_CLIPPER_COMMIT_SHA",
  "VERCEL_GIT_COMMIT_SHA",
  "RAILWAY_GIT_COMMIT_SHA",
  "RENDER_GIT_COMMIT",
  "HEROKU_SLUG_COMMIT",
  "GIT_COMMIT_SHA",
  "COMMIT_SHA",
  "SOURCE_VERSION",
];

export function getDeploymentMetadata(env: EnvLike = process.env): DeploymentMetadata {
  const source = DEPLOYMENT_COMMIT_ENV_NAMES.find((name) => env[name]?.trim());
  return {
    commitSha: source ? env[source]?.trim() ?? null : null,
    commitSource: source ?? null,
  };
}

function checkRequiredEnv(env: EnvLike, name: string): ReadinessCheck {
  return env[name]
    ? { name, status: "ok", message: `${name} is configured.` }
    : { name, status: "fail", message: `${name} is required.` };
}

function checkPublicAppUrl(env: EnvLike): ReadinessCheck {
  const value = env.NEXT_PUBLIC_APP_URL;
  if (!value) {
    return { name: "NEXT_PUBLIC_APP_URL", status: "fail", message: "NEXT_PUBLIC_APP_URL is required." };
  }
  if (env.NODE_ENV === "production") {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:") {
        return {
          name: "NEXT_PUBLIC_APP_URL",
          status: "fail",
          message: "NEXT_PUBLIC_APP_URL must use HTTPS in production.",
        };
      }
    } catch {
      return { name: "NEXT_PUBLIC_APP_URL", status: "fail", message: "NEXT_PUBLIC_APP_URL must be a valid URL." };
    }
  }
  return { name: "NEXT_PUBLIC_APP_URL", status: "ok", message: "NEXT_PUBLIC_APP_URL is configured." };
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

function checkApprovalNotificationEnv(env: EnvLike): ReadinessCheck[] {
  if (env.NODE_ENV !== "production") return [];

  const emailConfigured = !!env.SENDGRID_API_KEY && !!env.NOTIFICATIONS_FROM_EMAIL;
  const smsConfigured = !!env.TWILIO_ACCOUNT_SID && !!env.TWILIO_AUTH_TOKEN && !!env.TWILIO_MESSAGING_FROM;

  return [
    emailConfigured || smsConfigured
      ? {
          name: "approval_notifications",
          status: "ok",
          message: `Approval notifications configured via ${emailConfigured ? "email" : "SMS"}.`,
        }
      : {
          name: "approval_notifications",
          status: "fail",
          message:
            "Configure NOTIFICATIONS_FROM_EMAIL with SENDGRID_API_KEY or Twilio SMS credentials for production approval notifications.",
        },
  ];
}

function checkStripeEnv(env: EnvLike): ReadinessCheck[] {
  if (env.NODE_ENV !== "production") return [];

  return [
    env.STRIPE_SECRET_KEY
      ? { name: "STRIPE_SECRET_KEY", status: "ok", message: "Stripe API key is configured." }
      : {
          name: "STRIPE_SECRET_KEY",
          status: "fail",
          message: "STRIPE_SECRET_KEY is required in production for subscription billing.",
        },
    env.STRIPE_WEBHOOK_SECRET
      ? { name: "STRIPE_WEBHOOK_SECRET", status: "ok", message: "Stripe webhook secret is configured." }
      : {
          name: "STRIPE_WEBHOOK_SECRET",
          status: "fail",
          message: "STRIPE_WEBHOOK_SECRET is required in production for billing reconciliation.",
        },
    env.STRIPE_PRICE_STARTER
      ? { name: "STRIPE_PRICE_STARTER", status: "ok", message: "Starter Stripe price is configured." }
      : {
          name: "STRIPE_PRICE_STARTER",
          status: "fail",
          message: "STRIPE_PRICE_STARTER is required in production.",
        },
    env.STRIPE_PRICE_PRO
      ? { name: "STRIPE_PRICE_PRO", status: "ok", message: "Pro Stripe price is configured." }
      : {
          name: "STRIPE_PRICE_PRO",
          status: "fail",
          message: "STRIPE_PRICE_PRO is required in production.",
        },
  ];
}

function checkS3Endpoint(env: EnvLike): ReadinessCheck {
  const endpoint = env.STORAGE_S3_ENDPOINT;
  if (!endpoint) {
    return { name: "STORAGE_S3_ENDPOINT", status: "ok", message: "Using provider default S3 endpoint." };
  }

  try {
    const url = new URL(endpoint);
    if (env.NODE_ENV === "production" && url.protocol !== "https:") {
      return {
        name: "STORAGE_S3_ENDPOINT",
        status: "fail",
        message: "STORAGE_S3_ENDPOINT must use HTTPS in production.",
      };
    }
    return { name: "STORAGE_S3_ENDPOINT", status: "ok", message: "S3-compatible endpoint is valid." };
  } catch {
    return { name: "STORAGE_S3_ENDPOINT", status: "fail", message: "STORAGE_S3_ENDPOINT must be a valid URL." };
  }
}

export function checkDeploymentEnvironment(env: EnvLike = process.env): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [
    checkRequiredEnv(env, "DATABASE_URL"),
    checkPublicAppUrl(env),
    checkRequiredEnv(env, "MEDIA_URL_SECRET"),
    ...checkAuthEmailEnv(env),
    ...checkApprovalNotificationEnv(env),
    ...checkStripeEnv(env),
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
    checks.push(checkS3Endpoint(env));
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

  const deployment = getDeploymentMetadata(env);
  checks.push(
    deployment.commitSha
      ? {
          name: "deployment_commit",
          status: "ok",
          message: `Deployment commit is ${deployment.commitSha}.`,
        }
      : {
          name: "deployment_commit",
          status: env.NODE_ENV === "production" ? "warning" : "ok",
          message: "Set SERMON_CLIPPER_COMMIT_SHA or provider commit metadata for launch evidence.",
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
  const deployment = getDeploymentMetadata(env);
  const checks = [
    ...checkDeploymentEnvironment(env),
    ...(await checkDatabaseReadiness(client)),
    checkStorageReadiness(),
  ];
  return { status: summarizeReadiness(checks), deployment, checks };
}
