/**
 * Issue #188 (Phase 2): 責務9(`FormationPolicy.evaluateClusterDeparture`)の心理モデル本体。
 * `docs/conversation-satisfaction-model.md`(Issue #185, ADR)4節の型契約・4.1節の合成方針に基づき、
 * standingPartyのPhase 1暫定ルール(`ticksInCluster`のみを見る固定確率)を置き換える。
 *
 * 「会話への満足度が下がったため離れる」圧力(`lowConversationSatisfaction`)と、「不満はなくても
 * より多くの人と交流するため次の輪へ移る」圧力(`socialCirculation`)を、それぞれ独立した寄与として
 * 計算し、独立事象のhazard合成 `1 - (1-p1)(1-p2)` で最終確率へ合成する(ADR 4.1節の合成候補の一つ。
 * 各寄与が単調・[0,1]有界・「一方が0でも他方は機能する」を自然に満たすため採用)。
 *
 * rngを一切消費しない純粋関数群 ―― `engine.ts`側が結果の`probability`へ一度だけ`rng.chance`する
 * 構造を維持する(責務1の`evaluateCandidateInitiation`と同じ「eligible + probability」分離パターン)。
 *
 * 対象外(ADR 1.1節・issue「対象外」節): 他クラスタの魅力度比較、特定人物への会話希望、
 * observerJoinerの遠慮・愛着・葛藤、話題・情報伝播、会場退出decision(責務4、`leaveThreshold`)の再設計。
 * このモデルは`agent`/`candidate`そのものを一切参照せず、呼び出し側が渡す満足度・回遊傾向・滞在tickの
 * 3値だけから決定的に計算する。
 */
import type { ClusterDepartureFactor, ClusterDepartureFactorKind, ClusterDeparturePrimaryReason } from "./types";

export type { ClusterDepartureFactor, ClusterDepartureFactorKind, ClusterDeparturePrimaryReason };

/** 責務9(Phase 2)の判定結果。Phase 1の `eligible` + `probability` を維持しつつ理由を構造化する */
export type ClusterDepartureDecisionResult = {
  /** このtickで離脱判定(rng判定)の対象になるか。`ticksInCluster < config.minStayTicks`ならfalse */
  eligible: boolean;
  /** `eligible`な場合の離脱確率(呼び出し側が`rng.chance`にそのまま渡す) */
  probability: number;
  /** 寄与要因の内訳(寄与が正のものだけ、contribution降順)。両寄与とも0ならundefined */
  factors?: ClusterDepartureFactor[];
  /** 最も寄与の大きい要因。両寄与とも0ならundefined、僅差なら"mixedConversationAndSocialCirculation" */
  primaryReason?: ClusterDeparturePrimaryReason;
};

/**
 * standingParty向けシナリオ設定(ADR 5.1節: `SimParams`へは足さず、policy定数として持つ)。
 * agent個体差である`socialCirculationTendency`とは異なり、全agent共通の設定値。
 */
export type ClusterDepartureDecisionConfig = {
  /** 最低滞在tick。これ未満は`eligible: false`(Phase 1の`MIN_TICKS_BEFORE_DEPARTURE`を継承) */
  minStayTicks: number;
  /**
   * 満足度がこの値を下回った分だけ不満由来の寄与が生じる基準値 `(0, 1]`。
   * 満足度がこの値以上なら不満由来の寄与は常に0。
   */
  satisfactionLeaveFloor: number;
  /** 不満由来寄与の1tickあたり上限(満足度が0のときの寄与、`[0, 1]`) */
  maxDissatisfactionContribution: number;
  /** 回遊由来寄与の飽和値(tendency=1・十分な滞在後の上限寄与、`[0, 1]`) */
  maxCirculationContribution: number;
  /** 回遊由来寄与が0より大きくなり始めるまでの、最低滞在tick超過後の追加tick数(非負整数) */
  circulationWarmupTicks: number;
  /** warmup経過後、回遊由来寄与が飽和値へ滑らかに到達するまでのtick数(正整数) */
  circulationRampTicks: number;
  /** 両寄与の差がこの値以下の場合、primaryReasonを"mixedConversationAndSocialCirculation"とする(非負) */
  mixedReasonMargin: number;
};

