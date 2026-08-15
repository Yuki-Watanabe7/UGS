/**
 * Issue #233 (Phase 5, roadmap #172): #230〜#232が実装したtopic/情報伝播runtime state
 * (`conversationTopic.ts`の`ClusterTopicState`、`informationState.ts`の`AgentInformationState`)を、
 * 会話満足度・cluster transition decisionへ限定的に統合するための、topic compatibility評価。
 *
 * ここで扱うのは「今agentがいる(または観察している)clusterの話題が、そのagent自身にとって
 * どれだけ噛み合っているか」という一時的な導出値だけである。純粋関数・rng不使用・非mutation。
 * 参照してよい情報は、cluster側の公開runtime state(`ClusterTopicState`)と、agent自身の
 * `AgentInformationState`(自分の関心・自分が既に知っているclaim/variant)だけに限る ――
 * 他agentの非公開`AgentClaimState`・target clusterの将来発話・画面外clusterの全claim catalogは
 * 一切参照しない(issue要件5節「観察可能情報の制限」)。
 *
 * `clusterTopic`が未設定/`currentTopicId`未設定、または`agentInformation`が未設定の場合は
 * 中立値(`score: 0.5`, `factors: []`)を返す ―― 呼び出し側はこれを「寄与0」として扱うことで、
 * topic未設定/Phase 5 disabled時に既存式と同一結果になる(issue受入条件)。
 */
import type { ClaimCatalog, TopicCatalog } from "./informationModel";
import type { AgentInformationState } from "./informationState";
import type { ClusterTopicState } from "./conversationTopic";
import { computeClusterTopicFatigue } from "./conversationTopic";

export type TopicCompatibilityFactorKind =
  | "interestMatch"
  | "relatedTopicMatch"
  | "novelty"
  | "repetition"
  | "variantDiversity"
  | "fatigue"
  | "topicChange";

export type TopicCompatibilityFactor = {
  kind: TopicCompatibilityFactorKind;
  /** scoreへの符号付き寄与。負のkind(repetition/fatigue/topicChangeの停滞側)は負値を取る */
  contribution: number;
};

export type TopicCompatibility = {
  clusterId: string;
  /** clusterに現在topicが無い場合はundefined */
  topicId?: string;
  /** [0,1]。0.5が中立(topic未設定・全factor寄与0を含む) */
  score: number;
  /** contribution降順。寄与0のkindは含めない */
  factors: TopicCompatibilityFactor[];
  /** そのtopicのclaimのうち、agentがまだ認識していない数(novelty分母の内訳、Inspector用) */
  unknownClaimCount: number;
  /** そのtopicのclaimのうち、agentが既に認識している数 */
  knownClaimCount: number;
  observedAtTick: number;
};

export type TopicCompatibilityConfig = {
  /** current topicへの関心一致の上限寄与 [0,1] */
  interestMatchWeight: number;
  /** related topicへの関心による上限寄与 [0,1] */
  relatedTopicMatchWeight: number;
  /** 未知claimの存在比率による上限寄与(新規性) [0,1] */
  noveltyWeight: number;
  /** 既知claimの反復による減点上限 [0,1] */
  repetitionPenaltyCap: number;
  /** 既知claimについて、多様なvariantを聞けていることによる上限寄与 [0,1] */
  variantDiversityWeight: number;
  /** cluster側の話題使い古され度(`computeClusterTopicFatigue`)による減点上限 [0,1] */
  fatiguePenaltyCap: number;
  /** 直近でtopicが切り替わったことによる新鮮さの上限寄与 [0,1] */
  topicChangeBonusWeight: number;
  /** これ以内のtick経過は「直近の切り替わり」とみなす(正整数) */
  recentTopicChangeWindowTicks: number;
  /** 同一topicの継続がこれを超えると停滞とみなす(正整数、`recentTopicChangeWindowTicks`以上) */
  stagnationTicks: number;
  /** 停滞による減点上限 [0,1] */
  stagnationPenaltyCap: number;
};

