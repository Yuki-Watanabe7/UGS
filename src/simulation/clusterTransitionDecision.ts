/**
 * Issue #200 (Phase 3, ステップP3-C): `docs/cluster-transition-phase3-model.md`(Issue #197 ADR)の
 * 4節・6.2節で確定した型・合成方針に基づく、クラスタ遷移decision(`ClusterTransitionDecision`)の
 * 純粋関数本体。
 *
 * Phase 2の離脱圧力(`clusterDepartureDecision.ts`の`probability`)を出発点に、#198の他クラスタ関心
 * (`interestDrive`)で増やし、#199の愛着・離脱配慮(`inhibition`)で減らして、`stay` /
 * `departAndExplore` / `switchToTargetCluster`の3action確率を合成する(ADR 4.1節)。
 * `isObserverJoiner`はこの式のいかなる入力にも現れない(ADR 1.4節) ―― 呼び出し側がどのagentの
 * 値を渡すかに関わらず、同じ`departure`/`bestAlternativeInterest`/`inhibition`からは常に同じ結果になる。
 *
 * 決定性・非干渉: 純粋関数。rngを一切消費せず、引数をmutationしない(ADR 4.2節、7節)。
 * `actionProbabilities`は常に有限で`[0,1]`、3値の合計は常に1になる(6.3節)。
 */
import type { ClusterDepartureFactor, ClusterDeparturePrimaryReason, ClusterTransitionAction, ClusterTransitionPrimaryReason } from "./types";
import type { ClusterDepartureDecisionResult } from "./clusterDepartureDecision";
import type { AlternativeClusterInterest } from "./alternativeClusterInterest";
import type { DepartureInhibition } from "./currentClusterAttachment";
import type { TopicCompatibility, TopicIntegrationConfig } from "./topicCompatibility";

export type { ClusterTransitionAction, ClusterTransitionPrimaryReason };

/**
 * standingParty向けシナリオ設定(ADR 6.1節: `SimParams`へは足さず、他Phase 3configと同じ器へ持つ)。
 * `enabled: false`(既定)の間は、呼び出し側(`formationPolicy.ts`)がPhase 2の
 * `computeClusterDepartureDecision`の結果をそのまま返し、この関数自体を呼ばない
 * (ADR 4.3節1: 確率・draw回数・イベント列・PRNG系列がPhase 2とbyte-identicalになる)。
 */
export type ClusterTransitionConfig = {
  /** Phase 3全体のゲート。既定`false`(ADR 4.3節1) */
  enabled: boolean;
  /** 他クラスタ関心scoreから離脱駆動`interestDrive`への変換係数 `[0,1]` */
  interestToDepartureGain: number;
  /** `switchShare`の基礎値 `[0,1]` */
  targetShareBase: number;
  /** 関心scoreに比例する`switchShare`の増分 `[0,1]`(`targetShareBase + targetShareGain <= 1`) */
  targetShareGain: number;
  /** 移動意図の寿命(tick、正整数)。#201が`PendingClusterTransition.expiresAtTick`へ使うまでは未参照 */
  pendingTransitionTtlTicks: number;
  /** primaryReasonを`mixed*`にする寄与差の閾値 `[0,1]`(Phase 2の`mixedReasonMargin`と同じ意味) */
  mixedReasonMargin: number;
};

