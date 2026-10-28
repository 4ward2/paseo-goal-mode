// Recognizes provider usage-limit errors (Claude Code and other Anthropic-compatible
// relays) and pulls the reset time out of the message. Messages arrive in English or Chinese,
// with a unix timestamp, an absolute datetime, a wall-clock time, or a relative duration.

export interface UsageLimitMatch {
  /** Epoch ms when the limit resets, or null when the message names no time. */
  resetAt: number | null;
}

// Error text longer than this is ordinary assistant prose that happens to mention limits.
const MAX_ERROR_TEXT_LENGTH = 600;
const SYSTEM_ERROR_PREFIX = "[System Error]";
const MODEL_CAPACITY_ERROR =
  /^\s*\[System Error\]\s*Selected model is at capacity\. Please try a different model\.\s*$/i;

const LIMIT_PATTERNS: readonly RegExp[] = [
  /usage limit/i,
  /rate[ _-]?limit/i,
  /limit (?:reached|exceeded|hit)/i,
  /(?:reached|hit|exceeded) (?:your|the) (?:\w+[ -])?limit/i,
  /(?:5|five)[- ]hour limit/i,
  /(?:weekly|daily|session) limit/i,
  /quota (?:exceeded|exhausted)/i,
  /exceeded your (?:current )?quota/i,
  /too many requests/i,
  /API Error:?\s*429/i,
  /(?:用量|额度|限额|配额|使用量|次数|速率|频率|请求).{0,8}(?:上限|限制|已用尽|用尽|用完|耗尽|超出|超过|超限|达到)/,
  /(?:达到|已达|超出|超过).{0,8}(?:上限|限额|额度|配额)/,
  /请求过于频繁|触发限流|已被限流/,
];

export function isUsageLimitErrorCandidate(input: { text: string; isError: boolean }): boolean {
  const text = input.text.trim();
  if (!text) return false;
  return (
    input.isError || text.startsWith(SYSTEM_ERROR_PREFIX) || text.length <= MAX_ERROR_TEXT_LENGTH
  );
}

/**
 * The model-capacity banner is a transient routing failure, not a usage limit.
 * Keep it separate so callers can retry quickly instead of waiting for a
 * quota-reset schedule.
 */
export function isModelCapacityError(text: string): boolean {
  return MODEL_CAPACITY_ERROR.test(text);
}

export function detectUsageLimit(rawText: string, now: Date): UsageLimitMatch | null {
  const text = rawText.replace(SYSTEM_ERROR_PREFIX, "").replace(/\s+/g, " ").trim();
  if (!text || !LIMIT_PATTERNS.some((pattern) => pattern.test(text))) return null;
  return { resetAt: extractResetTime(text, now) };
}

function extractResetTime(text: string, now: Date): number | null {
  return (
    parseUnixTimestamp(text) ??
    parseAbsoluteDateTime(text) ??
    parseRelativeDuration(text, now) ??
    parseEnglishWallClock(text, now) ??
    parseChineseWallClock(text, now)
  );
}

// "Claude AI usage limit reached|1757851200"
function parseUnixTimestamp(text: string): number | null {
  const match = text.match(/\|\s*(\d{10}|\d{13})\b/);
  if (!match) return null;
  const value = Number(match[1]);
  return match[1].length === 10 ? value * 1000 : value;
}

// "resets at 2026-09-14 15:00", "重置时间：2026/09/14 15:00:00", ISO strings with offsets.
function parseAbsoluteDateTime(text: string): number | null {
  const match = text.match(
    /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?[ T]?(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?/,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second, offset] = match;
  const wallClockUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? 0),
  );
  if (!offset) {
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second ?? 0),
    ).getTime();
  }
  if (offset === "Z") return wallClockUtc;
  const sign = offset.startsWith("-") ? -1 : 1;
  const digits = offset.slice(1).replace(":", "");
  const offsetMinutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
  return wallClockUtc - sign * offsetMinutes * 60_000;
}

const DURATION_UNIT_MS: Record<string, number> = {
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  小时: 3_600_000,
  个小时: 3_600_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  分: 60_000,
  分钟: 60_000,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  秒: 1_000,
  秒钟: 1_000,
};

function sumDurations(fragment: string, unitPattern: RegExp): number | null {
  let total = 0;
  let matched = false;
  for (const part of fragment.matchAll(unitPattern)) {
    const unitMs = DURATION_UNIT_MS[part[2].toLowerCase()];
    if (unitMs === undefined) continue;
    total += Number(part[1]) * unitMs;
    matched = true;
  }
  return matched ? total : null;
}

