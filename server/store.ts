import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { type Goal, GoalSchema } from "../shared/goal";

// Goals outlive plugin reloads and daemon restarts, so they live next to the daemon state.
const FILE = path.join(process.env.PASEO_HOME || path.join(homedir(), ".paseo"), "goal-mode", "goals.json");

export function loadGoals(file = FILE): Goal[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const parsed = z.array(GoalSchema).safeParse(JSON.parse(raw));
  if (!parsed.success) {
    console.error(`goal-mode: ignoring unreadable ${file}`);
    return [];
  }
  return parsed.data;
}

export function saveGoals(goals: Goal[], file = FILE): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(goals, null, 2), "utf8");
  renameSync(tmp, file);
}