/**
 * 実データ較正前の仮説的な調整値であり、心理学的妥当性を主張しない(既存Phase 2〜4モジュールと同じ立場)。
 * - `interestMatchWeight = 0.15` / `relatedTopicMatchWeight = 0.08`: 満足度側の他factor
 *   (`cliqueCorrectionCap = 0.2`等)と同程度の桁に揃え、topic一致だけで満足度が支配されないようにする。
 * - `noveltyWeight = 0.12`: 「新しい情報が聞ける」ことを一時的な回復として中庸に評価する。
 * - `repetitionPenaltyCap = 0.1` / `fatiguePenaltyCap = 0.12`: 既知話の繰り返し・使い古された話題への
 *   減点を、離脱の唯一の駆動源にならない程度の中庸値に留める。
 * - `variantDiversityWeight = 0.05`: 補助的な小さい正の寄与。
 * - `topicChangeBonusWeight = 0.05` / `stagnationPenaltyCap = 0.08`: 「話題が変わったばかり」の新鮮さと
 *   「同じ話題が続きすぎている」停滞を、直接の反復ペナルティより小さい寄与として扱う(反復・fatigueの
 *   方がより直接的な信号のため)。
 * - `recentTopicChangeWindowTicks = 3` / `stagnationTicks = 20`: `ContentUtteranceConfig`の
 *   `minTopicDurationTicks`(既定3)・`utteranceIntervalTicks`(既定4)と桁を揃えつつ、
 *   停滞判定は「かなり長く同じ話題が続いた」場合に限定する。
 */
export const DEFAULT_TOPIC_COMPATIBILITY_CONFIG: TopicCompatibilityConfig = {
  interestMatchWeight: 0.15,
  relatedTopicMatchWeight: 0.08,
  noveltyWeight: 0.12,
  repetitionPenaltyCap: 0.1,
  variantDiversityWeight: 0.05,
  fatiguePenaltyCap: 0.12,
  topicChangeBonusWeight: 0.05,
  recentTopicChangeWindowTicks: 3,
  stagnationTicks: 20,
  stagnationPenaltyCap: 0.08,
};

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`topicCompatibility config: ${name} must be a finite number (got ${value})`);
  }
}

function assertRange01(name: string, value: number): void {
  assertFinite(name, value);
  if (value < 0 || value > 1) {
    throw new Error(`topicCompatibility config: ${name} must be within [0, 1] (got ${value})`);
  }
}

function assertPositiveInteger(name: string, value: number): void {
  assertFinite(name, value);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`topicCompatibility config: ${name} must be a positive integer (got ${value})`);
  }
}

/**
 * NaN/Infinity・範囲外・不正な整数を拒否する(既存Phase 2〜4モジュールと同じ方針)。
 * `stagnationTicks >= recentTopicChangeWindowTicks`(相互制約)も検証する。
 */
export function validateTopicCompatibilityConfig(config: TopicCompatibilityConfig): void {
  assertRange01("interestMatchWeight", config.interestMatchWeight);
  assertRange01("relatedTopicMatchWeight", config.relatedTopicMatchWeight);
  assertRange01("noveltyWeight", config.noveltyWeight);
  assertRange01("repetitionPenaltyCap", config.repetitionPenaltyCap);
  assertRange01("variantDiversityWeight", config.variantDiversityWeight);
  assertRange01("fatiguePenaltyCap", config.fatiguePenaltyCap);
  assertRange01("topicChangeBonusWeight", config.topicChangeBonusWeight);
  assertPositiveInteger("recentTopicChangeWindowTicks", config.recentTopicChangeWindowTicks);
  assertPositiveInteger("stagnationTicks", config.stagnationTicks);
  assertRange01("stagnationPenaltyCap", config.stagnationPenaltyCap);
  if (config.stagnationTicks < config.recentTopicChangeWindowTicks) {
    throw new Error(
      `topicCompatibility config: stagnationTicks (${config.stagnationTicks}) must be >= recentTopicChangeWindowTicks (${config.recentTopicChangeWindowTicks})`,
    );
  }
}

validateTopicCompatibilityConfig(DEFAULT_TOPIC_COMPATIBILITY_CONFIG);

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clamp01(value);
}

