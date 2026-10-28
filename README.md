# paseo-goal-mode

Goal mode for [Paseo](https://github.com/getpaseo/paseo). Give an agent a goal and acceptance criteria. It keeps working, round after round, until it reports the goal achieved and then passes a separate verification round. It works with every Paseo provider: Claude Code, Codex, Command Code and any ACP agent.

It is a Paseo plugin. It loads into a running daemon, so you don't need to rebuild or restart Paseo. The UI appears in every connected client, including the phone app.

[中文说明](#中文说明)

## Usage

- Tap the **Goal** pill under any agent's composer, or type `/goal`, to open the goal panel.
- One-liner: `/goal migrate X to the new API 验收: 1. build passes 2. all tests pass`
- `/goal pause`, `/goal resume`, `/goal clear` (Chinese aliases 暂停 / 继续 / 清除 also work).

The pill shows the state: round N, verifying, waiting for quota until HH:MM, needs you, achieved, stopped. Goal cards in the timeline record when the goal started, verified, waited and stopped.

## How a round is judged

Every reply must end with a status block:

```
<goal-status>
state: continuing | achieved
evidence: what this round did, or why the goal is met
</goal-status>
```

- `continuing`: the next round is sent automatically. A missing block also continues, with a reminder to add it.
- `achieved`: a verification round is sent, asking the agent to check every criterion with real evidence. The goal ends only if the verification round reports `achieved` again.
- There is no "blocked" exit. Nobody answers while the goal runs, so a report of being blocked gets a round asking the agent to work around the blocker.

## Failure handling

| Situation | What happens |
| --- | --- |
| Usage limit (5-hour, weekly, 429, quota exhausted; English and Chinese messages) | Parses the reset time and resumes 1 minute after it; retries in 30 min if no time is found |
| Model at capacity | Retries every 15 s, then every 30 min after 240 tries |
| Transient errors (5xx, gateway, timeout, dropped stream, 403) | Exponential backoff from 30 s to 30 min, never gives up |
| Account banned or disabled | Stops sending |
| 401, invalid key, re-login required | Stops sending |
| You interrupt a turn | Pauses; your next message is taken as a correction and the goal resumes with it |
| Round cap reached (default 1000) | Pauses; `resume` grants another batch |

If another tool has already resumed the agent, the plugin does not send a duplicate message.

## Design

- `server/runner.ts`: the per-agent state machine, driven by Paseo's `agent.turn_ended` hook.
- `server/classify.ts` and `server/usage-limit.ts`: classify turn errors and extract reset times from provider messages.
- `server/prompts.ts`: start, continue and verify prompts.
- `server/store.ts`: state lives in `$PASEO_HOME/goal-mode/goals.json`, so pending waits survive a daemon restart.
- `server/daemon-access.ts`: the plugin SDK only provides a daemon session inside hook and RPC callbacks. After a restart with no events yet, the plugin connects through `@getpaseo/cli`'s local client.
- `client/`: the goal panel, composer pill and timeline cards (React Native, shared by desktop and mobile).

## Install

Requires Paseo >= 0.10.2 with `"pluginsEnabled": true` in `~/.paseo/config.json`.

```sh
git clone https://github.com/4ward2/paseo-goal-mode
cd paseo-goal-mode && npm install
paseo plugin install /path/to/paseo-goal-mode
paseo plugin reload goal-mode   # after changing code
```

Codex's built-in `/goal` is replaced by this plugin's `/goal` inside Paseo.

## Develop

```sh
npm test           # state machine and error classification (node:test, 23 cases)
npm run typecheck
```

## License

MIT

---

## 中文说明

给 Agent 一个目标和验收标准，它会一轮接一轮自动推进。Agent 报告达成后，还要再通过一轮逐条验收，目标才算结束。对 Claude Code、Codex、Command Code 等所有提供方都适用。以 Paseo 插件形式加载，不用重新编译或重启 daemon，手机端也能看到界面。

- 打开方式：点输入框下方的 **目标** 胶囊，或输入 `/goal`
- 一行设定：`/goal 把 xx 迁移到新接口 验收：1. 构建通过 2. 测试全过`
- 控制命令：`/goal pause` / `resume` / `clear`，也可以用 暂停 / 继续 / 清除
- 每轮回复末尾输出 `<goal-status>` 状态块。只有 `achieved` 并通过验收轮才会结束
- 用量上限、模型满载、临时错误都会自动等待或重试，账号被封或密钥失效时停止，详见上文的表格
