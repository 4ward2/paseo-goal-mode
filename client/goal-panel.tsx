import { type PluginAgentPanelProps, useRpc } from "@getpaseo/plugin/client";
import { ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  ACTIVE_STATUSES,
  controlGoalRpc,
  DEFAULT_MAX_ROUNDS,
  type Goal,
  getGoalRpc,
  setGoalRpc,
} from "../shared/goal";
import { clock, STATUS_LABEL } from "./labels";

export function GoalPanel({ agentId, theme, layout }: PluginAgentPanelProps) {
  const getGoal = useRpc(getGoalRpc);
  const setGoal = useRpc(setGoalRpc);
  const controlGoal = useRpc(controlGoalRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const queryKey = ["goal", agentId];
  const { data, error } = useQuery({
    queryKey,
    queryFn: () => getGoal({ agentId }),
    refetchInterval: 3000,
  });
  const goal = data?.goal ?? null;
  const active = goal !== null && ACTIVE_STATUSES.includes(goal.status);

  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [maxRounds, setMaxRounds] = useState(String(DEFAULT_MAX_ROUNDS));
  useEffect(() => {
    if (!goal || editing) return;
    setObjective(goal.objective);
    setAcceptance(goal.acceptance);
    setMaxRounds(String(goal.maxRounds));
  }, [goal?.id]);

  const refresh = (next: Goal | null) => queryClient.setQueryData(queryKey, { goal: next });
  const start = useMutation({
    mutationFn: () =>
      setGoal({
        agentId,
        objective,
        acceptance,
        maxRounds: Number.parseInt(maxRounds, 10) || DEFAULT_MAX_ROUNDS,
      }),
    onSuccess: (next) => {
      refresh(next);
      setEditing(false);
      toast.show("目标已开始", { variant: "success" });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
  const control = useMutation({
    mutationFn: (action: "pause" | "resume" | "clear") => controlGoal({ agentId, action }),
    onSuccess: ({ goal: next }) => refresh(next),
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const s = useMemo(
    () => ({
      root: { flex: 1, backgroundColor: theme.colors.surface0 },
      body: { padding: layout.compact ? 16 : 20, gap: 14 },
      h: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
      label: { color: theme.colors.foregroundMuted, fontSize: 12 },
      text: { color: theme.colors.foreground, fontSize: 14 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      input: {
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 10,
        fontSize: 14,
        minHeight: 44,
        textAlignVertical: "top" as const,
      },
      row: { flexDirection: "row" as const, gap: 8, flexWrap: "wrap" as const },
      primary: { backgroundColor: theme.colors.accent, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16 },
      primaryText: { color: theme.colors.accentForeground, fontWeight: "600" as const },
      secondary: { borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16 },
      secondaryText: { color: theme.colors.foreground },
      card: { backgroundColor: theme.colors.surface1, borderRadius: 10, padding: 12, gap: 6 },
      status: {
        color: goal?.status === "achieved" ? theme.colors.statusSuccess
          : goal?.status === "stopped" ? theme.colors.statusDanger
          : goal && !active ? theme.colors.statusWarning
          : theme.colors.accent,
        fontWeight: "700" as const,
        fontSize: 15,
      },
      error: { color: theme.colors.statusDanger },
    }),
    [theme, layout.compact, goal?.status, active],
  );

  const showForm = !goal || editing;
  const canStart = objective.trim().length > 0 && acceptance.trim().length > 0 && !start.isPending;

  return (
    <ScrollView style={s.root} contentContainerStyle={s.body}>
      {error ? <Text style={s.error}>{error instanceof Error ? error.message : String(error)}</Text> : null}

      {goal && !editing ? (
        <View style={s.card}>
          <Text style={s.status}>
            {STATUS_LABEL[goal.status]} · 第 {goal.round}/{goal.maxRounds} 轮
          </Text>
          {goal.resumeAt ? <Text style={s.muted}>预计恢复：{clock(goal.resumeAt)}</Text> : null}
          {goal.reason ? <Text style={s.muted} selectable>原因：{goal.reason}</Text> : null}
          {goal.lastEvidence ? (
            <Text style={s.muted} selectable numberOfLines={8}>最近进展：{goal.lastEvidence}</Text>
          ) : null}
          <Text style={s.label}>目标</Text>
          <Text style={s.text} selectable>{goal.objective}</Text>
          <Text style={s.label}>验收标准</Text>
          <Text style={s.text} selectable>{goal.acceptance}</Text>
          <View style={s.row}>
            {active ? (
              <Button style={s.secondary} textStyle={s.secondaryText} label="暂停" onPress={() => control.mutate("pause")} />
            ) : (
              <Button style={s.primary} textStyle={s.primaryText} label="继续推进" onPress={() => control.mutate("resume")} />
            )}
            <Button style={s.secondary} textStyle={s.secondaryText} label="修改目标" onPress={() => setEditing(true)} />
            <Button style={s.secondary} textStyle={s.secondaryText} label="清除" onPress={() => control.mutate("clear")} />
          </View>
        </View>
      ) : null}

      {showForm ? (
        <View style={{ gap: 10 }}>
          <Text style={s.h}>{goal ? "修改目标（会重新开始计轮）" : "设定目标"}</Text>
          <Text style={s.label}>目标：要做成什么</Text>
          <TextInput style={[s.input, { minHeight: 90 }]} multiline value={objective} onChangeText={setObjective} placeholder="例如：把 xx 模块迁移到新接口，并让所有调用方通过编译" placeholderTextColor={theme.colors.foregroundMuted} />
          <Text style={s.label}>验收标准：怎样算完成（逐条写，越具体越好）</Text>
          <TextInput style={[s.input, { minHeight: 90 }]} multiline value={acceptance} onChangeText={setAcceptance} placeholder={"1. npm run build 通过\n2. 相关测试全部通过\n3. 文档已更新"} placeholderTextColor={theme.colors.foregroundMuted} />
          <Text style={s.label}>最多轮数</Text>
          <TextInput style={s.input} keyboardType="number-pad" value={maxRounds} onChangeText={setMaxRounds} />
          <View style={s.row}>
            <Button style={[s.primary, !canStart && { opacity: 0.5 }]} textStyle={s.primaryText} label={start.isPending ? "提交中…" : "开始"} onPress={() => canStart && start.mutate()} />
            {editing ? <Button style={s.secondary} textStyle={s.secondaryText} label="取消" onPress={() => setEditing(false)} /> : null}
          </View>
          <Text style={s.muted}>
            开始后 Agent 会一轮接一轮自动推进；碰到用量上限会等恢复后继续，临时错误自动重试，账号被封或登录失效会停下。Agent
            报告达成后还会再做一轮逐条验收。
          </Text>
        </View>
      ) : null}

      {goal && goal.events.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Text style={s.h}>记录</Text>
          {goal.events.slice(-30).reverse().map((event, index) => (
            <Text key={`${event.at}-${index}`} style={s.muted} selectable>
              {clock(event.at)}  {event.kind}  {event.detail}
            </Text>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

function Button(props: { label: string; onPress: () => void; style: object; textStyle: object }) {
  return (
    <Pressable accessibilityRole="button" onPress={props.onPress} style={props.style}>
      <Text style={props.textStyle}>{props.label}</Text>
    </Pressable>
  );
}
