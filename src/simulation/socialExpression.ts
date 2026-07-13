import type { AgentState, GroupCandidate, SimParams, SimulationState } from "./types";
import type { SpeechActiveEffect } from "./speechEffects";
import { sumActiveEffectValue } from "./speechEffects";
import { attractiveness, isJoinable, nearestCandidate } from "./engine";
import type { InterventionRuntimeOptions } from "./interventions";
import { resolveEffectiveParams, resolveInterventionScenario } from "./interventions";

/**
 * Phase 4(Issue #113): 本心・対外表現・行動を分離する三層モデルの型と導出境界。
 *
 * 三層の定義と既存概念との対応:
 * - 本心(`PrivateEvaluation`、本ファイル): エージェント内部の評価。既存の判断式
 *   (`attractiveness()`・接近確率計算・stress/`leaveThreshold`比較、いずれも`engine.ts`)の
 *   中間値から純関数で導出される観察用スナップショット。他エージェントには一切認知されない。
 *   Phase 1の`ExpressionEvent`(`expression.ts`)は、この本心側を観察者向けに言語化した演出データにあたる。
 * - 対外表現(`PublicExpression`、本ファイル): 対外的に表現される立場。Phase 2の`SpeechEvent`
 *   (`speech.ts`)は、この対外表現側が実際の発言として観測されたものにあたる。
 *   **Issue #113の時点では常に本心と同値であり、乖離は存在しない**(遠慮・印象管理・同調圧力による
 *   乖離判定はIssue #114、乖離した発言の生成はIssue #115で導入する)。
 * - 行動(actualAction): 既存の`AgentState`遷移・移動そのもの(`types.ts`/`engine.ts`)。
 *   新しい型は導入しない。三層モデルにおける「実際にどう動いたか」はこれを指す。
 *
 * 処理境界(重要):
 * - 本ファイルの導出関数はすべて純関数であり、`SimulationState`を読み取るのみで一切mutationしない。
 * - 本体の`SeededRandom`を受け取らない/消費しない(導出の有無でPRNG列は変わらない)。
 * - `engine.ts`は本ファイルをimportしない(観察専用の一方向依存。`expression.ts`と同じ位置づけ)。
 *   engineの判断式への接続はIssue #115以降のスコープ。
 * - 導出結果は`SimulationState`に保持されない(呼び出し側が必要なtickで都度導出する)。
 *
 * 詳細は`docs/social-expression-phase4-boundary.md`参照。
 */

/** Phase 4三層モデルの導出有無を切り替える設定境界。`SpeechEffectsConfig`と同じ後方互換パターン */
export type SocialExpressionConfig = {
  /**
   * false(デフォルト)の場合、`derivePrivateEvaluations`/`derivePublicExpressions`は
   * いずれも空配列を返す。既存の設定・挙動との後方互換のためのデフォルト値。
   */
  enabled: boolean;
};

/** 未指定時に使う既定値。既存の呼び出し元を一切変更せずに済むよう無効化しておく */
export const DEFAULT_SOCIAL_EXPRESSION_CONFIG: SocialExpressionConfig = { enabled: false };

/** 部分指定を`DEFAULT_SOCIAL_EXPRESSION_CONFIG`で補完した`SocialExpressionConfig`を返す */
export function resolveSocialExpressionConfig(config?: Partial<SocialExpressionConfig>): SocialExpressionConfig {
  return { ...DEFAULT_SOCIAL_EXPRESSION_CONFIG, ...config };
}

/**
 * joinableな輪1件に対する本心側の評価。`attractiveness`は`engine.ts`の同名関数を
 * そのtickと同じ入力(実効params・介入ID・現在有効な発言効果)で呼んだ値そのもので、
 * 独自の評価式は導入しない(本心=既存判断式の中間値、という定義を保つため)。
 */
export type PrivateCandidateEvaluation = {
  groupId: string;
  /** `isJoinable`を通過した候補のみ評価するため、forming/confirmedに限られる */
  groupStatus: "forming" | "confirmed";
  attractiveness: number;
  /** `engine.ts`の接近判定が対象にする最寄り候補かどうか(`nearestCandidate`と同一の判定) */
  isNearest: boolean;
};

/**
 * 本心: エージェント1人の、あるtick時点の内的評価スナップショット。
 *
 * 各フィールドは既存の判断式の入力・中間値をそのまま写しとったもので、新しい心理モデルは
 * 導入しない。engineの意思決定ルール上、接近判定・leave判定の入力になるのは`undecided`の
 * エージェントのみだが、観察対象としての本心は全エージェントについて導出する
 * (どの状態のエージェントかは`agentState`で判別できる)。
 */
export type PrivateEvaluation = {
  id: string;
  tick: number;
  agentId: string;
  /** 導出時点の行動状態(三層モデルのactualAction側)。本心と行動の対応を後から突き合わせるための複製 */
  agentState: AgentState;
  /** 二次会への参加意欲。既存personalityの`willingness`そのもの(本心の基礎値) */
  joinDesire: number;
  /**
   * 離脱傾向: stress / 実効leaveThreshold。engineのleave判定(`stress > effectiveLeaveThreshold`)と
   * 同じ入力の比率表現で、1.0以上はしきい値到達(=undecidedならこのtickでleaving遷移済み)を意味する。
   * 実効しきい値には"decline"由来の`SpeechActiveEffect`補正を含む(engineと同じ計算)。
   */
  leaveInclination: number;
  /** joinableな各輪への評価。`SimulationState.groupCandidates`の配列順(決定的) */
  candidateEvaluations: PrivateCandidateEvaluation[];
};

