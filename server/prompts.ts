import type { Goal } from "../shared/goal";

const STATUS_RULES = `每一轮结束时，在回复最后单独输出状态块，格式必须原样如下：
<goal-status>
state: continuing | achieved
evidence: 一两句话，说明本轮做了什么，或为什么判断已达成
</goal-status>
- continuing：还有工作要做。系统会自动发下一轮，一直循环，直到你报告 achieved。
- achieved：只有每一条验收标准都已实际验证（运行过命令、测试或检查过产物）时才用。这是结束目标的唯一方式。
- 这期间没有人会回答你。缺信息就做最合理的假设并写明；一条路走不通就换一条，或先做其他能做的部分。不要停下来等我，也不要把没做完的说成做完。`;

function goalBody(goal: Goal): string {
  return `## 目标\n${goal.objective}\n\n## 验收标准\n${goal.acceptance}`;
}

export function startPrompt(goal: Goal): string {
  return `[目标模式] 请自主推进下面的目标，直到验收标准全部满足。中途不要停下来等我确认：能自己判断的就自己决定，把关键决定写进回复。

${goalBody(goal)}

${STATUS_RULES}`;
}

export function continuePrompt(goal: Goal, why: "next" | "limit" | "retry" | "resume" | "missing" | "blocked"): string {
  const lead = {
    next: "继续推进目标。",
    limit: "额度已恢复，从中断处继续推进目标。",
    retry: "上一轮因服务端临时错误中断，从中断处继续推进目标。",
    resume: "目标模式已恢复，继续推进目标。",
    missing: "上一轮回复末尾缺少状态块。继续推进目标，并记得在本轮结束时输出状态块。",
    blocked: `上一轮你说受阻：${goal.lastEvidence ?? "（没写原因）"}
没有人会来处理这个阻碍。绕开它：做最合理的假设、换一种方法、自己找到或造出缺的东西，或先推进其他验收项。`,
  }[why];
  return `[目标模式 · 第 ${goal.round + 1} 轮] ${lead}先简要核对当前进度（已经完成的不要重做），再做下一步。

${goalBody(goal)}

${STATUS_RULES}`;
}

export function verifyPrompt(goal: Goal): string {
  return `[目标模式 · 验收] 你报告目标已达成。现在逐条对照验收标准做最终核验：每一条都要给出实际证据（命令及输出、测试结果、文件路径等），不要只凭记忆判断。发现任何一条没有满足，就继续把它做完。

${goalBody(goal)}

最后输出状态块：全部验证通过用 achieved；有未完成项就用 continuing，系统会继续让你做。
${STATUS_RULES}`;
}
