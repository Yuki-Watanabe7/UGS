import type { SimParams } from "../simulation/types";

/**
 * "immediate": 実行中のシミュレーションにも次tickから反映される。
 * "resetRequired": 既存エージェント生成時にのみ使われるため、Reset(または
 * シード/プリセット変更による再生成)を行わないと現在の状態には反映されない。
 */
export type ApplyMode = "immediate" | "resetRequired";

export type SliderDef = {
  key: keyof SimParams;
  label: string;
  min: number;
  max: number;
  step: number;
  applyMode: ApplyMode;
};

export const SLIDERS: SliderDef[] = [
  { key: "populationSize", label: "人数", min: 5, max: 30, step: 1, applyMode: "resetRequired" },
  { key: "groupConfirmSize", label: "二次会成立に必要な人数", min: 2, max: 8, step: 1, applyMode: "immediate" },
  { key: "numLeaders", label: "主導者の人数", min: 0, max: 4, step: 1, applyMode: "resetRequired" },
  { key: "overallWillingness", label: "全体の二次会意欲", min: 0, max: 1, step: 0.05, applyMode: "resetRequired" },
  { key: "ambiguityDuration", label: "曖昧な時間の長さ(耐えられる長さ)", min: 0.3, max: 2, step: 0.1, applyMode: "immediate" },
  { key: "lateJoinEase", label: "後乗り参加のしやすさ", min: 0, max: 1, step: 0.05, applyMode: "immediate" },
  { key: "existingTieStrength", label: "既存関係性の強さ", min: 0, max: 1, step: 0.05, applyMode: "resetRequired" },
  { key: "observerAmbiguityTolerance", label: "observerJoinerの曖昧さ耐性", min: 0, max: 1, step: 0.05, applyMode: "resetRequired" },
  { key: "observerInfluenceAvoidance", label: "observerJoinerの影響回避度", min: 0, max: 1, step: 0.05, applyMode: "resetRequired" },
  { key: "observerLeaveEase", label: "observerJoinerの帰宅しやすさ", min: 0, max: 1, step: 0.05, applyMode: "resetRequired" },
];

/** Resetしないと現在のシミュレーション状態に反映されないパラメータのキー一覧 */
export const RESET_REQUIRED_PARAM_KEYS: (keyof SimParams)[] = SLIDERS.filter(
  (slider) => slider.applyMode === "resetRequired",
).map((slider) => slider.key);

export const APPLY_MODE_LABEL: Record<ApplyMode, string> = {
  immediate: "即時反映",
  resetRequired: "Resetで反映",
};
