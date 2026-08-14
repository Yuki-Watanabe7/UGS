/**
 * Issue #231 (Phase 5, roadmap #172): `docs/information-propagation-phase5-model.md`(#228 ADR)
 * §4/§5/§9の契約に基づく、`ContentUtteranceEvent`(#230)から受け手別の受信(reception)・理解・採用
 * (adoption)・記憶更新(memory)・provenance(source trace)を計算する純粋関数群。
 *
 * このモジュールが行わないこと(ADR §10の禁止事項):
 * - `SpeechActiveEffect`等の既存social speech effectの生成(`speechEffects.ts`の責務のまま)
 * - 本体`SeededRandom`の消費(§5.2どおり、`runSeed`からentity-key派生streamを作る)
 * - canonical claim/variantの変容(retelling/mutationは#232)
 *
 * `SimulationState`は一切参照/変更しない。`engine.ts`が既存Phase 1〜4処理・social `SpeechEvent`の
 * 認知/解釈/効果登録・#230の内容発話生成が全て終わった後段でだけこのモジュールを呼ぶ(ADR §5)。
 */
import type { Agent, GroupCandidate } from "./types";
import type { ClaimCatalog, InformationClaim } from "./informationModel";
import type {
  AgentClaimState,
  ClaimAwareness,
  InformationPropagationLimits,
  InformationRuntimeState,
  InformationTransmissionConfig,
  SourceTrace,
} from "./informationState";
import { addSourceTrace, clampUnit, withAgentClaimState } from "./informationState";
import type { ContentUtteranceEvent } from "./contentUtterance";
import type { SpeechEvent } from "./speech";
import type { SpeechReceiverCandidate, SpeechReceptionEvent, SpeechTrustResolver } from "./speechEffects";
import { deriveAuditoryReceptions } from "./speechEffects";
import { SeededRandom } from "./random";

// --- 因果event型(§4) --------------------------------------------------------------------------

export type InformationComprehension = "notHeard" | "heardNotUnderstood" | "understood";

export type InformationReceptionEvent = {
  id: string;
  tick: number;
  contentUtteranceId: string;
  speechReceptionEventId: string;
  receiverId: string;
  speakerId: string;
  clusterId: string;
  claimId: string;
  variantId: string;
  heard: boolean;
  comprehension: InformationComprehension;
  comprehensionFactors: Array<{ key: string; contribution: number }>;
};

export type AdoptionResult = "adopted" | "rejected" | "uncertain" | "alreadyKnown";

export type InformationAdoptionFactorKey =
  | "speakerTrust"
  | "relationshipTie"
  | "topicInterest"
  | "priorConfidence"
  | "sourceRepetition"
  | "sourceDiversity"
  | "variantCompatibility"
  | "claimVerifiability"
  | "utteranceStrength";

export type InformationAdoptionFactor = {
  key: InformationAdoptionFactorKey;
  rawValue: number;
  contribution: number;
};

export type InformationAdoptionEvent = {
  id: string;
  tick: number;
  receiverId: string;
  claimId: string;
  consideredVariantIds: string[];
  receptionEventIds: string[];
  result: AdoptionResult;
  previousConfidence: number;
  nextConfidence: number;
  confidenceDelta: number;
  factors: InformationAdoptionFactor[];
  draw?: number;
  probability?: number;
};

export type InformationMemoryUpdateReason = "firstExposure" | "reinforced" | "variantEncountered" | "forgotten" | "relearned";

export type InformationMemoryUpdateEvent = {
  id: string;
  tick: number;
  receiverId: string;
  claimId: string;
  adoptionEventId?: string;
  receptionEventIds: string[];
  reason: InformationMemoryUpdateReason;
  previousAwareness?: ClaimAwareness;
  nextAwareness: ClaimAwareness;
  previousMemoryStrength: number;
  nextMemoryStrength: number;
  sourceTraceIdsAdded: string[];
};

// --- RNG(§5.2) ----------------------------------------------------------------------------------

const RNG_NAMESPACE = "standing-party-information-transmission-v1";