export type TopicCompatibilityContext = {
  config: TopicCompatibilityConfig;
  tick: number;
  clusterId: string;
  /** そのclusterの公開topic runtime state。未確立/未観測ならundefined */
  clusterTopic: ClusterTopicState | undefined;
  topicCatalog: TopicCatalog;
  claimCatalog: ClaimCatalog;
  /** 評価するagent自身の情報state。observerとして他agentの値を渡さないこと */
  agentInformation: AgentInformationState | undefined;
  /** `ContentUtteranceConfig.fatigueGain`(cluster側fatigue計算に使う、値を複製しない) */
  fatigueGain: number;
  /** `ContentUtteranceConfig.fatigueDecay` */
  fatigueDecay: number;
};

const NEUTRAL_SCORE = 0.5;

/**
 * `clusterTopic`/`agentInformation`/`currentTopicId`のいずれかが欠けている場合の中立結果。
 * `factors: []`により、呼び出し側の`(score - 0.5)`ベースの換算は常に0になる。
 */
function neutralCompatibility(clusterId: string, topicId: string | undefined, tick: number): TopicCompatibility {
  return {
    clusterId,
    topicId,
    score: NEUTRAL_SCORE,
    factors: [],
    unknownClaimCount: 0,
    knownClaimCount: 0,
    observedAtTick: tick,
  };
}

/**
 * issue要件1節の全factor(current topic interest match / related topic match / new information
 * availability / already-known claim repetition / variant diversity / topic fatigue /
 * recent topic change・stagnation)を、agent自身の観測可能な情報だけから決定的に導出する。
 * rngを一切消費せず、`ctx`をmutationしない。
 */