/**
 * 実データ較正前の仮説的な調整値であり、心理学的妥当性を主張しない(`conversationSatisfaction.ts`と
 * 同じ立場、CLAUDE.mdのtuning方針)。
 * - `minStayTicks = 15`: Phase 1の`STANDING_PARTY_MIN_TICKS_BEFORE_DEPARTURE`をそのまま継承する
 *   (要件2節: 合流直後に即離脱する不自然な振動を避ける下限)。
 * - `satisfactionLeaveFloor = 0.5`: 満足度モデルの初期値(`DEFAULT_CONVERSATION_SATISFACTION_CONFIG.
 *   initialConversationSatisfaction = 0.6`)より下、かつ0より十分離れた中庸値。join直後の高めの
 *   満足度からでは不満由来の寄与が発生せず、tickを重ねた逓減や人数ミスマッチで初めて意味を持つ。
 * - `maxDissatisfactionContribution = 0.08` / `maxCirculationContribution = 0.06`: いずれも1未満の
 *   小さな値とし、満足度だけ・回遊傾向だけで確率が1に張り付く極端な既定値を避ける(要件3節)。
 * - `circulationWarmupTicks = 10` / `circulationRampTicks = 20`: 「滞在直後ではなく、一定時間後から
 *   滑らかに増える」(要件4節)を、最低滞在tick超過後さらに10tick待ち、以後20tickかけて飽和値まで
 *   線形に立ち上がる形で表現する。
 * - `mixedReasonMargin = 0.015`: 寄与の差がこの範囲内なら「どちらが主要因か」を強弁せず`mixed`として
 *   構造化理由に表現する(要件6節)。
 */
export const DEFAULT_CLUSTER_DEPARTURE_DECISION_CONFIG: ClusterDepartureDecisionConfig = {
  minStayTicks: 15,
  satisfactionLeaveFloor: 0.5,
  maxDissatisfactionContribution: 0.08,
  maxCirculationContribution: 0.06,
  circulationWarmupTicks: 10,
  circulationRampTicks: 20,
  mixedReasonMargin: 0.015,
};

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`clusterDepartureDecision config: ${name} must be a finite number (got ${value})`);
  }
}

function assertRange(name: string, value: number, min: number, max: number): void {
  assertFinite(name, value);
  if (value < min || value > max) {
    throw new Error(`clusterDepartureDecision config: ${name} must be within [${min}, ${max}] (got ${value})`);
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  assertFinite(name, value);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`clusterDepartureDecision config: ${name} must be a non-negative integer (got ${value})`);
  }
}

/**
 * NaN/Infinity・範囲外・不正な最低滞在tick等を明示的に拒否する(issue要件2節「最低滞在tickは
 * scenario設定としてvalidationする」、`conversationSatisfaction.ts`の`validateConversationSatisfactionConfig`
 * と同じ方針)。
 */
export function validateClusterDepartureDecisionConfig(config: ClusterDepartureDecisionConfig): void {
  assertNonNegativeInteger("minStayTicks", config.minStayTicks);
  // 0だと不満由来寄与の計算が0除算になる(NaN)ため、下限を除外する(要件3節: NaN/Infinityにならない)
  assertRange("satisfactionLeaveFloor", config.satisfactionLeaveFloor, Number.EPSILON, 1);
  assertRange("maxDissatisfactionContribution", config.maxDissatisfactionContribution, 0, 1);
  assertRange("maxCirculationContribution", config.maxCirculationContribution, 0, 1);
  assertNonNegativeInteger("circulationWarmupTicks", config.circulationWarmupTicks);
  assertFinite("circulationRampTicks", config.circulationRampTicks);
  if (!Number.isInteger(config.circulationRampTicks) || config.circulationRampTicks <= 0) {
    throw new Error(`clusterDepartureDecision config: circulationRampTicks must be a positive integer (got ${config.circulationRampTicks})`);
  }
  assertRange("mixedReasonMargin", config.mixedReasonMargin, 0, 1);
}

validateClusterDepartureDecisionConfig(DEFAULT_CLUSTER_DEPARTURE_DECISION_CONFIG);

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * 不満由来の寄与(要件3節)。満足度が`satisfactionLeaveFloor`以上なら0(単調・非増加)、
 * 満足度が低いほど`maxDissatisfactionContribution`へ向けて単調に増える。`satisfactionLeaveFloor`が
 * `validateClusterDepartureDecisionConfig`で0より大きいことが保証されているため0除算しない。
 */