/**
 * 対外表現: エージェント1人の、あるtick時点で対外的に表現される立場。
 *
 * **Issue #113の時点では常に対応する`PrivateEvaluation`と同値**(乖離なし)。
 * 遠慮・印象管理・同調圧力による乖離判定(値がずれ、`divergent`がtrueになりうる)は
 * Issue #114で導入する。`privateEvaluationId`により、どの本心から導出されたかを常に追跡できる。
 */
export type PublicExpression = {
  id: string;
  /** 導出元の`PrivateEvaluation.id`(因果追跡用のリンク) */
  privateEvaluationId: string;
  tick: number;
  agentId: string;
  /** 対外的に表現される参加意欲。#113では常に`PrivateEvaluation.joinDesire`と同値 */
  expressedJoinDesire: number;
  /** 対外的に表現される離脱傾向。#113では常に`PrivateEvaluation.leaveInclination`と同値 */
  expressedLeaveInclination: number;
  /** 本心との乖離があるか。#113では常にfalse(Issue #114で乖離判定を導入) */
  divergent: boolean;
};

// leaveInclinationの分母の下限。実効leaveThresholdは"decline"由来の負の補正で理論上0以下に
// なりうるため、比率が発散しないよう下限を設ける(engineのleave判定自体は比較のみなので影響しない)
const MIN_EFFECTIVE_LEAVE_THRESHOLD = 0.01;

/**
 * `state`の全エージェントについて、そのtick時点の本心(`PrivateEvaluation`)を導出する純関数。
 *
 * engineが次のtickの判断で参照するのと同じ経路で入力を解決する:
 * - 介入は`state.interventionId`から(`stepSimulation`の未指定時fall backと同じ)
 * - 実効paramsは`resolveEffectiveParams`(介入のparamAdjustments適用後)
 * - 発言効果は`state.activeSpeechEffects`(Phase 3が無効なら常に空)を`state.tick`時点の強度で評価
 *
 * `config.enabled === false`(デフォルト)では空配列を返し、呼び出しても既存挙動に一切影響しない。
 * `state`をmutationせず、rngも受け取らない(導出の有無でシミュレーション結果・PRNG列は変わらない)。
 */
export function derivePrivateEvaluations(
  state: SimulationState,
  params: SimParams,
  config: SocialExpressionConfig,
): PrivateEvaluation[] {
  if (!config.enabled) return [];

  const intervention: InterventionRuntimeOptions | undefined = state.interventionId
    ? { interventionId: state.interventionId }
    : undefined;
  const effectiveParams = resolveEffectiveParams(params, intervention);
  const interventionId = resolveInterventionScenario(intervention).id;
  const activeEffects: SpeechActiveEffect[] = state.speechEffectsEnabled ? (state.activeSpeechEffects ?? []) : [];
  const joinableCandidates = state.groupCandidates.filter(isJoinable);

  return state.agents.map((agent) => {
    const nearest = nearestCandidate(agent, state.groupCandidates);
    const candidateEvaluations: PrivateCandidateEvaluation[] = joinableCandidates.map((candidate: GroupCandidate) => ({
      groupId: candidate.id,
      // isJoinableを通過した候補はforming/confirmedのどちらかに限られる
      groupStatus: candidate.status as "forming" | "confirmed",
      attractiveness: attractiveness(
        agent,
        candidate,
        state.agents,
        effectiveParams,
        interventionId,
        state.tick,
        activeEffects,
      ),
      isNearest: candidate.id === nearest?.id,
    }));

    const effectiveLeaveThreshold =
      agent.leaveThreshold + sumActiveEffectValue(activeEffects, agent.id, "leaveThreshold", state.tick);

    return {
      id: `private-${state.tick}-${agent.id}`,
      tick: state.tick,
      agentId: agent.id,
      agentState: agent.state,
      joinDesire: agent.willingness,
      leaveInclination: agent.stress / Math.max(MIN_EFFECTIVE_LEAVE_THRESHOLD, effectiveLeaveThreshold),
      candidateEvaluations,
    };
  });
}

/**
 * 本心(`PrivateEvaluation`)から対外表現(`PublicExpression`)を導出する純関数。
 *
 * **Issue #113の時点では恒等変換**(乖離なし、`divergent: false`)であり、本心と対外表現を
 * 別の値にする変換ルールは一切持たない。Issue #114がこの関数の内部に乖離判定
 * (遠慮・印象管理・同調圧力)を導入する予定であり、この関数が「本心→対外表現」変換の
 * 唯一の境界となる。`config.enabled === false`(デフォルト)では空配列を返す。
 */
export function derivePublicExpressions(
  privateEvaluations: PrivateEvaluation[],
  config: SocialExpressionConfig,
): PublicExpression[] {
  if (!config.enabled) return [];

  return privateEvaluations.map((evaluation) => ({
    id: `public-${evaluation.tick}-${evaluation.agentId}`,
    privateEvaluationId: evaluation.id,
    tick: evaluation.tick,
    agentId: evaluation.agentId,
    expressedJoinDesire: evaluation.joinDesire,
    expressedLeaveInclination: evaluation.leaveInclination,
    divergent: false,
  }));
}
