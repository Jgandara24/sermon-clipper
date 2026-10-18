import { z } from "zod";

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
});

export const sandboxServicePlanInputSchema = z.object({
  operatorId: z.uuid(),
  importUserId: z.uuid(),
  workspaceId: z.uuid(),
  sourceVideoId: z.uuid(),
  name: z.string().trim().min(2).max(120),
  sermonDate: calendarDate,
  occurrence: z.enum(["PRIMARY", "SECONDARY", "UNMATCHED"]),
}).strict();

export const sandboxServiceInputSchema = sandboxServicePlanInputSchema.extend({
  apply: z.boolean().default(false),
  queueFinalize: z.boolean().default(false),
  confirmation: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  confirmedSandboxWorkspaceId: z.uuid().optional(),
  planPath: z.string().min(1).optional(),
}).strict().superRefine((input, ctx) => {
  if (input.apply && (!input.queueFinalize || !input.confirmation || !input.planPath ||
      input.confirmedSandboxWorkspaceId !== input.workspaceId)) {
    ctx.addIssue({ code: "custom", message: "Apply requires the exact apply confirmation, --queue-finalize, and the exact sandbox workspace ID." });
  }
  if (!input.apply && (input.queueFinalize || input.confirmation || input.confirmedSandboxWorkspaceId || input.planPath)) {
    ctx.addIssue({ code: "custom", message: "Confirmation options require --apply." });
  }
});
export type SandboxServiceInput = z.infer<typeof sandboxServiceInputSchema>;

const OPTIONS = {
  "--operator": "operatorId", "--import-user": "importUserId", "--workspace": "workspaceId",
  "--source-video": "sourceVideoId", "--name": "name", "--date": "sermonDate",
  "--occurrence": "occurrence", "--confirm": "confirmation",
  "--confirm-sandbox": "confirmedSandboxWorkspaceId",
  "--plan": "planPath",
} as const;

export function readSandboxServiceArgs(args: readonly string[]): SandboxServiceInput {
  const values: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error(`Duplicate option: ${arg}`);
    seen.add(arg);
    if (arg === "--apply" || arg === "--queue-finalize") {
      values[arg === "--apply" ? "apply" : "queueFinalize"] = true;
      continue;
    }
    if (!Object.hasOwn(OPTIONS, arg)) throw new Error(`Unknown option: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    values[OPTIONS[arg as keyof typeof OPTIONS]] = value;
  }
  return sandboxServiceInputSchema.parse(values);
}
