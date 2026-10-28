import type { Goal, GoalStatus } from "../shared/goal";

export const STATUS_LABEL: Record<GoalStatus, string> = {
  running: "进行中",
  verifying: "验收中",
  waiting_limit: "等待额度恢复",
  waiting_retry: "等待重试",
  paused: "已暂停",
  blocked: "需要你处理",
  achieved: "已达成",
  stopped: "已停止",
};

export function clock(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function pillLabel(goal: Goal | undefined): string {
  if (!goal) return "目标";
  switch (goal.status) {
    case "running":
      return `目标 · 第${goal.round}轮`;
    case "verifying":
      return "目标 · 验收中";
    case "waiting_limit":
      return `目标 · 等额度 ${clock(goal.resumeAt).split(" ")[1] ?? ""}`;
    case "waiting_retry":
      return "目标 · 重试中";
    default:
      return `目标 · ${STATUS_LABEL[goal.status]}`;
  }
}

export function pillIcon(goal: Goal | undefined): string {
  if (!goal) return "Target";
  switch (goal.status) {
    case "achieved":
      return "CircleCheck";
    case "stopped":
      return "OctagonX";
    case "blocked":
    case "paused":
      return "CirclePause";
    case "waiting_limit":
    case "waiting_retry":
      return "Hourglass";
    default:
      return "Target";
  }
}
