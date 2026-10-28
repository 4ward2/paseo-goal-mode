// Run: npm test  (bundles with esbuild, runs with node:test and mocked timers)
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Goal } from "../shared/goal";
import { classifyTurn, parseGoalReport, type TurnInput } from "./classify";
import { type AgentState, GoalRunner } from "./runner";

const AGENT = "agent-1";
const T0 = Date.UTC(2026, 9, 17, 6, 0, 0);

function block(state: string, evidence = "done some work") {
  return `work log...\n<goal-status>\nstate: ${state}\nevidence: ${evidence}\n</goal-status>`;
}

function harness(initial: Partial<AgentState> = {}) {
  const sent: string[] = [];
  const cards: string[] = [];
  let saved: Goal[] = [];
  const state: AgentState = { busy: false, awaitingPermission: false, workspaceId: "ws-1", ...initial };
  const runner = new GoalRunner({
    load: () => [],
    save: (goals) => {
      saved = structuredClone(goals);
    },
    send: async (_agentId, text) => {
      sent.push(text);
    },
    agentState: async () => ({ ...state }),
    appendCard: async (_agentId, _rowId, card) => {
      cards.push(card.title);
    },
    now: () => Date.now(),
    log: () => {},
  });
  const end = (outcome: TurnInput["outcome"], output = "", errors: string[] = []) =>
    runner.onTurnEnded(AGENT, { outcome, output, errors, now: new Date() });
  const goal = () => runner.get(AGENT)!;
  return { runner, sent, cards, state, end, goal, saved: () => saved };
}

async function tick(ms: number) {
  mock.timers.tick(ms);
  // Let the dispatch promise chain (agentState → send) settle.
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: T0 }));
afterEach(() => mock.timers.reset());

async function started() {
  const h = harness();
  await h.runner.set({ agentId: AGENT, objective: "让测试全部通过", acceptance: "1. npm test 通过" });
  await tick(1000);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!, /\[目标模式\][\s\S]*让测试全部通过[\s\S]*<goal-status>/);
  return h;
}

test("continuing report sends the next round", async () => {
  const h = await started();
  h.end({ kind: "completed" }, block("continuing"));
  await tick(3000);
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1]!, /第 2 轮/);
  assert.equal(h.goal().status, "running");
  assert.equal(h.goal().round, 2);
});

test("missing status block still continues with a reminder", async () => {
  const h = await started();
  h.end({ kind: "completed" }, "I did a few things.");
  await tick(3000);
  assert.match(h.sent[1]!, /缺少状态块/);
});

test("achieved goes through one verification round before finishing", async () => {
  const h = await started();
  h.end({ kind: "completed" }, block("achieved", "all tests pass"));
  assert.equal(h.goal().status, "verifying");
  await tick(3000);
  assert.match(h.sent[1]!, /验收/);
  h.end({ kind: "completed" }, block("achieved", "verified: npm test exit 0"));
  assert.equal(h.goal().status, "achieved");
  await tick(600_000);
  assert.equal(h.sent.length, 2);
  assert.ok(h.cards.includes("目标已达成"));
});

test("verification that finds gaps returns to work", async () => {
  const h = await started();
  h.end({ kind: "completed" }, block("achieved"));
  await tick(3000);
  h.end({ kind: "completed" }, block("continuing", "criterion 2 missing"));
  assert.equal(h.goal().status, "running");
  await tick(3000);
  assert.equal(h.sent.length, 3);
});

test("usage limit with a unix reset time waits and then resumes", async () => {
  const h = await started();
  const reset = Math.floor((T0 + 2 * 3600_000) / 1000);
  h.end({ kind: "completed" }, `Claude AI usage limit reached|${reset}`);
  assert.equal(h.goal().status, "waiting_limit");
  assert.equal(Date.parse(h.goal().resumeAt!), reset * 1000 + 60_000);
  await tick(2 * 3600_000);
  assert.equal(h.sent.length, 1, "must not resume before reset + grace");
  await tick(61_000);
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1]!, /额度已恢复/);
  assert.equal(h.goal().status, "running");
});

test("5-hour limit as a failed turn with a relative time", async () => {
  const h = await started();
  h.end({ kind: "failed", error: { message: "You've hit your usage limit. Try again in 3 hours 20 minutes." } });
  assert.equal(h.goal().status, "waiting_limit");
  assert.equal(Date.parse(h.goal().resumeAt!), T0 + 1000 + 3 * 3600_000 + 20 * 60_000 + 60_000);
});

test("Chinese limit message is recognized", async () => {
  const h = await started();
  h.end({ kind: "completed" }, "额度已用尽，将于 15:00 重置");
  assert.equal(h.goal().status, "waiting_limit");
});

test("limit without a reset time retries after 30 minutes", async () => {
  const h = await started();
  h.end({ kind: "failed", error: { message: "Usage limit reached for this account" } });
  assert.equal(h.goal().status, "waiting_limit");
  await tick(30 * 60_000 + 1000);
  assert.equal(h.sent.length, 2);
});

