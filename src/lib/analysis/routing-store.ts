import {
  AnalysisProviderKind as PrismaProviderKind,
  AnalysisRoutingPolicyState,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import {
  activeModelPrice,
  assertRoutingPolicyActivatable,
  assertRoutingPolicyPriced,
  resolveProjectAnalysisRouting,
  type AnalysisModelPrice,
  type AnalysisProviderKind,
  type AnalysisRoutingPolicy,
  type AnalysisRoutingSnapshot,
} from "./routing";

function providerKind(value: PrismaProviderKind): AnalysisProviderKind {
  return value.toLowerCase() as AnalysisProviderKind;
}

function policyFromRow(row: {
  id: string;
  version: number;
  classificationProvider: PrismaProviderKind;
  classificationModel: string;
  scoringProvider: PrismaProviderKind;
  scoringModel: string;
  promptVersion: number;
  schemaVersion: number;
}): AnalysisRoutingPolicy {
  return {
    id: row.id,
    version: row.version,
    classification: {
      provider: providerKind(row.classificationProvider),
      model: row.classificationModel,
    },
    scoring: {
      provider: providerKind(row.scoringProvider),
      model: row.scoringModel,
    },
    promptVersion: row.promptVersion,
    schemaVersion: row.schemaVersion,
  };
}

function priceFromRow(row: {
  provider: PrismaProviderKind;
  model: string;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  inputPerMillionUsd: Prisma.Decimal;
  cacheReadPerMillionUsd: Prisma.Decimal | null;
  cacheWritePerMillionUsd: Prisma.Decimal | null;
  outputPerMillionUsd: Prisma.Decimal;
  pricingSourceUrl: string;
}): AnalysisModelPrice {
  return {
    provider: providerKind(row.provider),
    model: row.model,
    effectiveFrom: row.effectiveFrom,
    effectiveUntil: row.effectiveUntil,
    inputPerMillionUsd: row.inputPerMillionUsd.toNumber(),
    cacheReadPerMillionUsd: row.cacheReadPerMillionUsd?.toNumber() ?? null,
    cacheWritePerMillionUsd: row.cacheWritePerMillionUsd?.toNumber() ?? null,
    outputPerMillionUsd: row.outputPerMillionUsd.toNumber(),
    pricingSourceUrl: row.pricingSourceUrl,
  };
}

export type ResolvedAnalysisRouting = {
  routing: AnalysisRoutingSnapshot;
  source: "project_snapshot" | "master_policy";
  prices: {
    classification: AnalysisModelPrice | null;
    scoring: AnalysisModelPrice | null;
  };
};

/** Loads one policy for a shadow evaluation. It does not change a project or the active policy. */
export async function loadAnalysisRoutingPolicyForEvaluation(
  prisma: PrismaClient,
  version: number,
  at = new Date(),
): Promise<ResolvedAnalysisRouting> {
  const [policyRow, priceRows] = await Promise.all([
    prisma.analysisRoutingPolicy.findUniqueOrThrow({ where: { version } }),
    prisma.analysisModelPrice.findMany({
      where: {
        effectiveFrom: { lte: at },
        OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: at } }],
      },
    }),
  ]);
  const policy = policyFromRow(policyRow);
  const prices = priceRows.map(priceFromRow);
  assertRoutingPolicyPriced(policy, prices, at);
  const routing = {
    policyId: policy.id,
    policyVersion: policy.version,
    classification: policy.classification,
    scoring: policy.scoring,
    promptVersion: policy.promptVersion,
    schemaVersion: policy.schemaVersion,
  };
  return {
    routing,
    source: "master_policy",
    prices: {
      classification: activeModelPrice(prices, routing.classification, at),
      scoring: activeModelPrice(prices, routing.scoring, at),
    },
  };
}

export type CreateAnalysisRoutingDraftInput = {
  name: string;
  classification: { provider: AnalysisProviderKind; model: string };
  scoring: { provider: AnalysisProviderKind; model: string };
  promptVersion?: number;
  schemaVersion?: number;
};

function prismaProviderKind(value: AnalysisProviderKind): PrismaProviderKind {
  return PrismaProviderKind[value.toUpperCase() as keyof typeof PrismaProviderKind];
}

