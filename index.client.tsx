import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { GoalCardRow } from "./client/goal-card";
import { GoalPanel } from "./client/goal-panel";
import { pillIcon, pillLabel } from "./client/labels";
import {
  controlGoalRpc,
  GOAL_CARD_KIND,
  GoalCardSchema,
  type Goal,
  listGoalsRpc,
  setGoalRpc,
} from "./shared/goal";

const PANEL_ID = "goal";
const POLL_MS = 4000;
const ACCEPTANCE_MARKER = /(?:^|\s)(?:验收标准|验收|acceptance)\s*[:：]/i;
const CONTROL_WORDS: Record<string, "pause" | "resume" | "clear"> = {
  pause: "pause",
  暂停: "pause",
  resume: "resume",
  继续: "resume",
  恢复: "resume",
  clear: "clear",
  清除: "clear",
  取消: "clear",
};

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({ id: PANEL_ID, title: "目标", icon: "Target", context: "agent", Component: GoalPanel });
  client.addTimelineRenderer({ kind: GOAL_CARD_KIND, version: 1, schema: GoalCardSchema, Component: GoalCardRow });

  client.addSlashCommand({
    name: "goal",
    description: "目标模式：自动推进直到满足验收标准",
    argumentHint: "<目标> 验收：<标准> | pause | resume | clear",
    context: "agent",
    async onSubmit({ args, agent, rpc, openPanel }) {
      const text = args.trim();
      if (!text || text === "status" || text === "状态") return openPanel(PANEL_ID);
      const action = CONTROL_WORDS[text.toLowerCase()];
      if (action) {
        await rpc(controlGoalRpc, { agentId: agent.id, action });
        return openPanel(PANEL_ID);
      }
      const marker = ACCEPTANCE_MARKER.exec(text);
      if (!marker) {
        openPanel(PANEL_ID);
        throw new Error("缺少验收标准。用法：/goal <目标> 验收：<标准>，或在打开的目标面板里填写。");
      }
      await rpc(setGoalRpc, {
        agentId: agent.id,
        objective: text.slice(0, marker.index).trim(),
        acceptance: text.slice(marker.index + marker[0].length).trim(),
      });
      openPanel(PANEL_ID);
    },
  });

  // A pill on every agent's composer: opens the goal panel and shows the goal's state.
  const pills = new Map<string, PluginButtonRegistration>();
  const goals = new Map<string, Goal>();
  const workspaces = new Map<string, string>();
  const lifetime = new AbortController();
  let stopped = false;

  const describe = (agentId: string, workspaceId: string) => {
    const goal = goals.get(agentId);
    return {
      title: "目标模式",
      icon: pillIcon(goal),
      label: pillLabel(goal),
      behavior: { kind: "action" as const, onPress: () => client.openPanel(PANEL_ID, { workspaceId, agentId }) },
    };
  };
  const register = (agent: { id: string; workspaceId?: string | null }) => {
    if (stopped || !agent.workspaceId) return;
    pills.get(agent.id)?.remove();
    pills.set(
      agent.id,
      client.addComposerPill({
        id: "goal",
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: describe(agent.id, agent.workspaceId),
      }),
    );
    workspaces.set(agent.id, agent.workspaceId);
  };
  const unregister = (agentId: string) => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
    workspaces.delete(agentId);
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const id of [...pills.keys()]) unregister(id);
          for (const { agent } of entries) register(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") unregister(update.agentId);
          else if (!pills.has(update.agent.id)) register(update.agent);
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!stopped) console.error("goal-mode: agent observation failed", error);
    });

  const poll = async () => {
    try {
      const { goals: list } = await client.rpc(listGoalsRpc, {});
      const before = new Map(goals);
      goals.clear();
      for (const goal of list) goals.set(goal.agentId, goal);
      for (const [agentId, registration] of pills) {
        const prev = before.get(agentId);
        const next = goals.get(agentId);
        if (prev?.updatedAt === next?.updatedAt && prev?.round === next?.round) continue;
        const workspaceId = workspaces.get(agentId);
        if (workspaceId) registration.update(describe(agentId, workspaceId));
      }
    } catch {
      // The daemon may be reconnecting; the next poll catches up.
    }
  };
  const timer = setInterval(() => void poll(), POLL_MS);
  void poll();

  return () => {
    stopped = true;
    lifetime.abort();
    clearInterval(timer);
    for (const id of [...pills.keys()]) unregister(id);
  };
}