function computeDissatisfactionContribution(satisfaction: number, config: ClusterDepartureDecisionConfig): number {
  const deficit = (config.satisfactionLeaveFloor - clamp01(satisfaction)) / config.satisfactionLeaveFloor;
  return config.maxDissatisfactionContribution * clamp01(deficit);
}

/**
 * 回遊由来の寄与(要件4節)。`tendency <= 0`なら常に0(要件: 回遊傾向が0ならこの寄与は0)。
 * `ticksInCluster`が`minStayTicks + circulationWarmupTicks`に達するまでは0(滞在直後ではなく、
 * 一定時間後から立ち上がる)、以後`circulationRampTicks`かけて`maxCirculationContribution * tendency`
 * へ滑らかに線形増加する(満足度を一切参照しないため、満足度が高くても0にはならない)。
 */
function computeCirculationContribution(
  ticksInCluster: number,
  tendency: number,
  config: ClusterDepartureDecisionConfig,
): number {
  const clampedTendency = clamp01(tendency);
  if (clampedTendency <= 0) return 0;
  const ticksSinceWarmup = ticksInCluster - config.minStayTicks - config.circulationWarmupTicks;
  const rampProgress = clamp01(ticksSinceWarmup / config.circulationRampTicks);
  return config.maxCirculationContribution * clampedTendency * rampProgress;
}

/**
 * 寄与の大小からprimaryReasonを決定的に導く(要件: 同一入力で常に同じ結果)。
 * 両方0ならundefined(離脱理由を持たない=probability 0と対応)、片方のみ正ならその要因、
 * 両方正で差が`mixedReasonMargin`以内なら"mixedConversationAndSocialCirculation"。
 */
function derivePrimaryReason(
  dissatisfactionContribution: number,
  circulationContribution: number,
  mixedReasonMargin: number,
): ClusterDeparturePrimaryReason | undefined {
  if (dissatisfactionContribution <= 0 && circulationContribution <= 0) return undefined;
  if (dissatisfactionContribution <= 0) return "socialCirculation";
  if (circulationContribution <= 0) return "lowConversationSatisfaction";
  if (Math.abs(dissatisfactionContribution - circulationContribution) <= mixedReasonMargin) {
    return "mixedConversationAndSocialCirculation";
  }
  return dissatisfactionContribution > circulationContribution ? "lowConversationSatisfaction" : "socialCirculation";
}

export type ClusterDepartureDecisionInput = {
  config: ClusterDepartureDecisionConfig;
  /** このクラスタへ合流してからの経過tick数 */
  ticksInCluster: number;
  /** 現在の会話エピソードの満足度 `[0,1]`(step 5aで更新済みの値) */
  conversationSatisfaction: number;
  /** このagentの社交的回遊傾向 `[0,1]`(trait、run中不変) */
  socialCirculationTendency: number;
};

/**
 * 責務9(Phase 2)の判定本体。`ticksInCluster < config.minStayTicks`なら`eligible: false`(要件2節)。
 * それ以外は不満由来・回遊由来それぞれの寄与を計算し、独立hazardとして合成した`probability`
 * (常に`[0,1]`、要件5節)を返す。両寄与が0なら`probability`も0になる(要件5節)。
 */
export function computeClusterDepartureDecision(input: ClusterDepartureDecisionInput): ClusterDepartureDecisionResult {
  const { config } = input;
  if (input.ticksInCluster < config.minStayTicks) {
    return { eligible: false, probability: 0 };
  }

  const dissatisfactionContribution = computeDissatisfactionContribution(input.conversationSatisfaction, config);
  const circulationContribution = computeCirculationContribution(
    input.ticksInCluster,
    input.socialCirculationTendency,
    config,
  );

  const probability = clamp01(1 - (1 - dissatisfactionContribution) * (1 - circulationContribution));

  const factors: ClusterDepartureFactor[] = [];
  if (dissatisfactionContribution > 0) {
    factors.push({ kind: "lowConversationSatisfaction", contribution: dissatisfactionContribution });
  }
  if (circulationContribution > 0) {
    factors.push({ kind: "socialCirculation", contribution: circulationContribution });
  }
  factors.sort((a, b) => b.contribution - a.contribution);

  return {
    eligible: true,
    probability,
    factors: factors.length > 0 ? factors : undefined,
    primaryReason: derivePrimaryReason(dissatisfactionContribution, circulationContribution, config.mixedReasonMargin),
  };
}
