// Turns the end of a turn into a decision for the goal runner. Error text is only read from
// failures, error rows, and short assistant replies without a status block, so an agent that is
// merely writing about rate limits or accounts is not mistaken for a provider error.
import {
  detectUsageLimit,
  isModelCapacityError,
  isUsageLimitErrorCandidate,
} from "./usage-limit";

export type GoalReport = { state: "continuing" | "achieved" | "blocked"; evidence: string };

export type TurnVerdict =
  | { kind: "report"; report: GoalReport | null }
  | { kind: "banned"; message: string }
  | { kind: "auth"; message: string }
  | { kind: "usage_limit"; resetAt: number | null; message: string }
  | { kind: "capacity"; message: string }
  | { kind: "transient"; message: string };

export interface TurnInput {
  outcome:
    | { kind: "completed" }
    | { kind: "failed"; error: { message: string; code?: string } }
    | { kind: "canceled"; reason: string };
  /** Assistant text after the latest user message. */
  output: string;
  /** Error and error-level notification rows after the latest user message. */
  errors: readonly string[];
  now: Date;
}

const BAN_PATTERNS: readonly RegExp[] = [
  /\baccount\b.{0,40}\b(?:disabled|suspended|banned|deactivated|terminated|revoked)\b/i,
  /\b(?:disabled|suspended|banned|deactivated|terminated)\b.{0,20}\b(?:your|this) account\b/i,
  /\borganization\b.{0,30}\b(?:disabled|suspended|banned|deactivated)\b/i,
  /\b(?:usage polic\w*|terms of service|acceptable use)\b.{0,60}\b(?:violat\w*|suspend\w*|disabl\w*|ban\w*)/i,
  /(?:账号|账户|帐号|帐户|组织).{0,8}(?:封禁|封停|被封|停用|冻结|禁用|注销|暂停使用)/,
  /封号|封禁/,
];

const AUTH_PATTERNS: readonly RegExp[] = [
  /invalid (?:x-)?api[ _-]?key/i,
  /authentication_error/i,
  /\b401\b/,
  /\bunauthori[sz]ed\b/i,
  /not (?:authenticated|logged in)/i,
  /please (?:run )?[`'"]?\/?login/i,
  /(?:oauth )?token (?:has )?(?:expired|been revoked)/i,
  /credentials? (?:have |has )?(?:expired|been revoked)/i,
  /登录已过期|未登录|请先登录|重新登录|认证失败|鉴权失败|密钥无效|令牌已过期/,
];

const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /\b5\d{2}\b/,
  /\b403\b|forbidden/i,
  /bad gateway|gateway|upstream/i,
  /stopped (?:unexpectedly|arriving)|exited|exit code|incomplete/i,
  /timed? ?out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EOF|socket hang up|network/i,
  /overloaded|temporarily unavailable|server[- ]side issue|internal server error/i,
  /网关|超时|连接失败|请稍后重试|请检查网络|服务繁忙|服务异常/,
];

const STATUS_BLOCK = /<goal-status>([\s\S]*?)<\/goal-status>/gi;

export function parseGoalReport(output: string): GoalReport | null {
  const blocks = [...output.matchAll(STATUS_BLOCK)];
  const body = blocks.at(-1)?.[1];
  if (body === undefined) return null;
  const state = /state\s*[:：]\s*(continuing|achieved|blocked)/i.exec(body)?.[1]?.toLowerCase();
  if (state !== "continuing" && state !== "achieved" && state !== "blocked") return null;
  const evidence = /evidence\s*[:：]\s*([\s\S]*)/i.exec(body)?.[1]?.trim() ?? "";
  return { state, evidence: evidence.slice(0, 2000) };
}

function firstMatch(patterns: readonly RegExp[], texts: readonly string[]): string | null {
  for (const text of texts) {
    if (patterns.some((pattern) => pattern.test(text))) return text;
  }
  return null;
}

export function classifyTurn(input: TurnInput): TurnVerdict {
  const report = parseGoalReport(input.output);
  const texts: string[] = [...input.errors];
  if (input.outcome.kind === "failed") {
    texts.unshift(`${input.outcome.error.message}${input.outcome.error.code ? ` (${input.outcome.error.code})` : ""}`);
  }
  // A reply with a status block is the agent talking, not the provider failing.
  const reply = input.output.trim();
  if (!report && reply && isUsageLimitErrorCandidate({ text: reply, isError: false })) {
    texts.push(reply);
  }
  const errorTexts = texts.map((text) => text.trim()).filter(Boolean);

  const banned = firstMatch(BAN_PATTERNS, errorTexts);
  if (banned) return { kind: "banned", message: banned };
  const auth = firstMatch(AUTH_PATTERNS, errorTexts);
  if (auth) return { kind: "auth", message: auth };
  for (const text of errorTexts) {
    if (isModelCapacityError(text)) return { kind: "capacity", message: text };
    const limit = detectUsageLimit(text, input.now);
    if (limit) return { kind: "usage_limit", resetAt: limit.resetAt, message: text };
  }
  if (input.outcome.kind === "failed") {
    return { kind: "transient", message: errorTexts[0] ?? "turn failed" };
  }
  // Only error rows count here: a short normal reply may mention "timeout" and still be fine.
  const transient = report ? null : firstMatch(TRANSIENT_PATTERNS, input.errors);
  if (transient) return { kind: "transient", message: transient };
  return { kind: "report", report };
}
