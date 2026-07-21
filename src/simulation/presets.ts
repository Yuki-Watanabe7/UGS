import type { SimParams } from "./types";
import { DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK, DEFAULT_CLASSROOM_PAIR_GROUP_SIZE } from "./formationPolicy";
import type { FormationScenarioId, GroupSizeRule } from "./formationPolicy";

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
  /**
   * Issue #132 (Phase 2): このプリセットが使うグループ形成ポリシー。省略時は既存プリセットとの
   * 後方互換として`afterParty`(engine.ts/formationPolicy.tsのfall back既定値と同じ)。
   */
  formationScenarioId?: FormationScenarioId;
  /** `formationScenarioId: "classroomPair"`のプリセットでのみ参照される終了deadline tick */
  formationDeadlineTick?: number;
  /**
   * Issue #155 (Phase 4): `formationScenarioId: "classroomPair"`のプリセットでのみ参照される
   * 成立最小人数・収容最大人数。省略時は`DEFAULT_CLASSROOM_PAIR_GROUP_SIZE`(2人固定、既存の
   * `classroom-pair`との後方互換)。#154で一般化した`GroupSizeRule`をそのままプリセット側に
   * 露出させることで、3人班・4人班(固定、min===max)・3〜4人班(可変定員、min<max)を
   * 単に人数違いのプリセットとして追加できる。
   */
  formationClassroomGroupSize?: GroupSizeRule;
};

export const PRESETS: ScenarioPreset[] = [
  {
    id: "natural",
    name: "自然に二次会が成立する場",
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
    name: "曖昧なまま解散する場",
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
    name: "強い主導者が場を作る場",
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
    name: "後乗りしやすい文化",
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
    name: "自由グループ作りで余りやすい場",
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
  {
    id: "classroom-pair",
    name: "教室で自由にペアを作る場",
    description:
      "先生が「自由にペアを作ってください」と指示する教室。2人定員の複数ペアが並行して形成され、" +
      "退出はできない。全員割当か締切tickの到達で終了し、人数が奇数なら1人は未割当のまま残り得る。" +
      "observerJoiner相当の人は自分からは誘わず、誘われるのを待ちやすい。",
    params: {
      ...DEFAULT_PARAMS,
      populationSize: 20,
      groupConfirmSize: 2,
      numLeaders: 0,
      overallWillingness: 0.8,
      existingTieStrength: 0.3,
    },
    formationScenarioId: "classroomPair",
    formationDeadlineTick: DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK,
    formationClassroomGroupSize: DEFAULT_CLASSROOM_PAIR_GROUP_SIZE,
  },
  {
    id: "classroom-group-3",
    name: "教室で自由に3人班を作る場",
    description:
      "先生が「3人班を作ってください」と指示する教室。3人固定の複数班が並行して形成され、" +
      "退出はできない。全員割当か締切tickの到達で終了する。生徒数20人は3人で割り切れないため、" +
      "最大2人が班に入れないまま未割当で残り得る(構造的未割当)。" +
      "observerJoiner相当の人は自分からは誘わず、誘われるのを待ちやすい。",
    params: {
      ...DEFAULT_PARAMS,
      populationSize: 20,
      groupConfirmSize: 3,
      numLeaders: 0,
      overallWillingness: 0.8,
      existingTieStrength: 0.3,
    },
    formationScenarioId: "classroomPair",
    formationDeadlineTick: DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK,
    formationClassroomGroupSize: { minGroupSize: 3, maxGroupSize: 3 },
  },
  {
    id: "classroom-group-4",
    name: "教室で自由に4人班を作る場",
    description:
      "先生が「4人班を作ってください」と指示する教室。4人固定の複数班が並行して形成され、" +
      "退出はできない。全員割当か締切tickの到達で終了する。生徒数22人は4人で割り切れないため、" +
      "最大3人が班に入れないまま未割当で残り得る(構造的未割当)。3人班より1人あたりの相手探しに" +
      "時間がかかりやすく、成立までのtickが延びる様子を観察できる。",
    params: {
      ...DEFAULT_PARAMS,
      populationSize: 22,
      groupConfirmSize: 4,
      numLeaders: 0,
      overallWillingness: 0.8,
      existingTieStrength: 0.3,
    },
    formationScenarioId: "classroomPair",
    formationDeadlineTick: DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK,
    formationClassroomGroupSize: { minGroupSize: 4, maxGroupSize: 4 },
  },
  {
    id: "classroom-group-3-4",
    name: "教室で自由に3〜4人班を作る場",
    description:
      "先生が「3〜4人班を作ってください」と指示する教室。最小3人で成立し、4人まで受け入れる" +
      "可変定員の班が並行して形成される。3人固定・4人固定と異なり、生徒数23人でも構造的な" +
      "未割当は生じない(3人班と4人班を組み合わせて全員を吸収できるため)。3人で成立済み・" +
      "まだ4人目を受け入れられる「空きあり」の班と、4人で満員になった班の違いを観察できる。",
    params: {
      ...DEFAULT_PARAMS,
      populationSize: 23,
      groupConfirmSize: 3,
      numLeaders: 0,
      overallWillingness: 0.8,
      existingTieStrength: 0.3,
    },
    formationScenarioId: "classroomPair",
    formationDeadlineTick: DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK,
    formationClassroomGroupSize: { minGroupSize: 3, maxGroupSize: 4 },
  },
];

export function getPresetById(id: string): ScenarioPreset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}
