import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

// The hook timeline is the whole conversation; only what follows the latest user message
// belongs to the turn that just ended.
export function turnOutput(timeline: readonly AgentTimelineItem[]): { output: string; errors: string[] } {
  let start = 0;
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i]!.type === "user_message") {
      start = i + 1;
      break;
    }
  }
  let output = "";
  const errors: string[] = [];
  for (const item of timeline.slice(start)) {
    if (item.type === "assistant_message") output += item.text;
    else if (item.type === "error") errors.push(item.message);
    else if (item.type === "notification" && item.level === "error") errors.push(item.message);
  }
  return { output, errors };
}
