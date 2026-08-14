/**
 * Issue #232 (Phase 5, roadmap #172): `docs/information-propagation-phase5-model.md`(#228 ADR)
 * §4.4/§5/§6の契約に基づく、retelling(再伝達)のdecision評価とClaimVariant変容の実行境界。
 *
 * `evaluateRetellingDecision`はrngを一切受け取らない純粋関数(§4.4「評価はpure function」) ――
 * memory strength・confidence・topic interest・retelling tendency・直近retold tick・source distance・
 * cluster topicの一致から、mutationを試みる確率と「もし試みるなら」の方針を決定的に計算するだけである。
 * 実際の抽選(mutateするか)とfactor選択・variant生成は`deriveRetellingOutcome`(engine境界、entity-key
 * 派生streamでrngを消費する)が行う(§5.2)。`claimVariant.ts`のmutation規則・dedup・lineage・上限判定を
 * そのまま呼び出すだけで、ここでは意味変換規則を再実装しない。truth判定・自由文章生成は行わない。
 *
 * `contentUtterance.ts`は`reason === "knownClaimShare"`(既に受信/記憶を経た既知claimを話す)の場合に
 * だけこのモジュールを呼ぶ ―― 自分が最初に持っていた情報を初めて話す(`originalShare`)場合はretellingでは
 * ない(§4.4)。
 */
import type { ClaimCatalog, ClaimMeaning, ClaimMutationFactor, ClaimVariant, InformationClaim } from "./informationModel";
import { applyMutationFactor, generateVariant, isMutationKindApplicable, MUTATION_KINDS } from "./claimVariant";
import type { AgentClaimState, AgentInformationProfile, InformationPropagationLimits, RetellingConfig } from "./informationState";
import { clampUnit } from "./informationState";
import { SeededRandom } from "./random";

// --- RetellingDecision(§4.4「評価はpure function」) ---------------------------------------------

export type RetellingDecisionFactorKey =
  | "memoryStrength"
  | "confidence"
  | "topicInterest"
  | "retellingTendency"
  | "recency"
  | "sourceDistance"
  | "clusterTopicAffinity";

export type RetellingDecisionFactor = { key: RetellingDecisionFactorKey; rawValue: number; contribution: number };

export type RetellingDecisionPrimaryReason = RetellingDecisionFactorKey | "mutationDisabled" | "cooldownActive" | "sameClusterRepeatLimit";

export type RetellingDecision = {
  eligible: boolean;
  speakerId: string;
  claimId: string;
  sourceVariantId: string;
  /** mutationを試みる確率。[0, 1]。`eligible: false`のときは常に0(drawを行わないため) */
  probability: number;
  /** 「試みるならmutateする」という決定的な方針の label。実際の結果は`deriveRetellingOutcome`のdrawで決まる */
  selectedPolicy: "faithful" | "mutate";
  factors: RetellingDecisionFactor[];
  primaryReason: RetellingDecisionPrimaryReason;
};

/** decision内部係数(configでは公開しない、他モジュールのcandidate weight同様のhardcoded値) */
const DECISION_COEFFICIENTS: Record<RetellingDecisionFactorKey, number> = {
  memoryStrength: 0.15,
  confidence: 0.1,
  topicInterest: 0.1,
  retellingTendency: 0.15,
  recency: 0.1,
  sourceDistance: 0.15,
  clusterTopicAffinity: 0.05,
};

export type RetellingDecisionInput = {
  tick: number;
  speakerId: string;
  claim: InformationClaim;
  claimState: AgentClaimState;
  profile: AgentInformationProfile;
  parentVariant: ClaimVariant;
  clusterCurrentTopicId?: string;
  limits: InformationPropagationLimits;
  config: RetellingConfig;
  /** このclusterでこのvariantが既に語られた回数(呼び出し側が`RetellingRuntimeState`から解決する) */
  sameClusterTellCount: number;
};

/**
 * mutationを試みるかどうかの確率と、もし低confidence/低memoryならdetail omissionが増えるといった
 * 候補要因(issue #232 §5)を構造化して返す。memory strengthが低いほど・confidenceが低いほど・
 * source distanceが遠いほどcontributionが増える(=drift寄り)。`certaintyShift`と`confidence`を
 * 直接同一視しない(§6.2) ―― `confidence`はここではdecisionのinput factorの1つに過ぎず、
 * `claimVariant.ts`の`certaintyShift`はmeaning上のqualifierだけを操作しconfidenceを書き換えない。
 */
