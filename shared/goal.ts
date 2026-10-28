import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// One goal per agent. The daemon-side runner owns every transition; clients only read and send
// the commands below.
export const GoalStatusSchema = z.enum([
  "running", // a turn is in flight or about to be sent
  "verifying", // the agent claimed success and is checking each acceptance criterion
  "waiting_limit", // usage limit hit; resumes at `resumeAt`
  "waiting_retry", // transient provider failure; retries at `resumeAt`
  "paused", // stopped by the user, a canceled turn, or the round limit; resumable
  "blocked", // legacy: older versions parked "blocked" reports here; now migrated to running
  "achieved",
  "stopped", // account banned or credentials invalid; resumable once fixed
]);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

export const GoalEventSchema = z.object({
  at: z.string(),
  kind: z.string(),
  detail: z.string(),
});
export type GoalEvent = z.infer<typeof GoalEventSchema>;

export const GoalSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  workspaceId: z.string().nullable(),
  objective: z.string(),
  acceptance: z.string(),
  maxRounds: z.number().int().positive(),
  status: GoalStatusSchema,
  round: z.number().int().nonnegative(),
  resumeAt: z.string().nullable(),
  reason: z.string().nullable(),
  lastEvidence: z.string().nullable(),
  retries: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  events: z.array(GoalEventSchema),
});
export type Goal = z.infer<typeof GoalSchema>;

export const ACTIVE_STATUSES: readonly GoalStatus[] = [
  "running",
  "verifying",
  "waiting_limit",
  "waiting_retry",
];

export const DEFAULT_MAX_ROUNDS = 1000;

export const setGoalRpc = defineRpc({
  name: "goal.set",
  input: z.object({
    agentId: z.string().min(1),
    objective: z.string().trim().min(1),
    acceptance: z.string().trim().min(1),
    maxRounds: z.number().int().positive().max(10000).optional(),
  }),
  output: GoalSchema,
});

export const getGoalRpc = defineRpc({
  name: "goal.get",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({ goal: GoalSchema.nullable() }),
});

export const listGoalsRpc = defineRpc({
  name: "goal.list",
  input: z.object({}),
  output: z.object({ goals: z.array(GoalSchema) }),
});

export const controlGoalRpc = defineRpc({
  name: "goal.control",
  input: z.object({
    agentId: z.string().min(1),
    action: z.enum(["pause", "resume", "clear"]),
  }),
  output: z.object({ goal: GoalSchema.nullable() }),
});

// Timeline card appended by the daemon; rendered by the client.
export const GOAL_CARD_KIND = "goal-event";
export const GoalCardSchema = z.object({
  title: z.string(),
  detail: z.string(),
  tone: z.enum(["info", "success", "warning", "error"]),
});
export type GoalCard = z.infer<typeof GoalCardSchema>;