/**
 * 実データ較正前の仮説的な調整値であり、心理学的妥当性を主張しない(既存Phase 2/3モジュールと同じ立場)。
 * - `enabled = false`: Phase 3全体を既定で無効化する(ADR 4.3節1、後方互換の本体)。
 * - `interestToDepartureGain = 0.6`: 関心score(最大1)がそのまま離脱駆動へ全量乗らないよう抑える
 *   中庸値。関心が強くても、Phase 2の離脱圧力と同じ土俵の単一寄与として振る舞う。
 * - `targetShareBase = 0.5` / `targetShareGain = 0.4`: 閾値以上の関心がある場合、離脱の半分程度は
 *   最初から「目的地あり」で始まり、関心が強いほど`switchToTargetCluster`側へさらに寄る
 *   (合計0.9 < 1、関心が最大でも`departAndExplore`の余地を完全には消さない)。
 * - `pendingTransitionTtlTicks = 30`: #201が実装されるまでは未参照だが、ADR 6.2節の型契約を
 *   先取りしてvalidationだけ整えておく(正整数であることの保証)。
 * - `mixedReasonMargin = 0.05`: Phase 2の`clusterDepartureDecision.ts`(0.015)より少し広めに取る。
 *   `interestDrive`/`p2`や抑制側の2寄与はPhase 2の2寄与よりスケールが大きく開きやすいため、
 *   「僅差」を同じ絶対値では捉えにくいことへの調整。
 */
export const DEFAULT_CLUSTER_TRANSITION_CONFIG: ClusterTransitionConfig = {
  enabled: false,
  interestToDepartureGain: 0.6,
  targetShareBase: 0.5,
  targetShareGain: 0.4,
  pendingTransitionTtlTicks: 30,
  mixedReasonMargin: 0.05,
};

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`clusterTransitionDecision config: ${name} must be a finite number (got ${value})`);
  }
}

function assertRange01(name: string, value: number): void {
  assertFinite(name, value);
  if (value < 0 || value > 1) {
    throw new Error(`clusterTransitionDecision config: ${name} must be within [0, 1] (got ${value})`);
  }
}

function assertPositiveInteger(name: string, value: number): void {
  assertFinite(name, value);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`clusterTransitionDecision config: ${name} must be a positive integer (got ${value})`);
  }
}

/**
 * NaN/Infinity・範囲外・不正な整数を明示的に拒否する(既存Phase 2/3モジュールと同じ方針。domain layerを
 * 最終防衛線とする)。相互制約`targetShareBase + targetShareGain <= 1`も検証する(ADR 6.3節)。
 */
export function validateClusterTransitionConfig(config: ClusterTransitionConfig): void {
  assertRange01("interestToDepartureGain", config.interestToDepartureGain);
  assertRange01("targetShareBase", config.targetShareBase);
  assertRange01("targetShareGain", config.targetShareGain);
  if (config.targetShareBase + config.targetShareGain > 1) {
    throw new Error(
      `clusterTransitionDecision config: targetShareBase (${config.targetShareBase}) + targetShareGain (${config.targetShareGain}) must be <= 1`,
    );
  }
  assertPositiveInteger("pendingTransitionTtlTicks", config.pendingTransitionTtlTicks);
  assertRange01("mixedReasonMargin", config.mixedReasonMargin);
}

validateClusterTransitionConfig(DEFAULT_CLUSTER_TRANSITION_CONFIG);

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export type ClusterTransitionDecision = {
  /** Phase 2と同じ。`departure.eligible`がfalseならfalse(この場合engineはdrawを引かない) */
  eligible: boolean;
  /** 3つのactionの確率。すべて`[0,1]`、合計はちょうど1(ADR 4.1節) */
  actionProbabilities: Record<ClusterTransitionAction, number>;
  /** `actionProbabilities.switchToTargetCluster > 0`の場合のみ設定 */
  selectedTargetClusterId?: string;
  focusAgentId?: string;
  /** Phase 2の離脱圧力(関心・抑制を適用する前の素の値、`p2`) */
  departurePressure: number;
  departureFactors?: ClusterDepartureFactor[];
  alternativeInterest?: AlternativeClusterInterest;
  inhibition: DepartureInhibition;
  /** 観察専用の派生値。`actionProbabilities`の計算には使わない(ADR 1.4.1節) */
  conflictIntensity: number;
  primaryReason?: ClusterTransitionPrimaryReason;
  decidedAtTick: number;
};