// "resets in 2h 15m", "try again in 45 minutes", "retry after 120 seconds", "3小时20分钟后重置".
function parseRelativeDuration(text: string, now: Date): number | null {
  const english = text.match(
    /(?:in|after)\s+((?:\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i,
  );
  if (english) {
    const ms = sumDurations(
      english[1],
      /(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi,
    );
    if (ms !== null) return now.getTime() + ms;
  }
  const retryAfter = text.match(/retry[- ]after[:\s]+(\d+)\b/i);
  if (retryAfter) return now.getTime() + Number(retryAfter[1]) * 1000;
  const chinese = text.match(/((?:\d+\s*(?:个小时|小时|分钟|分|秒钟|秒)\s*)+)(?:后|之后|以后)/);
  if (chinese) {
    const ms = sumDurations(chinese[1], /(\d+)\s*(个小时|小时|分钟|分|秒钟|秒)/g);
    if (ms !== null) return now.getTime() + ms;
  }
  return null;
}

// "5-hour limit reached ∙ resets 3pm (Asia/Shanghai)", "resets at 15:30", "try again at 9:00 AM".
function parseEnglishWallClock(text: string, now: Date): number | null {
  const match = text.match(
    /(?:resets?|reset at|available (?:again )?at|try again at|until)\s*(?:at|on)?\s*(tomorrow\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i,
  );
  if (!match) return null;
  const [, tomorrow, hourText, minuteText, meridiem, timeZone] = match;
  // A bare number ("resets 5") is too ambiguous to schedule against.
  if (!minuteText && !meridiem) return null;
  let hour = Number(hourText);
  if (meridiem) hour = (hour % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  return nextWallClock({
    hour,
    minute: Number(minuteText ?? 0),
    addDay: Boolean(tomorrow),
    timeZone: timeZone?.trim(),
    now,
  });
}

// "额度已用尽，将于 15:00 重置", "明天下午3点半恢复", "重置时间：18:30".
function parseChineseWallClock(text: string, now: Date): number | null {
  const suffixed = text.match(
    /(明天|明日|今天|今日)?\s*(凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2})\s*(?:[:：]\s*(\d{2})|点\s*(半|\d{1,2}\s*分?)?|时\s*(\d{1,2})?\s*分?)\s*(?:将|会)?\s*(?:重置|恢复|刷新|解除|可用|再试|重试)/,
  );
  const prefixed = text.match(
    /(?:重置|恢复|刷新)(?:时间)?\s*(?:为|于|在|是|[:：])\s*(明天|明日|今天|今日)?\s*(凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2})\s*(?:[:：]\s*(\d{2})|点\s*(半|\d{1,2}\s*分?)?|时\s*(\d{1,2})?\s*分?)/,
  );
  const match = suffixed ?? prefixed;
  if (!match) return null;
  const [, day, period, hourText, colonMinutes, pointMinutes, hourMinutes] = match;
  let hour = Number(hourText);
  if ((period === "下午" || period === "晚上") && hour < 12) hour += 12;
  if (period === "中午" && hour < 11) hour += 12;
  let minute = 0;
  if (colonMinutes) minute = Number(colonMinutes);
  else if (pointMinutes === "半") minute = 30;
  else if (pointMinutes) minute = Number.parseInt(pointMinutes, 10);
  else if (hourMinutes) minute = Number(hourMinutes);
  return nextWallClock({
    hour,
    minute,
    addDay: day === "明天" || day === "明日",
    timeZone: undefined,
    now,
  });
}

function nextWallClock(input: {
  hour: number;
  minute: number;
  addDay: boolean;
  timeZone: string | undefined;
  now: Date;
}): number | null {
  const { hour, minute, addDay, now } = input;
  if (hour > 23 || minute > 59) return null;
  const zone = input.timeZone && isValidTimeZone(input.timeZone) ? input.timeZone : null;
  const today = zone ? zonedDateParts(now.getTime(), zone) : localDateParts(now);
  const at = (dayOffset: number) =>
    zone
      ? zonedWallClockToEpoch({ ...today, day: today.day + dayOffset, hour, minute }, zone)
      : new Date(today.year, today.month, today.day + dayOffset, hour, minute).getTime();
  let candidate = at(addDay ? 1 : 0);
  if (!addDay && candidate <= now.getTime()) candidate = at(1);
  return candidate;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

function localDateParts(date: Date): DateParts {
  return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() };
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    return Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

function zonedFields(epochMs: number, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(epochMs));
  const fields: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") fields[part.type] = Number(part.value);
  }
  return fields;
}

function zonedDateParts(epochMs: number, timeZone: string): DateParts {
  const fields = zonedFields(epochMs, timeZone);
  return { year: fields.year, month: fields.month - 1, day: fields.day };
}

function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const fields = zonedFields(epochMs, timeZone);
  const asUtc = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
  );
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

function zonedWallClockToEpoch(
  parts: DateParts & { hour: number; minute: number },
  timeZone: string,
): number {
  const guess = Date.UTC(parts.year, parts.month, parts.day, parts.hour, parts.minute);
  const firstOffset = zoneOffsetMs(guess, timeZone);
  const candidate = guess - firstOffset;
  const secondOffset = zoneOffsetMs(candidate, timeZone);
  return secondOffset === firstOffset ? candidate : guess - secondOffset;
}