export function evaluateRetellingDecision(input: RetellingDecisionInput): RetellingDecision {
  const cooldownOk =
    input.claimState.lastRetoldTick === undefined || input.tick - input.claimState.lastRetoldTick >= input.config.retellingCooldownTicks;
  const repeatOk = input.sameClusterTellCount < input.config.sameClusterVariantRepeatLimit;
  const mutationEnabled = input.config.mutationEnabled;
  const eligible = mutationEnabled && cooldownOk && repeatOk;

  const rawMemoryWeakness = clampUnit(1 - input.claimState.memoryStrength);
  const rawConfidenceGap = clampUnit(1 - input.claimState.confidence);
  const rawTopicInterest = clampUnit(input.profile.baselineTopicInterest[input.claim.topicId] ?? 0);
  const rawRetellingTendency = clampUnit(input.profile.retellingTendency);
  const cooldownWindow = Math.max(1, input.config.retellingCooldownTicks * 2);
  const ticksSinceRetold = input.claimState.lastRetoldTick === undefined ? cooldownWindow : input.tick - input.claimState.lastRetoldTick;
  const rawRecency = clampUnit(ticksSinceRetold / cooldownWindow);
  const rawSourceDistance = clampUnit(input.parentVariant.lineageDepth / Math.max(1, input.limits.maxLineageDepth));
  const rawClusterTopicAffinity = input.clusterCurrentTopicId === input.claim.topicId ? 1 : 0;

  const factors: RetellingDecisionFactor[] = [
    { key: "memoryStrength", rawValue: rawMemoryWeakness, contribution: DECISION_COEFFICIENTS.memoryStrength * rawMemoryWeakness },
    { key: "confidence", rawValue: rawConfidenceGap, contribution: DECISION_COEFFICIENTS.confidence * rawConfidenceGap },
    { key: "topicInterest", rawValue: rawTopicInterest, contribution: DECISION_COEFFICIENTS.topicInterest * rawTopicInterest },
    {
      key: "retellingTendency",
      rawValue: rawRetellingTendency,
      contribution: DECISION_COEFFICIENTS.retellingTendency * rawRetellingTendency,
    },
    { key: "recency", rawValue: rawRecency, contribution: DECISION_COEFFICIENTS.recency * rawRecency },
    { key: "sourceDistance", rawValue: rawSourceDistance, contribution: DECISION_COEFFICIENTS.sourceDistance * rawSourceDistance },
    {
      key: "clusterTopicAffinity",
      rawValue: rawClusterTopicAffinity,
      contribution: DECISION_COEFFICIENTS.clusterTopicAffinity * rawClusterTopicAffinity,
    },
  ];

  const factorSum = factors.reduce((sum, factor) => sum + factor.contribution, 0);
  const probability = eligible ? clampUnit(input.config.baseMutationProbability + factorSum) : 0;
  const selectedPolicy: "faithful" | "mutate" = eligible && probability > 0 ? "mutate" : "faithful";

  let primaryReason: RetellingDecisionPrimaryReason;
  if (!mutationEnabled) primaryReason = "mutationDisabled";
  else if (!cooldownOk) primaryReason = "cooldownActive";
  else if (!repeatOk) primaryReason = "sameClusterRepeatLimit";
  else {
    primaryReason = factors.reduce((best, factor) => (Math.abs(factor.contribution) > Math.abs(best.contribution) ? factor : best)).key;
  }

  return {
    eligible,
    speakerId: input.speakerId,
    claimId: input.claim.id,
    sourceVariantId: input.parentVariant.id,
    probability,
    selectedPolicy,
    factors,
    primaryReason,
  };
}

// --- RetellingEvent(ADR §4.4) --------------------------------------------------------------------

export type RetellingResult = "faithful" | "mutated" | "variantReused" | "blockedByLimit";

export type RetellingEventFactor = { key: string; rawValue: number; contribution: number };

export type RetellingEvent = {
  id: string;
  tick: number;
  clusterId: string;
  speakerId: string;
  claimId: string;
  inputVariantId: string;
  outputVariantId?: string;
  sourceReceptionIds: string[];
  sourceTraceIds: string[];
  /** `blockedByLimit`のときはundefined(ContentUtteranceを生成しないため)。それ以外は呼び出し側が確定後に埋める */
  contentUtteranceId?: string;
  result: RetellingResult;
  factors: RetellingDecisionFactor[];
  mutationFactors: ClaimMutationFactor[];
  probability?: number;
  draw?: number;
  blockedReason?: "variantLimit" | "lineageDepthLimit" | "distanceCeiling";
};

// --- RetellingRuntimeState(同一cluster内の同一variant反復上限、§9の候補要因) -----------------------

