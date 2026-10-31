import { PrismaClient } from "@prisma/client";
import {
  applySelectionStepsChange,
  parseSelectionStepsSettings,
  SELECTION_STEPS,
  type SelectionStep,
} from "@/lib/analysis/selection-steps";
import { updateWorkspaceSettings } from "@/lib/workspace-settings";

/**
 * The operator's switch for the workspace gate of the selection steps
 * (docs/SELECTION_STEPS_SETTINGS_PLAN.md). The environment gate is the worker's `*_ENABLED`
 * variables; a step runs only when both gates say so, so this script alone turns nothing on.
 *
 *   npm run set:selection-steps -- --workspace <id> --on sermonSpan,boundaryStep
 *   npm run set:selection-steps -- --workspace <id> --off speakerTracking
 *   npm run set:selection-steps -- --workspace <id> --show
 */

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(): never {
  throw new Error(
    "Usage: npm run set:selection-steps -- --workspace <id> --on <step,...> [--off <step,...>]; " +
      "npm run set:selection-steps -- --workspace <id> --off <step,...>; or " +
      `npm run set:selection-steps -- --workspace <id> --show. Steps: ${SELECTION_STEPS.join(", ")}.`,
  );
}

function parseSteps(raw: string | undefined, option: string): SelectionStep[] {
  if (raw === undefined) return [];
  const names = raw.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
  for (const name of names) {
    if (!(SELECTION_STEPS as readonly string[]).includes(name)) {
      throw new Error(`Unknown step "${name}" for ${option}. Steps: ${SELECTION_STEPS.join(", ")}. Nothing was changed.`);
    }
  }
  return names as SelectionStep[];
}

function describe(name: string, settings: unknown): string {
  const steps = parseSelectionStepsSettings(settings);
  return [`Workspace ${name}:`, ...SELECTION_STEPS.map((step) => `  ${step}: ${steps[step] ? "on" : "off"}`)].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const workspaceId = readOption(args, "--workspace");
  const show = args.includes("--show");
  const on = parseSteps(readOption(args, "--on"), "--on");
  const off = parseSteps(readOption(args, "--off"), "--off");
  if (!workspaceId || workspaceId.startsWith("--") || (!show && on.length === 0 && off.length === 0)) usage();
  const both = on.filter((step) => off.includes(step));
  if (both.length > 0) {
    throw new Error(`${both.join(", ")} cannot be both --on and --off. Nothing was changed.`);
  }

  const prisma = new PrismaClient();
  try {
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { name: true, settings: true },
    });
    if (show) {
      console.log(describe(workspace.name, workspace.settings));
      return;
    }
    const next = await updateWorkspaceSettings(prisma, workspaceId, (current) =>
      applySelectionStepsChange(current, { on, off }),
    );
    console.log(describe(workspace.name, next));
    console.log("A step runs only when the worker's environment variable for it is also true (docs/DEPLOYMENT.md, Selection Steps).");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