export function computeTopicCompatibility(ctx: TopicCompatibilityContext): TopicCompatibility {
  const { config } = ctx;
  const topicId = ctx.clusterTopic?.currentTopicId;
  if (!topicId || !ctx.agentInformation || !ctx.clusterTopic) {
    return neutralCompatibility(ctx.clusterId, topicId, ctx.tick);
  }
  const clusterTopic = ctx.clusterTopic;
  const agentInformation = ctx.agentInformation;

  const factors: TopicCompatibilityFactor[] = [];
  const topicDef = ctx.topicCatalog.topics.find((t) => t.id === topicId);
  const interest = clampUnit(agentInformation.topics[topicId]?.interest ?? 0);

  // 1. current topic interest match: 支えるだけ(要件2節「topic matchは満足度を一定範囲で支える」)
  const interestMatchContribution = config.interestMatchWeight * interest;
  if (interestMatchContribution > 0) {
    factors.push({ kind: "interestMatch", contribution: interestMatchContribution });
  }

  // 2. related topic match: 直接一致ではないが近接topicへの関心を弱く汲む
  let relatedTopicMatchContribution = 0;
  if (topicDef) {
    for (const relatedId of topicDef.relatedTopicIds) {
      const relatedInterest = clampUnit(agentInformation.topics[relatedId]?.interest ?? 0);
      relatedTopicMatchContribution = Math.max(relatedTopicMatchContribution, config.relatedTopicMatchWeight * relatedInterest);
    }
  }
  if (relatedTopicMatchContribution > 0) {
    factors.push({ kind: "relatedTopicMatch", contribution: relatedTopicMatchContribution });
  }

  const topicClaims = ctx.claimCatalog.claims.filter((claim) => claim.topicId === topicId);
  const knownClaims = topicClaims.filter((claim) => agentInformation.claims[claim.id] !== undefined);
  const unknownClaimCount = topicClaims.length - knownClaims.length;
  const knownClaimCount = knownClaims.length;

  // 3. new information availability(novelty): 未知claim比率。一時的な回復として扱う(要件2節)
  //    ―― 恒久的なtimerを持たず、実際に未知claimが減れば(採用が進めば)自然に逓減する。
  const noveltyRatio = topicClaims.length > 0 ? unknownClaimCount / topicClaims.length : 0;
  const noveltyContribution = config.noveltyWeight * noveltyRatio;
  if (noveltyContribution > 0) {
    factors.push({ kind: "novelty", contribution: noveltyContribution });
  }

  // 4. already-known claim repetition: このclusterで最近話された既知claimの割合 × cluster側の反復強度
  const toldTopicClaims = topicClaims.filter((claim) => clusterTopic.claimLastToldTick[claim.id] !== undefined);
  const knownToldClaims = toldTopicClaims.filter((claim) => agentInformation.claims[claim.id] !== undefined);
  const repetitionRatio = toldTopicClaims.length > 0 ? knownToldClaims.length / toldTopicClaims.length : 0;
  const repetitionIntensity = clampUnit(clusterTopic.repetitionCount / config.stagnationTicks);
  const repetitionContribution = config.repetitionPenaltyCap * repetitionRatio * repetitionIntensity;
  if (repetitionContribution > 0) {
    factors.push({ kind: "repetition", contribution: -repetitionContribution });
  }

  // 5. variant diversity: 既知claimについて、catalog上のvariant総数のうちどれだけ聞けているか
  let catalogVariantTotal = 0;
  let encounteredVariantTotal = 0;
  for (const claim of knownClaims) {
    const claimVariantCount = ctx.claimCatalog.variants.filter((variant) => variant.canonicalClaimId === claim.id).length;
    catalogVariantTotal += claimVariantCount;
    encounteredVariantTotal += agentInformation.claims[claim.id]?.encounteredVariantIds.length ?? 0;
  }
  const diversityRatio = catalogVariantTotal > 0 ? clampUnit(encounteredVariantTotal / catalogVariantTotal) : 0;
  const variantDiversityContribution = config.variantDiversityWeight * diversityRatio;
  if (variantDiversityContribution > 0) {
    factors.push({ kind: "variantDiversity", contribution: variantDiversityContribution });
  }

  // 6. topic fatigue: cluster側の「使い古され度」(`conversationTopic.ts`の既存純粋関数を再利用)
  const fatigue = computeClusterTopicFatigue(clusterTopic, topicId, ctx.fatigueGain, ctx.fatigueDecay);
  const fatigueContribution = config.fatiguePenaltyCap * fatigue;
  if (fatigueContribution > 0) {
    factors.push({ kind: "fatigue", contribution: -fatigueContribution });
  }

  // 7. recent topic change(正) / stagnation(負): 相互排他(直近切り替え window と停滞閾値は重ならない)
  const topicStartedTick = clusterTopic.topicStartedTick ?? ctx.tick;
  const ticksSinceTopicStart = Math.max(0, ctx.tick - topicStartedTick);
  let topicChangeContribution = 0;
  if (ticksSinceTopicStart <= config.recentTopicChangeWindowTicks) {
    topicChangeContribution = config.topicChangeBonusWeight * interest;
  } else if (ticksSinceTopicStart >= config.stagnationTicks) {
    const stagnationRatio = clampUnit((ticksSinceTopicStart - config.stagnationTicks) / config.stagnationTicks);
    topicChangeContribution = -config.stagnationPenaltyCap * stagnationRatio;
  }
  if (topicChangeContribution !== 0) {
    factors.push({ kind: "topicChange", contribution: topicChangeContribution });
  }

  factors.sort((a, b) => b.contribution - a.contribution);
  const total = factors.reduce((sum, factor) => sum + factor.contribution, 0);
  const score = clamp01(NEUTRAL_SCORE + total);

  return {
    clusterId: ctx.clusterId,
    topicId,
    score,
    factors,
    unknownClaimCount,
    knownClaimCount,
    observedAtTick: ctx.tick,
  };
}

/**
 * Phase 5全体のgate + 会話満足度／他クラスタ関心へ渡すfactorの換算係数。`enabled: false`(既定)の間は
 * `engine.ts`がこの設定に基づく計算を一切行わず、`ConversationSatisfactionUpdateContext.topicContribution`
 * /`AlternativeClusterInterestContext.topicIntegration`のいずれも未設定のまま呼び出す
 * (issue受入条件: disabled/topicなしの場合にPhase 4までの満足度・transition結果・PRNG系列が維持される)。
 */
