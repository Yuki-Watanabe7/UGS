import type { ExpressionIntent } from "../simulation/expression";
import type { ThoughtBubbleDisplay } from "./SimulationCanvas";

/** 心の声の表示対象の絞り込み。Issue #66「表示対象の絞り込み」の3択(選択中フィルタは既存の選択概念がないため対象外) */
export type ExpressionDisplayTarget = "all" | "observerJoiner" | "important";

/** 表示密度プリセット。詳細な同時表示数の数値入力はユーザーに求めない */
export type ExpressionDisplayDensity = "few" | "standard" | "many";

export type ExpressionDisplaySettingsState = {
  enabled: boolean;
  target: ExpressionDisplayTarget;
  density: ExpressionDisplayDensity;
};

export const DEFAULT_EXPRESSION_DISPLAY_SETTINGS: ExpressionDisplaySettingsState = {
  enabled: true,
  target: "all",
  density: "standard",
};

/** `standard`は既存のCanvas同時表示上限(`MAX_CONCURRENT_BUBBLES`)と同じ値に揃える */
export const EXPRESSION_DISPLAY_DENSITY_MAX_CONCURRENT: Record<ExpressionDisplayDensity, number> = {
  few: 2,
  standard: 4,
  many: 6,
};

/**
 * 「重要イベントのみ」に該当するintent。`expression.ts`の状態遷移由来イベント
 * (deriveStateTransitionEvent: 参加・離脱等の一度きりの出来事)と招待通知を「重要」とし、
 * 継続的な状況を表すもの(stressRising/hesitating/watching。cooldownで繰り返し出うる)は
 * 「重要」から外す。あくまで表示層での分類であり、シミュレーション側の優先度(priority)とは独立。
 */
const IMPORTANT_INTENTS = new Set<ExpressionIntent>([
  "consideringJoining",
  "approachingGroup",
  "joinedGroup",
  "givingUpWaiting",
  "leftEvent",
  "noticedInvitation",
  "consideringLeaving",
]);

/**
 * 表示対象設定に基づき、既に競合・混雑制御を経た`thoughts`をさらに絞り込む純粋関数。
 * シミュレーションstate・ログには一切触れない(表示層だけの後段フィルタ)。
 */
export function filterThoughtsForDisplay(
  thoughts: ThoughtBubbleDisplay[],
  target: ExpressionDisplayTarget,
): ThoughtBubbleDisplay[] {
  switch (target) {
    case "all":
      return thoughts;
    case "observerJoiner":
      return thoughts.filter((thought) => thought.isObserverJoiner === true);
    case "important":
      return thoughts.filter((thought) => thought.intent !== undefined && IMPORTANT_INTENTS.has(thought.intent));
  }
}
