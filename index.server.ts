import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createDaemonAccess } from "./server/daemon-access";
import { GoalRunner } from "./server/runner";
import { loadGoals, saveGoals } from "./server/store";
import { turnOutput } from "./server/turn";
import { controlGoalRpc, getGoalRpc, listGoalsRpc, setGoalRpc } from "./shared/goal";

export default function contribute(server: PluginServerContext) {
  const daemon = createDaemonAccess();
  const runner = new GoalRunner({
    load: loadGoals,
    save: saveGoals,
    now: Date.now,
    log: (message) => console.log(message),
    send: daemon.send,
    agentState: daemon.agentState,
    appendCard: daemon.appendCard,
  });

  server.on("agent.turn_started", (event, context) => {
    daemon.attach(context.paseo);
    runner.onTurnStarted(event.agent.id);
  });
  server.on("agent.turn_ended", (event, context) => {
    daemon.attach(context.paseo);
    runner.onTurnEnded(event.agent.id, {
      outcome: event.outcome,
      ...turnOutput(event.timeline),
      now: new Date(),
    });
  });
  server.on("agent.archived", (event, context) => {
    daemon.attach(context.paseo);
    runner.onArchived(event.agent.id);
  });

  server.handle(setGoalRpc, (input, context) => {
    daemon.attach(context.paseo);
    return runner.set(input);
  });
  server.handle(getGoalRpc, (input, context) => {
    daemon.attach(context.paseo);
    return { goal: runner.get(input.agentId) };
  });
  server.handle(listGoalsRpc, (_input, context) => {
    daemon.attach(context.paseo);
    return { goals: runner.list() };
  });
  server.handle(controlGoalRpc, async (input, context) => {
    daemon.attach(context.paseo);
    return { goal: await runner.control(input.agentId, input.action) };
  });

  runner.start();
  return async () => {
    runner.stop();
    await daemon.close();
  };
}