/** clusterId -> variantId -> そのclusterで語られた累計回数。Reset/scenario切替で破棄する run-scoped state */
export type RetellingRuntimeState = Record<string, Record<string, number>>;

export function getClusterVariantTellCount(state: RetellingRuntimeState, clusterId: string, variantId: string): number {
  return state[clusterId]?.[variantId] ?? 0;
}

/** 非破壊でtell countを1増やす(§5「原子的commit」の一部として、ContentUtterance生成成功時にだけ呼ぶ) */
export function withClusterVariantTellIncrement(state: RetellingRuntimeState, clusterId: string, variantId: string): RetellingRuntimeState {
  const clusterCounts = state[clusterId] ?? {};
  const nextCount = (clusterCounts[variantId] ?? 0) + 1;
  return { ...state, [clusterId]: { ...clusterCounts, [variantId]: nextCount } };
}

// --- RNG(§5.2) ------------------------------------------------------------------------------------

const RNG_NAMESPACE = "standing-party-retelling-v1";

/** FNV-1a風の単純な文字列ハッシュ(他Phase 5モジュールと同じ表現専用パターン) */
function hashString(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 本体`SeededRandom`とは独立した、論理decisionごとのentity-key派生stream(§5.2) */
function deriveRetellingRandom(seed: number, stage: string, ...parts: (string | number)[]): SeededRandom {
  return new SeededRandom(hashString([seed, RNG_NAMESPACE, stage, ...parts].join(":")));
}

// --- outcome(§5.2 `retelling-mutation`/`mutation-factor`stage、§6.3 dedup・lineage) --------------

export type RetellingContext = {
  tick: number;
  clusterId: string;
  speakerId: string;
  claim: InformationClaim;
  parentVariant: ClaimVariant;
  claimState: AgentClaimState;
  profile: AgentInformationProfile;
  clusterCurrentTopicId?: string;
  /** 既存fixture catalog + このtickまでに生成済みの全variantをmergeしたもの(呼び出し側の責務) */
  catalog: ClaimCatalog;
  limits: InformationPropagationLimits;
  config: RetellingConfig;
  retellingRuntime: RetellingRuntimeState;
  runSeed: number;
};

export type RetellingOutcome = {
  decision: RetellingDecision;
  event: RetellingEvent;
  /** 実際に話すべきvariant ID。`suppressed: true`のときは意味を持たない(利用しないこと) */
  variantId: string;
  /** `result === "mutated"`のときだけ設定される、catalogへ追記すべき新規variant */
  generatedVariant?: ClaimVariant;
  /** trueなら`result === "blockedByLimit"`。呼び出し側はContentUtterance/SpeechEventを生成してはならない(ADR §4.4) */
  suppressed: boolean;
};

function faithfulOutcome(ctx: RetellingContext, decision: RetellingDecision, eventId: string, draw?: number): RetellingOutcome {
  return {
    decision,
    variantId: ctx.parentVariant.id,
    suppressed: false,
    event: {
      id: eventId,
      tick: ctx.tick,
      clusterId: ctx.clusterId,
      speakerId: ctx.speakerId,
      claimId: ctx.claim.id,
      inputVariantId: ctx.parentVariant.id,
      outputVariantId: ctx.parentVariant.id,
      sourceReceptionIds: sourceReceptionIdsOf(ctx.claimState),
      sourceTraceIds: sourceTraceIdsOf(ctx.claimState),
      contentUtteranceId: undefined,
      result: "faithful",
      factors: decision.factors,
      mutationFactors: [],
      probability: decision.probability,
      draw,
    },
  };
}

function sourceReceptionIdsOf(claimState: AgentClaimState): string[] {
  return claimState.sourceTraces
    .filter((trace) => trace.kind === "heardUtterance" && trace.receptionId !== undefined)
    .map((trace) => trace.receptionId as string)
    .sort();
}

function sourceTraceIdsOf(claimState: AgentClaimState): string[] {
  return [...claimState.sourceTraces.map((trace) => trace.id)].sort();
}

/**
 * 適用可能な`ClaimMutationKind`ごとに、`config.factorWeights[kind]`を確率とした独立Bernoulli drawを
 * 固定順(`MUTATION_KINDS`)で行い、成功したfactorだけを順に適用する(§5.2「factorごと最大1 draw」)。
 * 0件成功の場合は`factors: []`を返す(呼び出し側はfaithfulへfallbackする)。
 */
function selectAppliedMutationFactors(ctx: RetellingContext, eventId: string): { meaning: ClaimMeaning; factors: ClaimMutationFactor[] } {
  let meaning = ctx.parentVariant.meaning;
  const factors: ClaimMutationFactor[] = [];
  for (const kind of MUTATION_KINDS) {
    if (!isMutationKindApplicable(meaning, kind)) continue;
    const weight = clampUnit(ctx.config.factorWeights[kind]);
    if (weight <= 0) continue;
    const rng = deriveRetellingRandom(ctx.runSeed, "mutation-factor", eventId, kind);
    if (!rng.chance(weight)) continue;
    const applied = applyMutationFactor(meaning, kind);
    if (!applied) continue;
    meaning = applied.meaning;
    factors.push(applied.factor);
  }
  return { meaning, factors };
}

/**
 * ADR §5 step5(必要ならretelling・variant変容を決定): `evaluateRetellingDecision`の結果を受けて、
 * 実際にmutateするかのdraw(`retelling-mutation`stage)・factor選択・`claimVariant.generateVariant`
 * によるdedup/lineage/上限判定までを一括で行う。`contentUtteranceId`は呼び出し側がContentUtterance生成
 * 成功後に埋める(この関数を呼ぶ時点ではまだ存在しない)。
 */
export function deriveRetellingOutcome(ctx: RetellingContext): RetellingOutcome {
  const decision = evaluateRetellingDecision({
    tick: ctx.tick,
    speakerId: ctx.speakerId,
    claim: ctx.claim,
    claimState: ctx.claimState,
    profile: ctx.profile,
    parentVariant: ctx.parentVariant,
    clusterCurrentTopicId: ctx.clusterCurrentTopicId,
    limits: ctx.limits,
    config: ctx.config,
    sameClusterTellCount: getClusterVariantTellCount(ctx.retellingRuntime, ctx.clusterId, ctx.parentVariant.id),
  });

  const eventId = `retelling-${ctx.tick}-${ctx.clusterId}-${ctx.speakerId}-${ctx.claim.id}`;

  if (decision.selectedPolicy === "faithful") {
    return faithfulOutcome(ctx, decision, eventId);
  }

  const mutateRng = deriveRetellingRandom(ctx.runSeed, "retelling-mutation", ctx.speakerId, ctx.claim.id, ctx.parentVariant.id);
  const draw = mutateRng.next();
  if (draw >= decision.probability) {
    return faithfulOutcome(ctx, decision, eventId, draw);
  }

  const { meaning: nextMeaning, factors: appliedFactors } = selectAppliedMutationFactors(ctx, eventId);
  if (appliedFactors.length === 0) {
    return faithfulOutcome(ctx, decision, eventId, draw);
  }

  const genResult = generateVariant({
    catalog: ctx.catalog,
    parent: ctx.parentVariant,
    claim: ctx.claim,
    appliedFactors,
    nextMeaning,
    tick: ctx.tick,
    generatorAgentId: ctx.speakerId,
    retellingEventId: eventId,
    limits: ctx.limits,
    semanticDistanceCeiling: ctx.config.semanticDistanceCeiling,
  });

  if (genResult.status === "blocked") {
    return {
      decision,
      variantId: ctx.parentVariant.id,
      suppressed: true,
      event: {
        id: eventId,
        tick: ctx.tick,
        clusterId: ctx.clusterId,
        speakerId: ctx.speakerId,
        claimId: ctx.claim.id,
        inputVariantId: ctx.parentVariant.id,
        outputVariantId: undefined,
        sourceReceptionIds: sourceReceptionIdsOf(ctx.claimState),
        sourceTraceIds: sourceTraceIdsOf(ctx.claimState),
        contentUtteranceId: undefined,
        result: "blockedByLimit",
        factors: decision.factors,
        mutationFactors: appliedFactors,
        probability: decision.probability,
        draw,
        blockedReason: genResult.reason,
      },
    };
  }

  const result: RetellingResult = genResult.status === "created" ? "mutated" : "variantReused";
  return {
    decision,
    variantId: genResult.variant.id,
    suppressed: false,
    generatedVariant: genResult.status === "created" ? genResult.variant : undefined,
    event: {
      id: eventId,
      tick: ctx.tick,
      clusterId: ctx.clusterId,
      speakerId: ctx.speakerId,
      claimId: ctx.claim.id,
      inputVariantId: ctx.parentVariant.id,
      outputVariantId: genResult.variant.id,
      sourceReceptionIds: sourceReceptionIdsOf(ctx.claimState),
      sourceTraceIds: sourceTraceIdsOf(ctx.claimState),
      contentUtteranceId: undefined,
      result,
      factors: decision.factors,
      mutationFactors: appliedFactors,
      probability: decision.probability,
      draw,
    },
  };
}