export type TopicIntegrationConfig = {
  enabled: boolean;
  compatibility: TopicCompatibilityConfig;
  /** compatibility scoreの中立(0.5)からの乖離を満足度寄与へ変換する係数 [0,1] */
  satisfactionWeight: number;
  /** 満足度への1tickあたりの寄与の絶対値上限 [0,1] */
  satisfactionContributionCap: number;
  /** `AlternativeClusterInterest`のinformationOpportunity factorの上限寄与 [0,1](既存social要因とは別枠) */
  informationSeekingWeight: number;
  /** これ以上のinformationOpportunity寄与を「情報探索が主要因」とみなす閾値 [0,1] */
  minInformationOpportunityScore: number;
  /** 現在clusterの負のtopic factor合計がこれ以上ならtopicMismatch/topicFatigueへ主要因を差し替える [0,1] */
  topicMismatchThreshold: number;
  /** informationOpportunity寄与がこれ以上なら"novelInformationOpportunity"(それ未満は"informationSeeking") [0,1] */
  novelInformationOpportunityThreshold: number;
};

/**
 * - `satisfactionWeight = 0.4` / `satisfactionContributionCap = 0.08`: 満足度全体
 *   (`satisfactionDecayPerTick = 0.01`等)に対して、topic factorが1tickで支配的にならない中庸値。
 * - `informationSeekingWeight = 0.2`: 既存`knownParticipantWeight`(0.25)と同程度の桁。
 * - `minInformationOpportunityScore = 0.08`: 弱い寄与だけでは情報探索と判定しない下限。
 * - `topicMismatchThreshold = 0.06`: 満足度側の中庸penalty cap(`repetitionPenaltyCap`等、約0.1)の
 *   半分程度が閾値。
 * - `novelInformationOpportunityThreshold = 0.15`: `informationSeekingWeight`(0.2)の大部分を占める
 *   強い新規性のときだけ「novel」と区別する。
 */
export const DEFAULT_TOPIC_INTEGRATION_CONFIG: TopicIntegrationConfig = {
  enabled: false,
  compatibility: DEFAULT_TOPIC_COMPATIBILITY_CONFIG,
  satisfactionWeight: 0.4,
  satisfactionContributionCap: 0.08,
  informationSeekingWeight: 0.2,
  minInformationOpportunityScore: 0.08,
  topicMismatchThreshold: 0.06,
  novelInformationOpportunityThreshold: 0.15,
};

export function validateTopicIntegrationConfig(config: TopicIntegrationConfig): void {
  validateTopicCompatibilityConfig(config.compatibility);
  assertRange01("satisfactionWeight", config.satisfactionWeight);
  assertRange01("satisfactionContributionCap", config.satisfactionContributionCap);
  assertRange01("informationSeekingWeight", config.informationSeekingWeight);
  assertRange01("minInformationOpportunityScore", config.minInformationOpportunityScore);
  assertRange01("topicMismatchThreshold", config.topicMismatchThreshold);
  assertRange01("novelInformationOpportunityThreshold", config.novelInformationOpportunityThreshold);
}

validateTopicIntegrationConfig(DEFAULT_TOPIC_INTEGRATION_CONFIG);

/**
 * `TopicCompatibility.score`(0.5中立)を、会話満足度へ加算してよい符号付き寄与へ変換する
 * (issue要件2節: topicが未設定/Phase 5 disabledの場合は既存式と同一結果 ―― `factors: []`のとき
 * `score === 0.5`なので、この関数は常に0を返す)。`satisfactionContributionCap`で頭打ちにする。
 */
export function deriveSatisfactionContribution(compatibility: TopicCompatibility, config: TopicIntegrationConfig): number {
  const raw = (compatibility.score - NEUTRAL_SCORE) * 2 * config.satisfactionWeight;
  return Math.min(config.satisfactionContributionCap, Math.max(-config.satisfactionContributionCap, raw));
}

/** そのtopicの未知claim比率(0..1)。observed candidateの情報探索関心スコアに使う */
export function noveltyRatioOf(compatibility: TopicCompatibility): number {
  const total = compatibility.unknownClaimCount + compatibility.knownClaimCount;
  return total > 0 ? compatibility.unknownClaimCount / total : 0;
}
