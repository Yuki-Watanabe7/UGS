import type { SimParams } from "./types";
import { clamp } from "./model";

/**
 * 介入シナリオのカテゴリ。
 * - publicCoordination: 場全体に向けた集合・調整の明示化
 * - socialPermission: 「〜してよい」という社会的許可の明示化
 * - targetedSupport: 特定の個人(observerJoiner等)への直接的な働きかけ
 * - timeDesign: 曖昧な時間そのものの長さ・構造の設計
 * - none: 介入なし(通常プリセットそのままの挙動)
 */
export type InterventionCategory =
  | "none"
  | "publicCoordination"
  | "socialPermission"
  | "targetedSupport"
  | "timeDesign";

export type InterventionScenarioId =
  | "none"
  | "explicit-meeting-point"
  | "late-join-ok"
  | "light-observer-invitation"
  | "short-ambiguity-window"
  | "predecided-venue"
  | "anonymous-low-pressure-intent";

/**
 * `SimParams`の一部フィールドに対する単純な加算補正。
 * 既存プリセットの`params`に重ねて適用することを想定した差分値であり、絶対値の上書きではない。
 */
export type InterventionParamAdjustments = Partial<SimParams>;

export type InterventionScenario = {
  id: InterventionScenarioId;
  name: string;
  description: string;
  category: InterventionCategory;
  /** この介入が期待する効果の説明(人間向けの文章。数値的な保証ではない) */
  expectedEffect: string;
  /** `SimParams`への単純な加算補正で近似できる部分。`none`や近似不能な場合は省略 */
  paramAdjustments?: InterventionParamAdjustments;
  /**
   * 単純なパラメータ補正だけでは表現しきれず、engine.ts側に追加ロジックが必要な効果の説明。
   * Phase Cの対応範囲外(型・カタログの整備のみ)のため、ここでは説明のみを持たせ実装はしない。
   */
  engineLogicNotes?: string;
};

/** `runSimulationToEnd`/`runMonteCarlo`等に介入シナリオを渡す際の実行時オプション */
export type InterventionRuntimeOptions = {
  interventionId: InterventionScenarioId;
};

/** 0-1に正規化されているフィールドのうち、加算補正後にクランプすべきもの */
const UNIT_RANGE_KEYS: readonly (keyof SimParams)[] = [
  "overallWillingness",
  "lateJoinEase",
  "existingTieStrength",
  "observerAmbiguityTolerance",
  "observerInfluenceAvoidance",
  "observerLeaveEase",
];

export const NONE_INTERVENTION: InterventionScenario = {
  id: "none",
  name: "介入なし",
  description: "場の設計に対する介入を何も行わない。通常のプリセットのみで進行する。",
  category: "none",
  expectedEffect: "既存プリセットの挙動をそのまま観察するための基準点(ベースライン)。",
};