/** Creates a priced draft. It cannot affect customer analysis until a separate promotion. */
export async function createAnalysisRoutingPolicyDraft(
  prisma: PrismaClient,
  input: CreateAnalysisRoutingDraftInput,
) {
  const createdAt = new Date();
  return prisma.$transaction(async (tx) => {
    const [latest, priceRows] = await Promise.all([
      tx.analysisRoutingPolicy.findFirst({ orderBy: { version: "desc" }, select: { version: true } }),
      tx.analysisModelPrice.findMany({
        where: {
          effectiveFrom: { lte: createdAt },
          OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: createdAt } }],
        },
      }),
    ]);
    const policy: AnalysisRoutingPolicy = {
      id: "pending",
      version: (latest?.version ?? 0) + 1,
      classification: input.classification,
      scoring: input.scoring,
      promptVersion: input.promptVersion ?? 1,
      schemaVersion: input.schemaVersion ?? 1,
    };
    assertRoutingPolicyPriced(policy, priceRows.map(priceFromRow), createdAt);
    const created = await tx.analysisRoutingPolicy.create({
      data: {
        version: policy.version,
        name: input.name.trim(),
        state: AnalysisRoutingPolicyState.DRAFT,
        classificationProvider: prismaProviderKind(input.classification.provider),
        classificationModel: input.classification.model,
        scoringProvider: prismaProviderKind(input.scoring.provider),
        scoringModel: input.scoring.model,
        promptVersion: policy.promptVersion,
        schemaVersion: policy.schemaVersion,
      },
    });
    await tx.operationalEvent.create({
      data: {
        category: "analysis",
        eventType: "analysis_routing_draft_created",
        message: `Analysis routing policy ${created.version} was created as a draft.`,
        metadata: {
          policyId: created.id,
          policyVersion: created.version,
          classification: input.classification,
          scoring: input.scoring,
          promptVersion: created.promptVersion,
          schemaVersion: created.schemaVersion,
        },
      },
    });
    return created;
  });
}

/** Promotes one tested draft. The transaction keeps exactly one active master version. */
export async function activateAnalysisRoutingPolicy(
  prisma: PrismaClient,
  version: number,
  activatedAt = new Date(),
) {
  return prisma.$transaction(async (tx) => {
    const [row, priceRows] = await Promise.all([
      tx.analysisRoutingPolicy.findUniqueOrThrow({ where: { version } }),
      tx.analysisModelPrice.findMany({
        where: {
          effectiveFrom: { lte: activatedAt },
          OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: activatedAt } }],
        },
      }),
    ]);
    const policy = policyFromRow(row);
    assertRoutingPolicyActivatable(policy);
    assertRoutingPolicyPriced(policy, priceRows.map(priceFromRow), activatedAt);
    await tx.analysisRoutingPolicy.updateMany({
      where: { state: AnalysisRoutingPolicyState.ACTIVE },
      data: { state: AnalysisRoutingPolicyState.RETIRED },
    });
    const activated = await tx.analysisRoutingPolicy.update({
      where: { version },
      data: { state: AnalysisRoutingPolicyState.ACTIVE, activatedAt },
    });
    await tx.operationalEvent.create({
      data: {
        category: "analysis",
        eventType: "master_analysis_routing_changed",
        message: `Analysis routing policy ${activated.version} became active.`,
        metadata: {
          policyId: activated.id,
          policyVersion: activated.version,
          previousState: row.state,
          classification: policy.classification,
          scoring: policy.scoring,
          promptVersion: activated.promptVersion,
          schemaVersion: activated.schemaVersion,
        },
      },
    });
    return activated;
  });
}

/** Loads the active master policy and writes one immutable project snapshot when needed. */
export async function resolveAndSnapshotProjectAnalysisRouting(
  prisma: PrismaClient,
  projectId: string,
  at = new Date(),
): Promise<ResolvedAnalysisRouting> {
  return prisma.$transaction(async (tx) => {
    const [project, policyRow, priceRows] = await Promise.all([
      tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { processingConfig: true } }),
      tx.analysisRoutingPolicy.findFirstOrThrow({
        where: { state: AnalysisRoutingPolicyState.ACTIVE },
        orderBy: { version: "desc" },
      }),
      tx.analysisModelPrice.findMany({
        where: {
          effectiveFrom: { lte: at },
          OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: at } }],
        },
      }),
    ]);

    const policy = policyFromRow(policyRow);
    const prices = priceRows.map(priceFromRow);
    assertRoutingPolicyPriced(policy, prices, at);
    const resolved = resolveProjectAnalysisRouting(project.processingConfig, policy);

    if (resolved.source === "master_policy") {
      const raw =
        project.processingConfig &&
        typeof project.processingConfig === "object" &&
        !Array.isArray(project.processingConfig)
          ? (project.processingConfig as Prisma.JsonObject)
          : {};
      await tx.project.update({
        where: { id: projectId },
        data: {
          processingConfig: {
            ...raw,
            analysisRouting: resolved.routing,
          } as Prisma.InputJsonValue,
        },
      });
    }

    return {
      ...resolved,
      prices: {
        classification: activeModelPrice(prices, resolved.routing.classification, at),
        scoring: activeModelPrice(prices, resolved.routing.scoring, at),
      },
    };
  });
}
