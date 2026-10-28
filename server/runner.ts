// Drives each agent toward its goal: evaluates every finished turn, sends the next round, waits
// out usage limits and transient failures, and stops for good on bans or dead credentials.
// Nothing but the agent's own verified "achieved" ends a goal: a "blocked" report gets another
// round telling it to work around the blocker, and errors are retried without giving up.
import { randomUUID } from "node:crypto";
import {
  ACTIVE_STATUSES,
  DEFAULT_MAX_ROUNDS,
  type Goal,
  type GoalCard,
  type GoalStatus,
} from "../shared/goal";
import { classifyTurn, type TurnInput } from "./classify";
import { continuePrompt, startPrompt, verifyPrompt } from "./prompts";

export interface AgentState {
  busy: boolean;
  awaitingPermission: boolean;
  workspaceId: string | null;
}

export interface RunnerDeps {
  load(): Goal[];
  save(goals: Goal[]): void;
  send(agentId: string, text: string): Promise<void>;
  /** null when the agent no longer exists or is archived. */
  agentState(agentId: string): Promise<AgentState | null>;
  appendCard(agentId: string, rowId: string, card: GoalCard): Promise<void>;
  now(): number;
  log(message: string): void;
}

const SEND_DELAY_MS = 3_000;
const SEND_FAILURE_RETRY_MS = 60_000;
const LIMIT_GRACE_MS = 60_000;
const LIMIT_FALLBACK_MS = 30 * 60_000;
const CAPACITY_RETRY_MS = 15_000;
const CAPACITY_SLOW_AFTER = 240;
const TRANSIENT_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000];
const SWEEP_MS = 120_000;
const STALE_RUN_MS = 180_000;
const MAX_TIMER_MS = 2_000_000_000;
const MAX_EVENTS = 100;
const CANCELED_REASON = "回合被中断，目标已暂停";

type Dispatch = "start" | "next" | "verify" | "limit" | "retry" | "resume" | "missing" | "blocked";