export type ClusterTransitionDecisionInput = {
  config: ClusterTransitionConfig;
  tick: number;
  /** Phase 2(`computeClusterDepartureDecision`)の結果。`eligible: false`ならdrawを引かない前提を継承する */
  departure: ClusterDepartureDecisionResult;
  /** 観察半径内の最良他クラスタ関心(#198)。`minTargetInterestScore`未満でも渡してよい(生の最良値) */
  bestAlternativeInterest?: AlternativeClusterInterest;
  /** `switchToTargetCluster`候補として扱う最低関心score(`AlternativeClusterInterestConfig.minTargetInterestScore`) */
  minTargetInterestScore: number;
  /** 愛着・離脱配慮(#199)の合成結果 */
  inhibition: DepartureInhibition;
  /**
   * Issue #233 (Phase 5): `primaryReason`をtopic/情報探索由来のreasonへ差し替えるための追加信号。
   * 未設定(既定)ならこの関数の他のいかなる計算・PRNG系列にも影響しない ―― `primaryReason`の
   * 差し替え判定だけに使う純粋な後段処理(`refineReasonForTopicSignal`)。
   */
  topicSignal?: {
    config: TopicIntegrationConfig;
    /** 現在clusterのtopic compatibility(`topicCompatibility.ts`)。topic未設定ならundefinedでよい */
    currentCompatibility?: TopicCompatibility;
    /** `bestAlternativeInterest.factors`中の`informationOpportunity`寄与(無ければ0扱い) */
    alternativeInformationOpportunityContribution?: number;
  };
};

/**
 * ADR 4.3節の状況表に沿って、離脱側/滞在側どちらが支配的かで場合分けし、その内側で
 * 「どの寄与が主因か」を寄与の絶対値の大小・僅差判定(`mixedReasonMargin`)から決定的に導く
 * (要件: 同一入力で常に同じ結果、複数factorが近い場合のmixed判定を決定的にする)。
 *
 * 支配側の判定は、抑制適用**前**の離脱駆動`departurePull`(= `1 - (1-p2)(1-interestDrive)`)と
 * `inhibitionTotal`の大小で行う ―― 最終確率`pDepart`/`pStay`(抑制適用後)同士を比べると、
 * 抑制の全係数が0のとき(=`inhibitionTotal === 0`)でも`p2`が0.5未満なら「stay側が支配的」と
 * 誤判定され、Phase 2単体では常に返っていたはずのreasonがundefinedへ後退してしまう
 * (ADR 4.3節1「抑制側の全係数が0の場合、数値が完全に一致する」の"数値"にはreasonも含む)。
 * `departurePull`との比較なら、`inhibitionTotal === 0`の間は`departurePull > 0`である限り常に
 * 離脱側の分岐に入り、この後方互換が式の形だけで保証される。
 */
function deriveTransitionPrimaryReason(params: {
  departurePull: number;
  inhibitionTotal: number;
  p2: number;
  interestDrive: number;
  departurePrimaryReason: ClusterDeparturePrimaryReason | undefined;
  attachmentContribution: number;
  concernContribution: number;
  mixedReasonMargin: number;
}): ClusterTransitionPrimaryReason | undefined {
  const { departurePull, inhibitionTotal, mixedReasonMargin } = params;

  if (departurePull > inhibitionTotal) {
    if (params.p2 <= 0 && params.interestDrive <= 0) return undefined;
    if (params.interestDrive <= 0) return params.departurePrimaryReason;
    if (params.p2 <= 0) return "alternativeClusterInterest";
    if (Math.abs(params.p2 - params.interestDrive) <= mixedReasonMargin) {
      return "mixedDepartureAndAlternativeInterest";
    }
    return params.p2 > params.interestDrive ? params.departurePrimaryReason : "alternativeClusterInterest";
  }

  // 抑制側が支配的(inhibitionTotal >= departurePull)。内訳がすべて0なら「抑制で留まった」わけではない。
  if (params.attachmentContribution <= 0 && params.concernContribution <= 0) return undefined;
  if (params.concernContribution <= 0) return "stayedByAttachment";
  if (params.attachmentContribution <= 0) return "stayedByDepartureConcern";
  if (Math.abs(params.attachmentContribution - params.concernContribution) <= mixedReasonMargin) {
    return "stayedByMixedInhibition";
  }
  return params.attachmentContribution > params.concernContribution ? "stayedByAttachment" : "stayedByDepartureConcern";
}