/** FNV-1a風の単純な文字列ハッシュ(`contentUtterance.ts`/`informationState.ts`と同じ表現専用パターン) */
function hashString(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 本体`SeededRandom`とは独立した、論理decisionごとのentity-key派生stream(§5.2、`adoption`stage) */
function deriveTransmissionRandom(seed: number, stage: string, ...parts: (string | number)[]): SeededRandom {
  return new SeededRandom(hashString([seed, RNG_NAMESPACE, stage, ...parts].join(":")));
}

// --- decay / forget(§4.3、§8.2 lazy + scheduled) -------------------------------------------------

/** `lastMemoryEvaluationTick`からの経過tickぶんだけ減衰させた、`tick`時点の閉形式memoryStrengthを返す */
function decayedMemoryStrength(claimState: AgentClaimState, tick: number, config: InformationTransmissionConfig): number {
  const elapsed = Math.max(0, tick - claimState.lastMemoryEvaluationTick);
  return Math.max(0, claimState.memoryStrength - config.memoryDecayPerTick * elapsed);
}

/**
 * `memoryStrength`が`forgetThreshold`を下回る(であろう)tickを計算する。減衰しない設定
 * (`memoryDecayPerTick <= 0`)では`undefined`(forgetさせない)。
 */
function computeForgetAtTick(memoryStrength: number, tick: number, config: InformationTransmissionConfig): number | undefined {
  if (config.memoryDecayPerTick <= 0) return undefined;
  if (memoryStrength <= config.forgetThreshold) return tick;
  const ticksUntilForget = (memoryStrength - config.forgetThreshold) / config.memoryDecayPerTick;
  return tick + Math.ceil(ticksUntilForget);
}

/**
 * `applyScheduledForgetting`の戻り値。すべて新しいオブジェクト/配列(入力はmutationしない)。
 */
export type ScheduledForgettingResult = {
  runtime: InformationRuntimeState;
  memoryUpdates: InformationMemoryUpdateEvent[];
};

/**
 * このtickでdueになった(`forgetAtTick <= tick`)claim stateだけを`forgotten`へ遷移させる、純粋な
 * scheduled decay処理(§4.3: 「thresholdを跨いだtickで1回だけ`forgotten`を記録する」、§8.2: 「memory
 * decayはscheduled threshold処理とlazy評価を使い、毎tick O(agent × claim)走査を禁止する」)。
 *
 * `forgetAtTick`が設定されているclaim stateは「そのagentが実際に聞いた/保持したことがあるclaim」
 * だけ(`AgentClaimState`はagentごとの疎なmapであり、catalog全体を持たない)なので、この関数は
 * 「全agent×全catalog claim」ではなく「各agentが既に知っているclaimのうちdueなものだけ」を走査する。
 * source trace・firstHeardTickは保持したまま`awareness: "forgotten"`にするだけで削除しない
 * (受入条件: forget後もsource traceと履歴を追跡できる)。
 */
export function applyScheduledForgetting(
  runtime: InformationRuntimeState,
  tick: number,
  config: InformationTransmissionConfig,
): ScheduledForgettingResult {
  const memoryUpdates: InformationMemoryUpdateEvent[] = [];
  let nextRuntime = runtime;

  const agentIds = Object.keys(runtime).sort();
  for (const agentId of agentIds) {
    const claimIds = Object.keys(runtime[agentId].claims).sort();
    for (const claimId of claimIds) {
      const claimState = nextRuntime[agentId].claims[claimId];
      if (claimState.forgetAtTick === undefined || claimState.forgetAtTick > tick) continue;
      if (claimState.awareness === "forgotten") continue;

      const nextMemoryStrength = clampUnit(decayedMemoryStrength(claimState, tick, config));
      const nextClaimState: AgentClaimState = {
        ...claimState,
        awareness: "forgotten",
        memoryStrength: nextMemoryStrength,
        lastMemoryEvaluationTick: tick,
        forgetAtTick: undefined,
      };
      nextRuntime = withAgentClaimState(nextRuntime, agentId, nextClaimState);

      memoryUpdates.push({
        id: `info-memory-${tick}-${agentId}-${claimId}-decay`,
        tick,
        receiverId: agentId,
        claimId,
        adoptionEventId: undefined,
        receptionEventIds: [],
        reason: "forgotten",
        previousAwareness: claimState.awareness,
        nextAwareness: "forgotten",
        previousMemoryStrength: claimState.memoryStrength,
        nextMemoryStrength,
        sourceTraceIdsAdded: [],
      });
    }
  }

  return { runtime: nextRuntime, memoryUpdates };
}

// --- reception(§4.1、§3.3の認知契約再利用) -------------------------------------------------------

function sortById<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** confirmed clusterへ正式加入(joined)しているmemberだけをreceiver候補にする(ADR §3.3) */
function confirmedClusterAudience(clusterId: string, agents: readonly Agent[]): SpeechReceiverCandidate[] {
  return sortById(agents.filter((agent) => agent.state === "joined" && agent.joinedGroupId === clusterId)).map((agent) => ({
    id: agent.id,
    x: agent.x,
    y: agent.y,
    state: agent.state,
  }));
}

/**
 * receiverの理解度を、話題への関心とclaimのverifiabilityから決定的に計算する(rngを使わない、
 * §5.2の"deterministic rule"に該当)。`heard: false`は呼び出し側で"notHeard"として扱う。
 */
function computeComprehension(
  receiver: Agent,
  claimDefinition: InformationClaim,
  informationRuntime: InformationRuntimeState,
): { score: number; factors: Array<{ key: string; contribution: number }> } {
  const topicInterest =
    informationRuntime[receiver.id]?.profile.baselineTopicInterest[claimDefinition.topicId] ??
    informationRuntime[receiver.id]?.topics[claimDefinition.topicId]?.interest ??
    0;
  const verifiabilityBonus = claimDefinition.verifiability === "verifiable" ? 0.1 : 0;

  const baseline = 0.4;
  const interestContribution = 0.4 * topicInterest;
  const score = clampUnit(baseline + interestContribution + verifiabilityBonus);

  return {
    score,
    factors: [
      { key: "baseline", contribution: baseline },
      { key: "topicInterest", contribution: interestContribution },
      { key: "claimVerifiability", contribution: verifiabilityBonus },
    ],
  };
}

export type InformationReceptionDerivationResult = {
  speechReceptions: SpeechReceptionEvent[];
  informationReceptions: InformationReceptionEvent[];
};

/**
 * このtickの`ContentUtteranceEvent`から、confirmed clusterのjoined member(発話者本人を除く)ごとに
 * `SpeechReceptionEvent`(距離/audibility判定、carrier `SpeechEvent`へ`deriveAuditoryReceptions`を適用)
 * と`InformationReceptionEvent`(heard/comprehension)を導出する。同席だけで無条件heardにせず、また
 * speaker自身・非joined agentをreceiver候補にしない(ADR §3.3・受入条件)。
 *
 * 同一`contentUtteranceId + receiverId`は`Map`で畳み、二重生成しない(§4.1)。
 */
export function deriveInformationReceptions(
  tick: number,
  contentUtterances: readonly ContentUtteranceEvent[],
  contentSpeechEvents: readonly SpeechEvent[],
  agents: readonly Agent[],
  groupCandidates: readonly GroupCandidate[],
  claimCatalog: ClaimCatalog,
  informationRuntime: InformationRuntimeState,
  config: InformationTransmissionConfig,
): InformationReceptionDerivationResult {
  const speechById = new Map(contentSpeechEvents.map((speech) => [speech.id, speech]));
  const claimById = new Map(claimCatalog.claims.map((claim) => [claim.id, claim]));
  const confirmedClusterIds = new Set(
    groupCandidates.filter((candidate) => candidate.status === "confirmed").map((candidate) => candidate.id),
  );

  const speechReceptionsById = new Map<string, SpeechReceptionEvent>();
  const informationReceptionsById = new Map<string, InformationReceptionEvent>();

  for (const utterance of sortById(contentUtterances)) {
    if (!confirmedClusterIds.has(utterance.clusterId)) continue;
    const speech = speechById.get(utterance.speechEventId);
    const claimDefinition = claimById.get(utterance.claimId);
    if (!speech || !claimDefinition) continue;

    const audience = confirmedClusterAudience(utterance.clusterId, agents);
    const receptions = deriveAuditoryReceptions([speech], audience);

    for (const reception of receptions) {
      if (!speechReceptionsById.has(reception.id)) speechReceptionsById.set(reception.id, reception);

      const infoReceptionId = `info-reception-${utterance.id}-${reception.receiverId}`;
      if (informationReceptionsById.has(infoReceptionId)) continue;

      const receiver = agents.find((agent) => agent.id === reception.receiverId);
      if (!receiver) continue;

      let comprehension: InformationComprehension;
      let factors: Array<{ key: string; contribution: number }>;
      if (!reception.heard) {
        comprehension = "notHeard";
        factors = [];
      } else {
        const computed = computeComprehension(receiver, claimDefinition, informationRuntime);
        comprehension = computed.score >= config.comprehensionThreshold ? "understood" : "heardNotUnderstood";
        factors = computed.factors;
      }

      informationReceptionsById.set(infoReceptionId, {
        id: infoReceptionId,
        tick,
        contentUtteranceId: utterance.id,
        speechReceptionEventId: reception.id,
        receiverId: reception.receiverId,
        speakerId: utterance.speakerId,
        clusterId: utterance.clusterId,
        claimId: utterance.claimId,
        variantId: utterance.variantId,
        heard: reception.heard,
        comprehension,
        comprehensionFactors: factors,
      });
    }
  }

  return {
    speechReceptions: Array.from(speechReceptionsById.values()),
    informationReceptions: Array.from(informationReceptionsById.values()),
  };
}

// --- adoption(§4.2) ------------------------------------------------------------------------------

function computeAdoptionFactors(
  receiver: Agent,
  group: readonly InformationReceptionEvent[],
  existing: AgentClaimState | undefined,
  claimDefinition: InformationClaim,
  informationRuntime: InformationRuntimeState,
  agentsById: Map<string, Agent>,
  speechByUtteranceId: Map<string, SpeechEvent>,
  resolveTrust: SpeechTrustResolver,
  resolveTieCorrection: SpeechTrustResolver,
  config: InformationTransmissionConfig,
): InformationAdoptionFactor[] {
  const distinctSpeakerIds = Array.from(new Set(group.map((reception) => reception.speakerId))).sort();

  const trustValues = distinctSpeakerIds.map((speakerId) => {
    const speaker = agentsById.get(speakerId);
    const sameClique = speaker?.cliqueId !== undefined && speaker.cliqueId === receiver.cliqueId;
    return resolveTrust(receiver.id, speakerId, sameClique);
  });
  const trustAvg = trustValues.length > 0 ? trustValues.reduce((sum, value) => sum + value, 0) / trustValues.length : 0;

  const tieValues = distinctSpeakerIds.map((speakerId) => {
    const speaker = agentsById.get(speakerId);
    const sameClique = speaker?.cliqueId !== undefined && speaker.cliqueId === receiver.cliqueId;
    return resolveTieCorrection(receiver.id, speakerId, sameClique);
  });
  const tieAvg = tieValues.length > 0 ? tieValues.reduce((sum, value) => sum + value, 0) / tieValues.length : 0;

  const topicInterest =
    informationRuntime[receiver.id]?.profile.baselineTopicInterest[claimDefinition.topicId] ??
    informationRuntime[receiver.id]?.topics[claimDefinition.topicId]?.interest ??
    0;

  const priorConfidence = existing?.confidence ?? 0;

  // sourceRepetition: 既存source traceで既に何度も聞いている話者ほどnoveltyが下がる(逓減、受入条件)
  const noveltyValues = distinctSpeakerIds.map((speakerId) => {
    const trace = existing?.sourceTraces.find((t) => t.kind === "heardUtterance" && t.immediateSpeakerId === speakerId);
    const priorCount = trace?.encounterCount ?? 0;
    return 1 / (1 + priorCount);
  });
  const repetitionNovelty =
    noveltyValues.length > 0 ? noveltyValues.reduce((sum, value) => sum + value, 0) / noveltyValues.length : 0;

  // sourceDiversity: 既知 + このtickで新規に聞いた、distinctな直接speaker数(独立sourceによる補強)
  const existingSpeakerIds = new Set(
    (existing?.sourceTraces ?? [])
      .filter((trace) => trace.kind === "heardUtterance" && trace.immediateSpeakerId !== undefined)
      .map((trace) => trace.immediateSpeakerId as string),
  );
  const allDistinctSpeakerIds = new Set([...existingSpeakerIds, ...distinctSpeakerIds]);
  const diversityRaw = clampUnit((allDistinctSpeakerIds.size - 1) / config.sourceDiversitySaturationCount);

  const consideredVariantIds = Array.from(new Set(group.map((reception) => reception.variantId))).sort();
  const variantCompatibility =
    existing?.activeVariantId === undefined
      ? 1
      : consideredVariantIds.every((variantId) => variantId === existing.activeVariantId)
        ? 1
        : consideredVariantIds.includes(existing.activeVariantId)
          ? 0.6
          : 0.2;

  const verifiabilityRaw =
    claimDefinition.verifiability === "verifiable" ? 1 : claimDefinition.verifiability === "uncertain" ? 0.5 : 0.7;

  const strengthValues = group.map((reception) => speechByUtteranceId.get(reception.contentUtteranceId)?.strength ?? 1);
  const strengthAvg =
    strengthValues.length > 0 ? strengthValues.reduce((sum, value) => sum + value, 0) / strengthValues.length : 1;
  const strengthRaw = clampUnit(strengthAvg);

  return [
    { key: "speakerTrust", rawValue: trustAvg, contribution: config.trustWeight * trustAvg },
    { key: "relationshipTie", rawValue: tieAvg, contribution: config.tieWeight * tieAvg },
    { key: "topicInterest", rawValue: topicInterest, contribution: config.topicInterestWeight * topicInterest },
    { key: "priorConfidence", rawValue: priorConfidence, contribution: config.priorConfidenceWeight * priorConfidence },
    {
      key: "sourceRepetition",
      rawValue: repetitionNovelty,
      contribution: config.sourceRepetitionWeight * repetitionNovelty,
    },
    { key: "sourceDiversity", rawValue: diversityRaw, contribution: config.sourceDiversityWeight * diversityRaw },
    {
      key: "variantCompatibility",
      rawValue: variantCompatibility,
      contribution: config.variantCompatibilityWeight * (variantCompatibility - 0.5),
    },
    {
      key: "claimVerifiability",
      rawValue: verifiabilityRaw,
      contribution: config.claimVerifiabilityWeight * verifiabilityRaw,
    },
    { key: "utteranceStrength", rawValue: strengthRaw, contribution: config.utteranceStrengthWeight * strengthRaw },
  ];
}

/** 既に採用済みの同一variantを再確認しているだけか(§4.2「既知情報を再確認する」)を判定する */
function isReconfirmationOfKnownVariant(existing: AgentClaimState | undefined, consideredVariantIds: readonly string[]): boolean {
  if (!existing || existing.acceptance !== "adopted" || existing.activeVariantId === undefined) return false;
  return consideredVariantIds.every((variantId) => variantId === existing.activeVariantId);
}

/**
 * §4.2の4段階規則で、次tickの`activeVariantId`を1つ選ぶ: (1) next confidenceへの絶対寄与最大、
 * (2) memory gain最大(このモジュールではadoption結果ごとに一定のためタイブレークとしてのみ働く)、
 * (3) canonical distance最小(#232以前はrootのみのためcanonicalDistance差はない)、(4) variant ID昇順。
 * #231時点では受け取ったvariantをそのまま使う(mutationは#232)ため、実質的にconsidered variantの中で
 * 最も多くのreceptionに支持されたもの(同数ならID昇順)を選ぶ安定規則として実装する。
 */
function selectActiveVariant(group: readonly InformationReceptionEvent[]): string {
  const counts = new Map<string, number>();
  for (const reception of group) {
    counts.set(reception.variantId, (counts.get(reception.variantId) ?? 0) + 1);
  }
  const sortedVariantIds = Array.from(counts.keys()).sort();
  let best = sortedVariantIds[0];
  let bestCount = counts.get(best) ?? 0;
  for (const variantId of sortedVariantIds) {
    const count = counts.get(variantId) ?? 0;
    if (count > bestCount) {
      best = variantId;
      bestCount = count;
    }
  }
  return best;
}

export type AdoptionComputation = {
  event: InformationAdoptionEvent;
  activeVariantId: string | undefined;
};

/**
 * receiver × claimにつき1件の`InformationAdoptionEvent`を計算する(§4.2)。rejected/uncertain/
 * alreadyKnownでもawareness/memory更新は別途行われうる(受入条件)。
 */
function computeAdoption(
  tick: number,
  receiver: Agent,
  claimId: string,
  group: readonly InformationReceptionEvent[],
  existing: AgentClaimState | undefined,
  claimDefinition: InformationClaim,
  informationRuntime: InformationRuntimeState,
  agentsById: Map<string, Agent>,
  speechByUtteranceId: Map<string, SpeechEvent>,
  resolveTrust: SpeechTrustResolver,
  resolveTieCorrection: SpeechTrustResolver,
  config: InformationTransmissionConfig,
  runSeed: number,
): AdoptionComputation {
  const consideredVariantIds = Array.from(new Set(group.map((reception) => reception.variantId))).sort();
  const receptionEventIds = group.map((reception) => reception.id).sort();
  const previousConfidence = existing?.confidence ?? 0;
  const factors = computeAdoptionFactors(
    receiver,
    group,
    existing,
    claimDefinition,
    informationRuntime,
    agentsById,
    speechByUtteranceId,
    resolveTrust,
    resolveTieCorrection,
    config,
  );
  const factorSum = factors.reduce((sum, factor) => sum + factor.contribution, 0);
  const probability = clampUnit(config.adoptionBaseRate + factorSum);

  if (isReconfirmationOfKnownVariant(existing, consideredVariantIds)) {
    const nextConfidence = clampUnit(previousConfidence + config.memoryGainOnHeard * 0.5);
    return {
      event: {
        id: `info-adoption-${tick}-${receiver.id}-${claimId}`,
        tick,
        receiverId: receiver.id,
        claimId,
        consideredVariantIds,
        receptionEventIds,
        result: "alreadyKnown",
        previousConfidence,
        nextConfidence,
        confidenceDelta: nextConfidence - previousConfidence,
        factors,
        draw: undefined,
        probability: undefined,
      },
      activeVariantId: existing?.activeVariantId,
    };
  }

  const rng = deriveTransmissionRandom(runSeed, "adoption", receiver.id, claimId);
  const draw = rng.next();
  const uncertainCeiling = probability + (1 - probability) * config.uncertainBandShare;
  const result: AdoptionResult = draw < probability ? "adopted" : draw < uncertainCeiling ? "uncertain" : "rejected";

  let nextConfidence: number;
  if (result === "adopted") {
    nextConfidence = clampUnit(previousConfidence + config.confidenceUpdateScale * probability);
  } else if (result === "uncertain") {
    nextConfidence = clampUnit(previousConfidence + config.confidenceUpdateScale * probability * 0.3);
  } else {
    nextConfidence = clampUnit(previousConfidence - config.confidenceUpdateScale * (1 - probability) * 0.3);
  }

  return {
    event: {
      id: `info-adoption-${tick}-${receiver.id}-${claimId}`,
      tick,
      receiverId: receiver.id,
      claimId,
      consideredVariantIds,
      receptionEventIds,
      result,
      previousConfidence,
      nextConfidence,
      confidenceDelta: nextConfidence - previousConfidence,
      factors,
      draw,
      probability,
    },
    activeVariantId: result === "adopted" ? selectActiveVariant(group) : existing?.activeVariantId,
  };
}

// --- memory更新 + 状態commit(§4.3、§5 step 9) -----------------------------------------------------

function buildSourceTraces(
  existing: AgentClaimState | undefined,
  group: readonly InformationReceptionEvent[],
  claimDefinition: InformationClaim,
  tick: number,
  limits: InformationPropagationLimits,
): { traces: SourceTrace[]; addedIds: string[] } {
  let traces = existing?.sourceTraces ?? [];
  const addedIds: string[] = [];
  // canonical順(§5.1: speakerId, contentUtteranceId, receiverId)で畳み込み、入力順に依存させない
  const ordered = [...group].sort((a, b) =>
    a.speakerId !== b.speakerId ? (a.speakerId < b.speakerId ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const reception of ordered) {
    const incoming: SourceTrace = {
      id: `source-${reception.id}`,
      kind: "heardUtterance",
      originalSourceId: claimDefinition.originalSource.id,
      immediateSpeakerId: reception.speakerId,
      utteranceId: reception.contentUtteranceId,
      receptionId: reception.id,
      variantId: reception.variantId,
      firstEncounteredTick: tick,
      lastEncounteredTick: tick,
      encounterCount: 1,
    };
    traces = addSourceTrace(traces, incoming, limits.maxSourceTracesPerAgentClaim);
    addedIds.push(incoming.id);
  }
  return { traces, addedIds };
}

export type ReceptionGroupApplication = {
  claimState: AgentClaimState;
  memoryUpdate: InformationMemoryUpdateEvent;
};

/**
 * receiver × claimにつき1回、`AgentClaimState`を原子的に更新する(§5 step 9)。adoption決定が
 * ない(全receptionがheardNotUnderstoodだった)場合は`adoption`をundefinedで呼ぶ。
 */
function applyReceptionGroup(
  tick: number,
  receiverId: string,
  claimId: string,
  group: readonly InformationReceptionEvent[],
  existing: AgentClaimState | undefined,
  claimDefinition: InformationClaim,
  adoption: AdoptionComputation | undefined,
  config: InformationTransmissionConfig,
  limits: InformationPropagationLimits,
): ReceptionGroupApplication {
  const understoodGroup = group.filter((reception) => reception.comprehension === "understood");
  const heardVariantIds = Array.from(new Set(group.map((reception) => reception.variantId)));
  const previousAwareness = existing?.awareness;
  const wasForgotten = previousAwareness === "forgotten";

  const nextAwareness: ClaimAwareness = understoodGroup.length > 0 ? "understood" : previousAwareness === "understood" ? "understood" : "heardOf";

  const { traces, addedIds } = buildSourceTraces(existing, group, claimDefinition, tick, limits);

  const decayedCurrent = existing ? decayedMemoryStrength(existing, tick, config) : 0;
  const gain = adoption
    ? adoption.event.result === "adopted"
      ? config.memoryGainOnAdoption
      : config.memoryGainOnHeard * 0.5
    : config.memoryGainOnHeard;
  let nextMemoryStrength = clampUnit(decayedCurrent + gain);
  if (wasForgotten) nextMemoryStrength = Math.max(nextMemoryStrength, config.relearnFloor);

  const hasNewVariant = heardVariantIds.some((variantId) => !(existing?.encounteredVariantIds ?? []).includes(variantId));
  const reason: InformationMemoryUpdateReason = !existing
    ? "firstExposure"
    : wasForgotten
      ? "relearned"
      : hasNewVariant
        ? "variantEncountered"
        : "reinforced";

  const encounteredVariantIds = Array.from(new Set([...(existing?.encounteredVariantIds ?? []), ...heardVariantIds])).sort();

  const nextClaimState: AgentClaimState = {
    claimId,
    awareness: nextAwareness,
    acceptance: adoption
      ? adoption.event.result === "adopted"
        ? "adopted"
        : adoption.event.result === "rejected"
          ? "rejected"
          : adoption.event.result === "uncertain"
            ? "uncertain"
            : (existing?.acceptance ?? "adopted")
      : (existing?.acceptance ?? "notEvaluated"),
    confidence: adoption ? adoption.event.nextConfidence : (existing?.confidence ?? 0),
    memoryStrength: nextMemoryStrength,
    firstEncounteredTick: existing?.firstEncounteredTick ?? tick,
    lastEncounteredTick: tick,
    firstHeardTick: existing?.firstHeardTick ?? tick,
    lastHeardTick: tick,
    heardCount: (existing?.heardCount ?? 0) + group.length,
    understoodCount: (existing?.understoodCount ?? 0) + understoodGroup.length,
    adoptionCount: (existing?.adoptionCount ?? 0) + (adoption?.event.result === "adopted" ? 1 : 0),
    activeVariantId: adoption ? adoption.activeVariantId : existing?.activeVariantId,
    encounteredVariantIds,
    sourceTraces: traces,
    retellingCount: existing?.retellingCount ?? 0,
    lastRetoldTick: existing?.lastRetoldTick,
    // このtickに初めて知った/思い出した情報は次tickから再伝達可能になる(同一tick cascade禁止、§5.1)
    retellableFromTick: tick + 1,
    lastMemoryEvaluationTick: tick,
    forgetAtTick: computeForgetAtTick(nextMemoryStrength, tick, config),
  };

  return {
    claimState: nextClaimState,
    memoryUpdate: {
      id: `info-memory-${tick}-${receiverId}-${claimId}`,
      tick,
      receiverId,
      claimId,
      adoptionEventId: adoption?.event.id,
      receptionEventIds: group.map((reception) => reception.id).sort(),
      reason,
      previousAwareness,
      nextAwareness,
      previousMemoryStrength: existing?.memoryStrength ?? 0,
      nextMemoryStrength,
      sourceTraceIdsAdded: addedIds,
    },
  };
}

export type InformationTransmissionContext = {
  tick: number;
  agents: readonly Agent[];
  groupCandidates: readonly GroupCandidate[];
  contentUtterances: readonly ContentUtteranceEvent[];
  contentSpeechEvents: readonly SpeechEvent[];
  informationRuntime: InformationRuntimeState;
  claimCatalog: ClaimCatalog;
  limits: InformationPropagationLimits;
  config: InformationTransmissionConfig;
  runSeed: number;
  resolveTrust: SpeechTrustResolver;
  resolveTieCorrection: SpeechTrustResolver;
};

export type InformationTransmissionResult = {
  speechReceptions: SpeechReceptionEvent[];
  informationReceptions: InformationReceptionEvent[];
  adoptions: InformationAdoptionEvent[];
  memoryUpdates: InformationMemoryUpdateEvent[];
  informationRuntime: InformationRuntimeState;
};

/**
 * ADR §5 step 7〜11: このtickの内容発話から、reception→理解→採用→記憶更新→provenanceまでを
 * 一括計算し、更新済みの`InformationRuntimeState`を返す。全て`ctx`のスナップショットだけから
 * 計算する純粋関数(呼び出し順序はengine.tsが固定する)。
 */
export function deriveInformationTransmission(ctx: InformationTransmissionContext): InformationTransmissionResult {
  const { speechReceptions, informationReceptions } = deriveInformationReceptions(
    ctx.tick,
    ctx.contentUtterances,
    ctx.contentSpeechEvents,
    ctx.agents,
    ctx.groupCandidates,
    ctx.claimCatalog,
    ctx.informationRuntime,
    ctx.config,
  );

  // heard: falseは状態更新なし(§4.1)。heard: trueのみをreceiver × claimでグループ化する(§4.2)。
  // canonical順(§5.1)でsortしてから畳むため、入力順に依存しない。
  const heardReceptions = sortInformationReceptionsCanonically(informationReceptions.filter((reception) => reception.heard));

  const groups = new Map<string, InformationReceptionEvent[]>();
  const groupOrder: string[] = [];
  for (const reception of heardReceptions) {
    const key = `${reception.receiverId}::${reception.claimId}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      groupOrder.push(key);
    }
    groups.get(key)!.push(reception);
  }
  groupOrder.sort();

  const agentsById = new Map(ctx.agents.map((agent) => [agent.id, agent]));
  const claimById = new Map(ctx.claimCatalog.claims.map((claim) => [claim.id, claim]));
  const speechByUtteranceId = new Map<string, SpeechEvent>();
  for (const utterance of ctx.contentUtterances) {
    const speech = ctx.contentSpeechEvents.find((s) => s.id === utterance.speechEventId);
    if (speech) speechByUtteranceId.set(utterance.id, speech);
  }

  const adoptions: InformationAdoptionEvent[] = [];
  const memoryUpdates: InformationMemoryUpdateEvent[] = [];
  let runtime = ctx.informationRuntime;

  for (const key of groupOrder) {
    const group = groups.get(key)!;
    const [receiverId, claimId] = key.split("::");
    const receiver = agentsById.get(receiverId);
    const claimDefinition = claimById.get(claimId);
    if (!receiver || !claimDefinition) continue;

    const existing = runtime[receiverId]?.claims[claimId];
    const understoodGroup = group.filter((reception) => reception.comprehension === "understood");

    let adoption: AdoptionComputation | undefined;
    if (understoodGroup.length > 0) {
      adoption = computeAdoption(
        ctx.tick,
        receiver,
        claimId,
        understoodGroup,
        existing,
        claimDefinition,
        runtime,
        agentsById,
        speechByUtteranceId,
        ctx.resolveTrust,
        ctx.resolveTieCorrection,
        ctx.config,
        ctx.runSeed,
      );
      adoptions.push(adoption.event);
    }

    const application = applyReceptionGroup(
      ctx.tick,
      receiverId,
      claimId,
      group,
      existing,
      claimDefinition,
      adoption,
      ctx.config,
      ctx.limits,
    );
    memoryUpdates.push(application.memoryUpdate);

    if (runtime[receiverId]) {
      runtime = withAgentClaimState(runtime, receiverId, application.claimState);
    }
  }

  return {
    speechReceptions,
    informationReceptions,
    adoptions,
    memoryUpdates,
    informationRuntime: runtime,
  };
}

/** §5.1のcanonical順: `(tick, clusterId, speakerId, claimId, variantId, contentUtteranceId, receiverId)` */
function sortInformationReceptionsCanonically(receptions: readonly InformationReceptionEvent[]): InformationReceptionEvent[] {
  return [...receptions].sort((a, b) => {
    const keys: Array<[string | number, string | number]> = [
      [a.tick, b.tick],
      [a.clusterId, b.clusterId],
      [a.speakerId, b.speakerId],
      [a.claimId, b.claimId],
      [a.variantId, b.variantId],
      [a.contentUtteranceId, b.contentUtteranceId],
      [a.receiverId, b.receiverId],
    ];
    for (const [x, y] of keys) {
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  });
}