export class GoalRunner {
  private goals = new Map<string, Goal>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastSentAt = new Map<string, number>();
  private sweep: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: RunnerDeps) {}

  start(): void {
    for (const goal of this.deps.load()) {
      // Goals parked by older versions of this plugin pick up where they stopped.
      if (goal.status === "blocked") goal.status = "running";
      this.goals.set(goal.agentId, goal);
    }
    for (const goal of this.goals.values()) {
      if (goal.status === "waiting_limit" || goal.status === "waiting_retry") {
        this.scheduleAt(goal, Date.parse(goal.resumeAt ?? "") || this.deps.now(), goal.status === "waiting_limit" ? "limit" : "retry");
      }
    }
    // Turn-end events are not replayed, so look for runs that went quiet while we were down.
    this.sweep = setInterval(() => void this.sweepStale(), SWEEP_MS);
    this.sweep.unref?.();
    setTimeout(() => void this.sweepStale(true), 15_000).unref?.();
  }

  stop(): void {
    if (this.sweep) clearInterval(this.sweep);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  get(agentId: string): Goal | null {
    return this.goals.get(agentId) ?? null;
  }

  list(): Goal[] {
    return [...this.goals.values()];
  }

  async set(input: { agentId: string; objective: string; acceptance: string; maxRounds?: number }): Promise<Goal> {
    const state = await this.deps.agentState(input.agentId);
    if (!state) throw new Error("Agent not found or archived");
    this.clearTimer(input.agentId);
    const now = new Date(this.deps.now()).toISOString();
    const goal: Goal = {
      id: randomUUID(),
      agentId: input.agentId,
      workspaceId: state.workspaceId,
      objective: input.objective.trim(),
      acceptance: input.acceptance.trim(),
      maxRounds: input.maxRounds ?? DEFAULT_MAX_ROUNDS,
      status: "running",
      round: 0,
      resumeAt: null,
      reason: null,
      lastEvidence: null,
      retries: 0,
      createdAt: now,
      updatedAt: now,
      events: [],
    };
    this.goals.set(goal.agentId, goal);
    this.record(goal, "start", `目标已设定，最多 ${goal.maxRounds} 轮`, {
      title: "目标模式已开启",
      detail: `${goal.objective}\n\n验收标准：\n${goal.acceptance}`,
      tone: "info",
    });
    // A busy agent finishes its current turn first; that turn end sends the first round.
    if (!state.busy) this.schedule(goal, SEND_DELAY_MS / 3, "start");
    return goal;
  }

  async control(agentId: string, action: "pause" | "resume" | "clear"): Promise<Goal | null> {
    const goal = this.goals.get(agentId);
    if (!goal) return null;
    this.clearTimer(agentId);
    if (action === "clear") {
      this.goals.delete(agentId);
      this.persist();
      void this.deps.appendCard(agentId, `${goal.id}-cleared`, { title: "目标已清除", detail: goal.objective, tone: "info" }).catch(() => {});
      return null;
    }
    if (action === "pause") {
      this.transition(goal, "paused", "手动暂停");
      this.record(goal, "pause", "手动暂停", { title: "目标已暂停", detail: "发送 /goal resume 或在目标面板里继续。", tone: "info" });
      return goal;
    }
    goal.retries = 0;
    if (goal.round >= goal.maxRounds) goal.maxRounds = goal.round + DEFAULT_MAX_ROUNDS;
    this.transition(goal, "running", null);
    this.record(goal, "resume", "继续推进", { title: "目标已恢复", detail: goal.objective, tone: "info" });
    const state = await this.deps.agentState(agentId);
    if (state && !state.busy) this.schedule(goal, SEND_DELAY_MS / 3, "resume");
    return goal;
  }

  onArchived(agentId: string): void {
    if (!this.goals.has(agentId)) return;
    this.clearTimer(agentId);
    this.goals.delete(agentId);
    this.persist();
  }

  onTurnStarted(agentId: string): void {
    const goal = this.goals.get(agentId);
    if (!goal) return;
    // Someone else (the user, another retry tool) already started a turn: let it run and
    // evaluate it when it ends instead of sending our own. A message after an interrupt is the
    // user steering, so the goal picks up again with it.
    const steering = goal.status === "paused" && goal.reason === CANCELED_REASON;
    if (goal.status === "waiting_limit" || goal.status === "waiting_retry" || steering) {
      this.clearTimer(agentId);
      this.transition(goal, "running", null);
    }
    if (goal.status === "running" || goal.status === "verifying") this.lastSentAt.set(agentId, this.deps.now());
  }

  onTurnEnded(agentId: string, input: TurnInput): void {
    const goal = this.goals.get(agentId);
    if (!goal || !ACTIVE_STATUSES.includes(goal.status)) return;
    this.clearTimer(agentId);
    this.lastSentAt.delete(agentId);
    if (input.outcome.kind === "canceled") {
      this.transition(goal, "paused", CANCELED_REASON);
      this.record(goal, "canceled", input.outcome.reason, {
        title: "目标已暂停",
        detail: "回合被中断。直接发消息纠偏，目标会带着它继续；或发送 /goal resume。",
        tone: "warning",
      });
      return;
    }
    const verdict = classifyTurn(input);
    const now = this.deps.now();
    switch (verdict.kind) {
      case "banned":
      case "auth": {
        const title = verdict.kind === "banned" ? "账号异常，目标已停止" : "登录或密钥失效，目标已停止";
        this.transition(goal, "stopped", title);
        this.record(goal, verdict.kind, verdict.message, { title, detail: verdict.message.slice(0, 800), tone: "error" });
        return;
      }
      case "usage_limit": {
        const resetAt =
          verdict.resetAt === null ? now + LIMIT_FALLBACK_MS : Math.max(verdict.resetAt + LIMIT_GRACE_MS, now + LIMIT_GRACE_MS);
        this.wait(goal, "waiting_limit", resetAt, "limit", verdict.message, {
          title: "用量已达上限，等待恢复",
          detail: `${verdict.resetAt === null ? "未识别到重置时间，30 分钟后重试" : "预计恢复"}：${formatTime(resetAt)}`,
          tone: "warning",
        });
        return;
      }
      case "capacity": {
        goal.retries += 1;
        const delay = goal.retries > CAPACITY_SLOW_AFTER ? TRANSIENT_DELAYS_MS.at(-1)! : CAPACITY_RETRY_MS;
        this.wait(goal, "waiting_retry", now + delay, "retry", verdict.message, null);
        return;
      }
      case "transient": {
        goal.retries += 1;
        const delay = TRANSIENT_DELAYS_MS[Math.min(goal.retries - 1, TRANSIENT_DELAYS_MS.length - 1)]!;
        this.wait(goal, "waiting_retry", now + delay, "retry", verdict.message, {
          title: `临时错误，${Math.round(delay / 1000)} 秒后重试（第 ${goal.retries} 次）`,
          detail: verdict.message.slice(0, 800),
          tone: "warning",
        });
        return;
      }
      case "report":
        break;
    }
    goal.retries = 0;
    const report = verdict.report;
    if (report) goal.lastEvidence = report.evidence || goal.lastEvidence;
    if (report?.state === "achieved") {
      if (goal.status === "verifying") {
        this.transition(goal, "achieved", null);
        this.record(goal, "achieved", report.evidence, { title: "目标已达成", detail: report.evidence || goal.objective, tone: "success" });
        return;
      }
      this.transition(goal, "verifying", null);
      this.record(goal, "verify", report.evidence, {
        title: "Agent 报告已达成，开始逐条验收",
        detail: report.evidence || goal.acceptance,
        tone: "info",
      });
      this.schedule(goal, SEND_DELAY_MS, "verify");
      return;
    }
    if (report?.state === "blocked") {
      this.record(goal, "blocked", report.evidence, {
        title: "Agent 报告受阻，自动让它绕开继续",
        detail: report.evidence || "没有写明原因",
        tone: "warning",
      });
    }
    if (goal.round >= goal.maxRounds) {
      this.transition(goal, "paused", `已达到 ${goal.maxRounds} 轮上限`);
      this.record(goal, "max_rounds", `${goal.round} 轮`, { title: "已达到轮数上限，目标已暂停", detail: "发送 /goal resume 再给它一批轮次。", tone: "warning" });
      return;
    }
    this.transition(goal, "running", null);
    // round 0: the goal was set while another turn was running; that turn has ended now.
    const kind = goal.round === 0 ? "start" : !report ? "missing" : report.state === "blocked" ? "blocked" : "next";
    this.schedule(goal, SEND_DELAY_MS, kind);
  }

  // ---- internals ----

  private wait(goal: Goal, status: GoalStatus, at: number, kind: Dispatch, message: string, card: GoalCard | null): void {
    this.transition(goal, status, message.slice(0, 500), new Date(at).toISOString());
    this.record(goal, status, message.slice(0, 300), card);
    this.scheduleAt(goal, at, kind);
  }

  // Keep the record: a lookup can fail for reasons other than deletion.
  private lost(goal: Goal): void {
    this.clearTimer(goal.agentId);
    this.transition(goal, "stopped", "找不到这个 Agent（可能已归档或删除）");
  }

  private schedule(goal: Goal, delay: number, kind: Dispatch): void {
    this.scheduleAt(goal, this.deps.now() + delay, kind);
  }

  private scheduleAt(goal: Goal, at: number, kind: Dispatch): void {
    this.clearTimer(goal.agentId);
    const delay = Math.min(Math.max(0, at - this.deps.now()), MAX_TIMER_MS);
    const timer = setTimeout(() => {
      this.timers.delete(goal.agentId);
      if (at > this.deps.now() + 1000) return this.scheduleAt(goal, at, kind);
      void this.dispatch(goal.agentId, goal.id, kind);
    }, delay);
    timer.unref?.();
    this.timers.set(goal.agentId, timer);
  }

  private async dispatch(agentId: string, goalId: string, kind: Dispatch): Promise<void> {
    const goal = this.goals.get(agentId);
    if (!goal || goal.id !== goalId || !ACTIVE_STATUSES.includes(goal.status)) return;
    let state: AgentState | null;
    try {
      state = await this.deps.agentState(agentId);
    } catch {
      return this.scheduleAt(goal, this.deps.now() + SEND_FAILURE_RETRY_MS, kind);
    }
    if (!state) return this.lost(goal);
    // Busy: the running turn's end will be evaluated. Awaiting permission: the user decides.
    if (state.busy || state.awaitingPermission) return;
    const text =
      kind === "start" ? startPrompt(goal) : kind === "verify" ? verifyPrompt(goal) : continuePrompt(goal, kind);
    goal.round += 1;
    if (kind !== "verify" && goal.status !== "verifying") this.transition(goal, "running", null);
    else this.persist();
    this.lastSentAt.set(agentId, this.deps.now());
    try {
      await this.deps.send(agentId, text);
      this.deps.log(`goal ${goal.id} agent ${agentId}: sent ${kind} (round ${goal.round})`);
    } catch (error) {
      goal.round -= 1;
      this.deps.log(`goal ${goal.id} agent ${agentId}: send failed: ${String(error)}`);
      this.scheduleAt(goal, this.deps.now() + SEND_FAILURE_RETRY_MS, kind);
    }
  }

  private async sweepStale(initial = false): Promise<void> {
    for (const goal of this.goals.values()) {
      if (goal.status !== "running" && goal.status !== "verifying") continue;
      if (this.timers.has(goal.agentId)) continue;
      const sentAt = this.lastSentAt.get(goal.agentId);
      if (!initial && sentAt !== undefined && this.deps.now() - sentAt < STALE_RUN_MS) continue;
      let state: AgentState | null;
      try {
        state = await this.deps.agentState(goal.agentId);
      } catch {
        continue;
      }
      if (!state) {
        this.lost(goal);
        continue;
      }
      if (state.busy || state.awaitingPermission) continue;
      this.deps.log(`goal ${goal.id}: agent ${goal.agentId} idle without a pending round; continuing`);
      void this.dispatch(goal.agentId, goal.id, goal.status === "verifying" ? "verify" : "next");
    }
  }

  private transition(goal: Goal, status: GoalStatus, reason: string | null, resumeAt: string | null = null): void {
    goal.status = status;
    goal.reason = reason;
    goal.resumeAt = resumeAt;
    goal.updatedAt = new Date(this.deps.now()).toISOString();
    this.persist();
  }

  private record(goal: Goal, kind: string, detail: string, card: GoalCard | null): void {
    goal.events.push({ at: new Date(this.deps.now()).toISOString(), kind, detail: detail.slice(0, 500) });
    if (goal.events.length > MAX_EVENTS) goal.events.splice(0, goal.events.length - MAX_EVENTS);
    this.persist();
    if (card) {
      const rowId = `${goal.id}-${goal.events.length}-${kind}`;
      void this.deps.appendCard(goal.agentId, rowId, card).catch((error) => this.deps.log(`card append failed: ${String(error)}`));
    }
  }

  private clearTimer(agentId: string): void {
    const timer = this.timers.get(agentId);
    if (timer) clearTimeout(timer);
    this.timers.delete(agentId);
  }

  private persist(): void {
    this.deps.save(this.list());
  }
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