/**
 * Issue #233 (Phase 5): `deriveTransitionPrimaryReason`が返した基本reasonを、topic/情報探索要因が
 * 主要因だった場合に限り、より具体的な6値へ差し替える(issue要件4節)。`topicSignal`未設定、または
 * どの分岐条件にも合致しない場合は元のreasonをそのまま返す(後方互換・byte-identical)。
 *
 * - `lowConversationSatisfaction` → 現在clusterの負のtopic factor合計が`topicMismatchThreshold`以上
 *   なら`topicMismatch`(fatigue/repetition/停滞が主)か`topicFatigue`(それ以外の不一致が主)。
 * - `alternativeClusterInterest` → informationOpportunity寄与が閾値以上なら`informationSeeking`
 *   (`novelInformationOpportunityThreshold`以上なら`novelInformationOpportunity`)。
 * - `mixedDepartureAndAlternativeInterest` → 両側がtopic要因主導なら`mixedConversationAndInformation`。
 * - `stayedBy*` → informationOpportunity寄与が閾値以上(=抑制がなければ情報探索で離れていたはず)なら
 *   `stayedDespiteInformationInterest`(attachment/departure concernが情報探索移動を抑制した、要件4節)。
 */
function refineReasonForTopicSignal(
  primaryReason: ClusterTransitionPrimaryReason | undefined,
  topicSignal: ClusterTransitionDecisionInput["topicSignal"],
): ClusterTransitionPrimaryReason | undefined {
  if (!topicSignal || primaryReason === undefined) return primaryReason;
  const { config, currentCompatibility, alternativeInformationOpportunityContribution } = topicSignal;
  const infoContribution = alternativeInformationOpportunityContribution ?? 0;
  const hasStrongInfoOpportunity = infoContribution >= config.minInformationOpportunityScore;

  if (primaryReason === "lowConversationSatisfaction" && currentCompatibility) {
    const negativeFactors = currentCompatibility.factors.filter((factor) => factor.contribution < 0);
    const negativeTotal = negativeFactors.reduce((sum, factor) => sum - factor.contribution, 0);
    if (negativeTotal >= config.topicMismatchThreshold) {
      const fatigueLikeTotal = negativeFactors
        .filter((factor) => factor.kind === "fatigue" || factor.kind === "repetition")
        .reduce((sum, factor) => sum - factor.contribution, 0);
      return fatigueLikeTotal >= negativeTotal / 2 ? "topicFatigue" : "topicMismatch";
    }
    return primaryReason;
  }

  if (primaryReason === "alternativeClusterInterest" && hasStrongInfoOpportunity) {
    return infoContribution >= config.novelInformationOpportunityThreshold ? "novelInformationOpportunity" : "informationSeeking";
  }

  if (primaryReason === "mixedDepartureAndAlternativeInterest" && hasStrongInfoOpportunity && currentCompatibility) {
    const negativeTotal = currentCompatibility.factors
      .filter((factor) => factor.contribution < 0)
      .reduce((sum, factor) => sum - factor.contribution, 0);
    if (negativeTotal >= config.topicMismatchThreshold) return "mixedConversationAndInformation";
    return primaryReason;
  }

  if (
    (primaryReason === "stayedByAttachment" ||
      primaryReason === "stayedByDepartureConcern" ||
      primaryReason === "stayedByMixedInhibition") &&
    hasStrongInfoOpportunity
  ) {
    return "stayedDespiteInformationInterest";
  }

  return primaryReason;
}

