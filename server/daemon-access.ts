// The SDK hands a plugin its daemon session only inside hook and RPC callbacks. A goal waiting
// out a usage limit after a daemon restart may see neither, so until one arrives we talk to the
// local daemon through the Paseo CLI client, the same way the CLI does.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import { GOAL_CARD_KIND, type GoalCard } from "../shared/goal";
import type { AgentState } from "./runner";

type PaseoApi = PluginHookContext["paseo"];

interface CliDaemonClient {
  fetchAgent(agentId: string): Promise<unknown>;
  sendAgentMessage(agentId: string, text: string): Promise<void>;
  close(): Promise<void>;
}

interface AgentSnapshot {
  status?: string;
  archivedAt?: string | null;
  workspaceId?: string | null;
  pendingPermissions?: readonly unknown[] | null;
}

const PASEO_HOME = process.env.PASEO_HOME || path.join(homedir(), ".paseo");
const CLI_CLIENT = path.join("node_modules", "@getpaseo", "cli", "dist", "utils", "client.js");
const CLI_CLIENT_CANDIDATES = [
  path.join(process.cwd(), CLI_CLIENT),
  path.join(PASEO_HOME, "tools", "goal-mode", CLI_CLIENT),
  path.join(homedir(), ".paseo", "tools", "goal-mode", CLI_CLIENT),
  path.join(homedir(), ".paseo", "tools", "codex-sync", "runtime", CLI_CLIENT),
];

// Kept out of esbuild's reach so the module loads from disk at runtime.
const importFromDisk = new Function("url", "return import(url)") as (url: string) => Promise<{
  connectToDaemon(options: { target: { kind: "instance"; home: string } }): Promise<CliDaemonClient>;
}>;

function toState(agent: AgentSnapshot | null | undefined): AgentState | null {
  // "closed" only means the session is not loaded (e.g. after a daemon restart); a send reopens it.
  if (!agent || agent.archivedAt) return null;
  return {
    busy: agent.status === "running" || agent.status === "initializing",
    awaitingPermission: (agent.pendingPermissions?.length ?? 0) > 0,
    workspaceId: agent.workspaceId ?? null,
  };
}

export function createDaemonAccess() {
  let paseo: PaseoApi | null = null;
  let fallback: Promise<CliDaemonClient> | null = null;

  async function cli(): Promise<CliDaemonClient> {
    fallback ??= (async () => {
      const file = CLI_CLIENT_CANDIDATES.find((candidate) => existsSync(candidate));
      if (!file) throw new Error("goal-mode: Paseo CLI client not found for the fallback connection");
      console.log(`goal-mode: no plugin session yet, connecting through ${file}`);
      const { connectToDaemon } = await importFromDisk(pathToFileURL(file).href);
      return connectToDaemon({ target: { kind: "instance", home: PASEO_HOME } });
    })().catch((error: unknown) => {
      fallback = null;
      throw error;
    });
    return fallback;
  }

  async function dropFallback(): Promise<void> {
    const pending = fallback;
    fallback = null;
    if (pending) await pending.then((client) => client.close()).catch(() => {});
  }

  return {
    attach(api: PaseoApi): void {
      if (paseo === api) return;
      paseo = api;
      // A send may still be in flight on the fallback (its turn start is often what brings the
      // plugin session), so close it a little later.
      if (fallback) setTimeout(() => void (paseo && dropFallback()), 60_000).unref?.();
    },

    async send(agentId: string, text: string): Promise<void> {
      if (paseo) return paseo.agents.ref(agentId).send(text);
      await (await cli()).sendAgentMessage(agentId, text);
    },

    async agentState(agentId: string): Promise<AgentState | null> {
      if (paseo) {
        const result = await paseo.agents.ref(agentId).refresh();
        return toState(result?.agent as AgentSnapshot | undefined);
      }
      const result = (await (await cli()).fetchAgent(agentId)) as { agent?: AgentSnapshot } | null;
      return toState(result?.agent ?? (result as AgentSnapshot | null));
    },

    async appendCard(agentId: string, rowId: string, card: GoalCard): Promise<void> {
      // Plugin rows need the plugin session; without one the card is skipped, the goal state
      // (and its event log in the goal panel) still records the event.
      if (!paseo) return;
      await paseo.agents.ref(agentId).timeline.append({
        type: "plugin",
        id: rowId,
        kind: GOAL_CARD_KIND,
        version: 1,
        data: card,
      });
    },

    close: dropFallback,
  };
}