test("banned account stops the goal for good", async () => {
  const h = await started();
  h.end({ kind: "failed", error: { message: "Your account has been disabled after the automatic review" } });
  assert.equal(h.goal().status, "stopped");
  await tick(24 * 3600_000);
  assert.equal(h.sent.length, 1);
  assert.ok(h.cards.some((c) => c.includes("账号异常")));
});

test("Chinese ban notice stops the goal", async () => {
  const h = await started();
  h.end({ kind: "completed" }, "", ["您的账号已被封禁，如有疑问请联系客服"]);
  assert.equal(h.goal().status, "stopped");
});

test("invalid credentials stop the goal", async () => {
  const h = await started();
  h.end({ kind: "failed", error: { message: "API Error: 401 authentication_error: invalid x-api-key" } });
  assert.equal(h.goal().status, "stopped");
  assert.match(h.goal().reason!, /登录或密钥/);
});

test("transient failure backs off and retries", async () => {
  const h = await started();
  h.end({ kind: "failed", error: { message: "upstream request failed: 502 Bad Gateway" } });
  assert.equal(h.goal().status, "waiting_retry");
  await tick(29_000);
  assert.equal(h.sent.length, 1);
  await tick(2_000);
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1]!, /临时错误/);
  h.end({ kind: "failed", error: { message: "socket hang up" } });
  assert.equal(Date.parse(h.goal().resumeAt!) - Date.now(), 60_000);
});

test("an agent writing about rate limits is not a provider error", async () => {
  const h = await started();
  h.end({ kind: "completed" }, `Added a token bucket rate limit to the API.\n${block("continuing")}`);
  assert.equal(h.goal().status, "running");
});

test("blocked does not pause: the next round tells the agent to work around it", async () => {
  const h = await started();
  h.end({ kind: "completed" }, block("blocked", "需要生产数据库的只读账号"));
  assert.equal(h.goal().status, "running");
  await tick(3000);
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1]!, /受阻：需要生产数据库的只读账号[\s\S]*绕开它/);
});

test("canceled turn pauses; the user's next message revives it, however late", async () => {
  const h = await started();
  h.end({ kind: "canceled", reason: "user interrupt" });
  assert.equal(h.goal().status, "paused");
  await tick(3_600_000);
  assert.equal(h.sent.length, 1);
  h.runner.onTurnStarted(AGENT);
  assert.equal(h.goal().status, "running");
  h.end({ kind: "completed" }, block("continuing"));
  await tick(3000);
  assert.equal(h.sent.length, 2);
});

test("transient failures keep retrying instead of giving up", async () => {
  const h = await started();
  for (let i = 0; i < 30; i++) {
    h.end({ kind: "failed", error: { message: "502 Bad Gateway" } });
    assert.equal(h.goal().status, "waiting_retry");
    await tick(1_800_000);
  }
  assert.equal(h.sent.length, 31);
});

test("someone else resuming during a limit wait cancels our resume", async () => {
  const h = await started();
  h.end({ kind: "completed" }, `Claude AI usage limit reached|${Math.floor((T0 + 3600_000) / 1000)}`);
  h.runner.onTurnStarted(AGENT);
  assert.equal(h.goal().status, "running");
  await tick(2 * 3600_000);
  assert.equal(h.sent.length, 1);
});

test("busy agent is not sent to; its turn end drives the next round", async () => {
  const h = await started();
  h.end({ kind: "completed" }, block("continuing"));
  h.state.busy = true;
  await tick(3000);
  assert.equal(h.sent.length, 1);
});

test("round limit pauses the goal", async () => {
  const h = harness();
  await h.runner.set({ agentId: AGENT, objective: "x", acceptance: "y", maxRounds: 1 });
  await tick(1000);
  h.end({ kind: "completed" }, block("continuing"));
  assert.equal(h.goal().status, "paused");
});

test("goal set while the agent is busy starts after the current turn", async () => {
  const h = harness({ busy: true });
  await h.runner.set({ agentId: AGENT, objective: "x", acceptance: "y" });
  await tick(5000);
  assert.equal(h.sent.length, 0);
  h.state.busy = false;
  h.end({ kind: "completed" }, "previous work finished");
  await tick(3000);
  assert.match(h.sent[0]!, /^\[目标模式\] 请自主推进/);
});

test("parseGoalReport takes the last block", () => {
  const text = `${block("continuing", "a")}\nmore\n${block("achieved", "b")}`;
  assert.deepEqual(parseGoalReport(text), { state: "achieved", evidence: "b" });
  assert.equal(parseGoalReport("no block"), null);
});

test("model capacity is retried quickly", () => {
  const verdict = classifyTurn({
    outcome: { kind: "completed" },
    output: "[System Error] Selected model is at capacity. Please try a different model.",
    errors: [],
    now: new Date(),
  });
  assert.equal(verdict.kind, "capacity");
});

test("an agent that cannot be found stops the goal but keeps its record", async () => {
  const h = await started();
  h.end({ kind: "completed" }, block("continuing"));
  const runner = h.runner as unknown as { deps: { agentState: () => Promise<null> } };
  runner.deps.agentState = async () => null;
  await tick(3000);
  assert.equal(h.goal().status, "stopped");
  assert.equal(h.sent.length, 1);
});