/**
 * ADR 4.1節の合成式本体:
 *
 * ```
 * interestDrive = clamp01(bestInterest.score * interestToDepartureGain)
 * inhibition    = clamp01(inhibitionResult.total)                        // すでにmaxInhibition < 1でclampされている
 * pDepart       = clamp01((1 - (1 - p2) * (1 - interestDrive)) * (1 - inhibition))
 * switchShare   = bestInterest.score >= minTargetInterestScore
 *                   ? clamp01(targetShareBase + bestInterest.score * targetShareGain)
 *                   : 0
 * pSwitch       = pDepart * switchShare
 * pExplore      = pDepart - pSwitch
 * pStay         = 1 - pDepart
 * ```
 *
 * `departure.eligible === false`の場合は`{ stay: 1, departAndExplore: 0, switchToTargetCluster: 0 }`
 * を返す(呼び出し側はdrawを引かない、ADR 4.2節)。rngを一切参照せず、引数をmutationしない。
 */
export function computeClusterTransitionDecision(input: ClusterTransitionDecisionInput): ClusterTransitionDecision {
  const { departure, inhibition, config } = input;

  if (!departure.eligible) {
    return {
      eligible: false,
      actionProbabilities: { stay: 1, departAndExplore: 0, switchToTargetCluster: 0 },
      departurePressure: 0,
      inhibition,
      conflictIntensity: 0,
      decidedAtTick: input.tick,
    };
  }

  const p2 = clamp01(departure.probability);
  const bestScore = clamp01(input.bestAlternativeInterest?.score ?? 0);
  const interestDrive = clamp01(bestScore * config.interestToDepartureGain);
  const inhibitionTotal = clamp01(inhibition.total);

  // 抑制を適用する前の離脱駆動(Phase 2寄与 + 関心寄与の独立hazard合成)。primaryReasonの支配側判定
  // (下記)にも使う ―― 抑制適用後のpDepart/pStayではなく、この値と`inhibitionTotal`を比べる。
  const departurePull = clamp01(1 - (1 - p2) * (1 - interestDrive));
  const pDepart = clamp01(departurePull * (1 - inhibitionTotal));

  const hasTarget = input.bestAlternativeInterest !== undefined && bestScore >= input.minTargetInterestScore;
  const switchShare = hasTarget ? clamp01(config.targetShareBase + bestScore * config.targetShareGain) : 0;
  const pSwitch = pDepart * switchShare;
  const pExplore = pDepart - pSwitch;
  const pStay = 1 - pDepart;

  const conflictIntensity = Math.min(interestDrive, inhibitionTotal);

  const attachmentContribution = inhibition.factors.find((f) => f.kind === "episodeAttachment")?.contribution ?? 0;

  const baseReason = deriveTransitionPrimaryReason({
    departurePull,
    inhibitionTotal,
    p2,
    interestDrive,
    departurePrimaryReason: departure.primaryReason,
    attachmentContribution,
    concernContribution: inhibition.concern,
    mixedReasonMargin: config.mixedReasonMargin,
  });
  const primaryReason = refineReasonForTopicSignal(baseReason, input.topicSignal);

  return {
    eligible: true,
    actionProbabilities: { stay: pStay, departAndExplore: pExplore, switchToTargetCluster: pSwitch },
    selectedTargetClusterId: pSwitch > 0 ? input.bestAlternativeInterest?.targetClusterId : undefined,
    focusAgentId: pSwitch > 0 ? input.bestAlternativeInterest?.focusAgentId : undefined,
    departurePressure: p2,
    departureFactors: departure.factors,
    alternativeInterest: input.bestAlternativeInterest,
    inhibition,
    conflictIntensity,
    primaryReason,
    decidedAtTick: input.tick,
  };
}
