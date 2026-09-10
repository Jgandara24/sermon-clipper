import { z } from "zod";

// A calendar date, not an instant. Reject rollover dates such as February 30.
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Use a real calendar date in YYYY-MM-DD format.");

export const sandboxSlotInputSchema = z.object({
  operatorUserId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  projectId: z.string().uuid(),
  clipId: z.string().uuid(),
  date: calendarDate,
  apply: z.boolean().default(false),
  confirmation: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  confirmedSandboxWorkspaceId: z.string().uuid().optional(),
}).strict().superRefine((input, ctx) => {
  if (input.apply && (!input.confirmation || input.confirmedSandboxWorkspaceId !== input.workspaceId)) {
    ctx.addIssue({ code: "custom", message: "Apply requires the plan token and the exact sandbox workspace ID." });
  }
  if (!input.apply && (input.confirmation || input.confirmedSandboxWorkspaceId)) {
    ctx.addIssue({ code: "custom", message: "Confirmation options require --apply." });
  }
});

export type SandboxSlotInput = z.infer<typeof sandboxSlotInputSchema>;

const OPTIONS = {
  "--operator": "operatorUserId",
  "--workspace": "workspaceId",
  "--project": "projectId",
  "--clip": "clipId",
  "--date": "date",
  "--confirm": "confirmation",
  "--confirm-sandbox": "confirmedSandboxWorkspaceId",
} as const;

export function readSandboxSlotArgs(args: readonly string[]): SandboxSlotInput {
  const values: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error(`Duplicate option: ${arg}`);
    seen.add(arg);
    if (arg === "--apply") {
      values.apply = true;
      continue;
    }
    if (!Object.hasOwn(OPTIONS, arg)) throw new Error(`Unknown option: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    values[OPTIONS[arg as keyof typeof OPTIONS]] = value;
  }
  return sandboxSlotInputSchema.parse(values);
}
