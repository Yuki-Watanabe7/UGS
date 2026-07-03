import type { SimParams } from "./types";

export const DEFAULT_PARAMS: SimParams = {
  populationSize: 14,
  groupConfirmSize: 3,
  numLeaders: 1,
  overallWillingness: 0.55,
  ambiguityDuration: 1.0,
  lateJoinEase: 0.5,
  existingTieStrength: 0.3,
  observerAmbiguityTolerance: 0.25,
  observerInfluenceAvoidance: 0.9,
  observerLeaveEase: 0.6,
};

export type ScenarioPreset = {
  id: string;
  name: string;
  description: string;
  params: SimParams;
};

export const PRESETS: ScenarioPreset[] = [
  {
    id: "natural",
    name: "1. 自然に二次会が成立する場",
    description:
      "主導者がいて、二次会意欲の高い人も複数いる。observerJoinerも参加しやすい標準的なケース。",
    params: {
      ...DEFAULT_PARAMS,
      numLeaders: 2,
      overallWillingness: 0.7,
      lateJoinEase: 0.6,
      existingTieStrength: 0.2,
    },
  },
  {
    id: "ambiguous-dissolve",
    name: "2. 曖昧なまま解散する場",
    description:
      "主導者がおらず、皆が様子見のまま時間切れになる。observerJoinerは帰宅しやすい。",
    params: {
      ...DEFAULT_PARAMS,
      numLeaders: 0,
      overallWillingness: 0.35,
      ambiguityDuration: 0.6,
      lateJoinEase: 0.3,
      existingTieStrength: 0.2,
    },
  },
  {
    id: "strong-leader",
    name: "3. 強い主導者が場を作る場",
    description:
      "一人の強い主導者が早期に核を作り、多くの人がそこに引き寄せられる。",
    params: {
      ...DEFAULT_PARAMS,
      numLeaders: 1,
      overallWillingness: 0.6,
      lateJoinEase: 0.55,
      existingTieStrength: 0.15,
    },
  },
  {
    id: "late-join-culture",
    name: "4. 後乗りしやすい文化",
    description:
      "すでに形成されたグループへの参加コストが低い。observerJoinerが参加しやすい。",
    params: {
      ...DEFAULT_PARAMS,
      numLeaders: 1,
      overallWillingness: 0.55,
      lateJoinEase: 0.85,
      existingTieStrength: 0.15,
    },
  },
  {
    id: "leftover-free-grouping",
    name: "5. 自由グループ作りで余りやすい場",
    description:
      "全体をまとめる主導者はおらず、既存の仲良しグループだけが自然に固まっていく。既存の関係性が強く、後から混ざる余地が少ない。observerJoinerが孤立しやすい。",
    params: {
      ...DEFAULT_PARAMS,
      numLeaders: 0,
      overallWillingness: 0.5,
      lateJoinEase: 0.2,
      existingTieStrength: 0.85,
    },
  },
];

export function getPresetById(id: string): ScenarioPreset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}