export const INTERVENTION_SCENARIOS: InterventionScenario[] = [
  NONE_INTERVENTION,
  {
    id: "explicit-meeting-point",
    name: "集合場所の明示",
    description: "幹事が「行く人は店の前に集まりましょう」と、集合場所を明示的にアナウンスする。",
    category: "publicCoordination",
    expectedEffect:
      "どこに向かえばよいかが明確になり、輪を見つけられず様子見のまま留まる時間が減る。後乗りもしやすくなる。",
    paramAdjustments: {
      ambiguityDuration: 0.2,
      lateJoinEase: 0.1,
    },
    engineLogicNotes:
      "「集合場所の一本化」は本来、複数箇所に独立して発生しうるforming候補を1箇所に収束させる効果に近い。" +
      "現行engineは候補地点が自然発生的に分散しうる構造のため、正確に表現するにはengine側で候補地点を統合するロジックが必要。",
  },
  {
    id: "late-join-ok",
    name: "途中参加OKの明示",
    description: "「途中参加OK」「後から合流もOK」と誰かが明示的に宣言する。",
    category: "socialPermission",
    expectedEffect: "後から合流することへの心理的ハードルが下がり、成立済みグループへの参加確率が上がる。",
    paramAdjustments: {
      lateJoinEase: 0.3,
    },
    engineLogicNotes:
      "明示的な許可は、observerJoinerの「行き場がない」ことに起因する追加ストレス" +
      "(engine.tsのhasWelcomingConfirmedGroup判定)を直接緩和しうるが、" +
      "現行の判定は宣言の有無を考慮しないため、engine側にこの許可を反映するロジックが必要。",
  },
  {
    id: "light-observer-invitation",
    name: "observerJoinerへの軽い声かけ",
    description: "参加者のうち1人が、observerJoinerに「一緒行く?」と軽く声をかける。",
    category: "targetedSupport",
    expectedEffect:
      "observerJoiner自身が場を動かさなくても接近のきっかけが生まれ、影響回避の壁がある人でも輪に近づきやすくなる。",
    paramAdjustments: {
      observerInfluenceAvoidance: -0.2,
      observerLeaveEase: -0.1,
    },
    engineLogicNotes:
      "実際の効果は「特定の1人が特定のtickでobserverJoinerに声をかけ、approaching状態へ直接移行させる」" +
      "といったピンポイントな1回限りのイベントであり、全体パラメータの一律補正では近似に留まる。" +
      "engine側に専用の介入イベント処理を追加する必要がある。",
  },
  {
    id: "short-ambiguity-window",
    name: "曖昧時間の短縮",
    description: "店外で全員が様子見になる曖昧な時間そのものを短くする(例: 早めに意思確認の声をかける)。",
    category: "timeDesign",
    expectedEffect: "曖昧フェーズが長引く負担が減り、ストレスが閾値を超えて離脱する前に決着がつきやすくなる。",
    paramAdjustments: {
      ambiguityDuration: 0.2,
    },
    engineLogicNotes:
      "本来は核形成や輪の存続期間そのもの(engine.ts内のCANDIDATE_MAX_AGE/CANDIDATE_WEAK_RESPONSE_AGEといった" +
      "固定tick数)を短縮する効果であり、SimParamsの補正だけでは近似に留まる。" +
      "実際に時間短縮を反映するには、これらの閾値をパラメータ化してengine側に取り込む必要がある。",
  },
  {
    id: "predecided-venue",
    name: "二次会会場の事前決定",
    description: "二次会に行くかどうかは曖昧なままでも、場所だけは先に決めておく。",
    category: "publicCoordination",
    expectedEffect:
      "「どこに行くか」の不確実性だけを先に取り除くことで、行くかどうかの判断に集中しやすくなり、輪への接近もしやすくなる。",
    paramAdjustments: {
      lateJoinEase: 0.15,
    },
    engineLogicNotes:
      "「行き先だけ決まっている」状態は、forming候補が発生する前から合流先が1箇所に固定されていることに相当し、" +
      "現行の核形成ロジック(誰かがforming候補を作るまで合流先が存在しない)とは前提が異なる。" +
      "engine側に「初期状態から確定済みの合流地点を1つ用意する」ロジックが必要。",
  },
  {
    id: "anonymous-low-pressure-intent",
    name: "匿名・低圧の意思表明",
    description:
      "参加表明を匿名・低圧な方法にする(例: 挙手ではなく紙に丸をつける、こっそりスタンプを押す等)。",
    category: "socialPermission",
    expectedEffect:
      "influenceAvoidanceが高い人でも、目立たない形でなら「行きたい」という意思を表明しやすくなる。",
    paramAdjustments: {
      observerInfluenceAvoidance: -0.3,
    },
    engineLogicNotes:
      "本来は「匿名の意思表明」という新しいアクション自体を導入し、それが核形成の確率や" +
      "hasWelcomingConfirmedGroup相当の判定に反映される必要がある。現行engineには意思表明という概念がなく、" +
      "observerInfluenceAvoidanceの一律引き下げで近似している。",
  },
];

export function getInterventionById(id: InterventionScenarioId): InterventionScenario {
  return INTERVENTION_SCENARIOS.find((scenario) => scenario.id === id) ?? NONE_INTERVENTION;
}

/**
 * `intervention.paramAdjustments`を`params`に加算した新しい`SimParams`を返す。`params`はmutationしない。
 * 0-1に正規化されたフィールドは加算後に[0, 1]へクランプする。
 */
export function applyInterventionParamAdjustments(
  params: SimParams,
  intervention: InterventionScenario,
): SimParams {
  const adjustments = intervention.paramAdjustments;
  if (!adjustments) return { ...params };

  const result: SimParams = { ...params };

  for (const key of Object.keys(adjustments) as (keyof SimParams)[]) {
    const delta = adjustments[key];
    if (delta === undefined) continue;
    const nextValue = (result[key] as number) + delta;
    result[key] = (UNIT_RANGE_KEYS.includes(key) ? clamp(nextValue, 0, 1) : nextValue) as never;
  }

  return result;
}
