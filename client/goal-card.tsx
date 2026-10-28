import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";
import type { GoalCard } from "../shared/goal";

export function GoalCardRow({ item, theme }: PluginTimelineItemProps<GoalCard>) {
  const { title, detail, tone } = item.data;
  const styles = useMemo(() => {
    const bar = {
      info: theme.colors.accent,
      success: theme.colors.statusSuccess,
      warning: theme.colors.statusWarning,
      error: theme.colors.statusDanger,
    }[tone];
    return {
      card: {
        borderLeftWidth: 3,
        borderLeftColor: bar,
        backgroundColor: theme.colors.surface1,
        borderRadius: 8,
        paddingVertical: 8,
        paddingHorizontal: 12,
        gap: 4,
        marginVertical: 4,
      },
      title: { color: theme.colors.foreground, fontWeight: "600" as const },
      detail: { color: theme.colors.foregroundMuted, fontSize: 13 },
    };
  }, [theme, tone]);
  return (
    <View style={styles.card}>
      <Text style={styles.title}>🎯 {title}</Text>
      {detail ? (
        <Text style={styles.detail} numberOfLines={12} selectable>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}
