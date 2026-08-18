/**
 * Issue #234: Phase 5の情報伝播を観察するためのread-only分析層。
 *
 * runtimeの情報状態と構造化eventを束ねるだけで、SimulationStateの更新・PRNG消費・
 * decisionへの入力は一切行わない。表示、export、統計はこのmoduleの戻り値を共有し、
 * raw event列をそれぞれで再解釈しない。
 */
import { mergeGeneratedVariants } from "./claimVariant";
import type { ClaimCatalog, ClaimVariant, InformationClaim, TopicDefinition } from "./informationModel";
import type { AgentClaimState, InformationPropagationConfig, SourceTrace } from "./informationState";
import type {
  AdoptionResult,
  InformationAdoptionEvent,
  InformationMemoryUpdateEvent,
  InformationReceptionEvent,
} from "./informationTransmission";
import type { RetellingEvent, RetellingResult } from "./retelling";
import type { Agent, SimulationState } from "./types";

export const INFORMATION_PROPAGATION_ANALYSIS_SCHEMA_VERSION = "information-propagation-analysis/1" as const;

export type InformationTransmissionResult =
  | "notHeard"
  | "heardNotUnderstood"
  | AdoptionResult;

/** #234で各表示を横断するfilter。省略した項目は制限しない。 */
export type InformationAnalysisFilter = {
  topicIds?: readonly string[];
  claimIds?: readonly string[];
  variantIds?: readonly string[];
  /** 話者または受け手に一致する伝播、本人に一致するsnapshotを対象にする。 */
  agentIds?: readonly string[];
  sourceAgentIds?: readonly string[];
  clusterIds?: readonly string[];
  fromTick?: number;
  /** 半開区間。省略時はasOfTickまで。 */
  toTick?: number;
  results?: readonly InformationTransmissionResult[];
  retellingResults?: readonly RetellingResult[];
  observerJoinerMode?: "all" | "only" | "exclude";
  minConfidence?: number;
  minMemoryStrength?: number;
};

/** #234 ADR §4.5。reception IDをそのままrecord IDにして因果参照を失わない。 */
export type InformationTransmissionRecord = {
  id: string;
  tick: number;
  speakerId: string;
  receiverId: string;
  clusterId: string;
  topicId?: string;
  claimId: string;
  variantId: string;
  speechEventId: string;
  contentUtteranceId: string;
  speechReceptionEventId: string;
  informationReceptionEventId: string;
  adoptionEventId?: string;
  memoryUpdateEventId?: string;
  result: InformationTransmissionResult;
  confidenceDelta?: number;
  retellingEventId?: string;
  retellingResult?: RetellingResult;
};

/** contactと混同しない、実際の内容発話に由来する有向edge。 */
export type InformationPropagationEdge = InformationTransmissionRecord & {
  edgeId: string;
  kind: "heard" | "adopted" | "rejected" | "uncertain" | "alreadyKnown";
};

export type AgentInformationClaimSnapshot = {
  claimId: string;
  topicId?: string;
  awareness: AgentClaimState["awareness"];
  acceptance: AgentClaimState["acceptance"];
  confidence: number;
  memoryStrength: number;
  activeVariantId?: string;
  firstEncounteredTick: number;
  lastEncounteredTick: number;
  firstHeardTick?: number;
  lastHeardTick?: number;
  heardCount: number;
  understoodCount: number;
  adoptionCount: number;
  retellingCount: number;
  lastRetoldTick?: number;
  sourceTraces: SourceTrace[];
};

export type AgentInformationSnapshot = {
  agentId: string;
  label?: string;
  isObserverJoiner: boolean;
  topicInterest: Array<{ topicId: string; interest: number; fatigue: number; lastDiscussedTick?: number }>;
  claims: AgentInformationClaimSnapshot[];
  /** understoodだがadoptedに至らなかった実受信。未接触とは別に空配列で表現する。 */
  notAdoptedTransmissions: InformationTransmissionRecord[];
  satisfactionTopicContribution?: number;
  transitionTopicContribution?: number;
};

export type ClusterTopicSnapshot = {
  clusterId: string;
  currentTopicId?: string;
  topicStartedTick?: number;
  changedAtCurrentTick: boolean;
  recentTopicIds: string[];
  recentUtteranceIds: string[];
  memberIds: string[];
  knowledgeSummary: Array<{ topicId: string; awareCount: number; adoptedCount: number; rememberedCount: number }>;
};

/** graphを利用できない環境でも同じlineageを表形式でたどるための行。 */
export type ClaimLineageRow = {
  variantId: string;
  claimId: string;
  topicId: string;
  parentVariantId?: string;
  lineageDepth: number;
  hopDistance: number;
  canonicalDistance: number;
  generatedAtTick: number;
  generatorAgentId?: string;
  retellingEventId?: string;
  mutationFactors: ClaimVariant["mutationFactors"];
  childVariantIds: string[];
  retellingEventIds: string[];
};

export type InformationTimelineEntry = {
  id: string;
  tick: number;
  kind: "contentUtterance" | "reception" | "adoption" | "memoryUpdate" | "retelling";
  topicId?: string;
  claimId: string;
  variantId?: string;
  speakerId?: string;
  receiverId?: string;
  clusterId?: string;
  result?: string;
  relatedIds: string[];
};

export type InformationDistributionPoint = {
  tick: number;
  topicId: string;
  claimId: string;
  awareCount: number;
  adoptedCount: number;
  rememberedCount: number;
};

export type InformationRate = { numerator: number; denominator: number; rate?: number };

export type InformationTopicStatistics = {
  topicId: string;
  awareCount: number;
  adoptedCount: number;
  rememberedCount: number;
  firstSpreadTick?: number;
  timeToAgentCounts: Array<{ agentCount: number; tick?: number }>;
};

export type InformationClaimStatistics = InformationTopicStatistics & {
  claimId: string;
  uniqueSpeakerCount: number;
  uniqueReceiverCount: number;
};

export type InformationPropagationStatistics = {
  topic: InformationTopicStatistics[];
  claims: InformationClaimStatistics[];
  utteranceToHeard: InformationRate;
  heardToAdopt: InformationRate;
  adoptToRetell: InformationRate;
  sourceHopDistribution: Record<string, number>;
  variantCountByClaim: Record<string, number>;
  lineageDepthDistribution: Record<string, number>;
  semanticDistanceDistribution: Record<string, number>;
  retellingResultCounts: Record<RetellingResult, number>;
  sourceDiversity: InformationRate;
  crossClusterTransmissionCount: number;
  observerJoiner: { agentIds: string[]; receivedCount: number; adoptedCount: number; retellingCount: number };
  distributions: InformationDistributionPoint[];
};

export type InformationPropagationAnalysis = {
  schemaVersion: typeof INFORMATION_PROPAGATION_ANALYSIS_SCHEMA_VERSION;
  asOfTick: number;
  filter: InformationAnalysisFilter;
  topics: TopicDefinition[];
  claims: InformationClaim[];
  variants: ClaimVariant[];
  transmissions: InformationTransmissionRecord[];
  propagationEdges: InformationPropagationEdge[];
  agentSnapshots: AgentInformationSnapshot[];
  clusterSnapshots: ClusterTopicSnapshot[];
  lineage: ClaimLineageRow[];
  timeline: InformationTimelineEntry[];
  statistics: InformationPropagationStatistics;
};

export type BuildInformationPropagationAnalysisOptions = {
  config?: InformationPropagationConfig;
  filter?: InformationAnalysisFilter;
  asOfTick?: number;
};

function sortByTickThenId<T extends { tick: number; id: string }>(values: readonly T[]): T[] {
  return [...values].sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id));
}

function sorted<T extends { id: string }>(values: readonly T[]): T[] {
  return [...values].sort((a, b) => a.id.localeCompare(b.id));
}

function asSet(values: readonly string[] | undefined): Set<string> | undefined {
  return values && values.length > 0 ? new Set(values) : undefined;
}

function includes(set: Set<string> | undefined, value: string | undefined): boolean {
  return !set || (value !== undefined && set.has(value));
}

function rate(numerator: number, denominator: number): InformationRate {
  return denominator === 0 ? { numerator, denominator } : { numerator, denominator, rate: numerator / denominator };
}

function transmissionResult(reception: InformationReceptionEvent, adoption?: InformationAdoptionEvent): InformationTransmissionResult {
  if (!reception.heard) return "notHeard";
  if (reception.comprehension !== "understood") return "heardNotUnderstood";
  return adoption?.result ?? "heardNotUnderstood";
}

function toEdgeKind(result: InformationTransmissionResult): InformationPropagationEdge["kind"] | undefined {
  switch (result) {
    case "adopted": return "adopted";
    case "rejected": return "rejected";
    case "uncertain": return "uncertain";
    case "alreadyKnown": return "alreadyKnown";
    case "heardNotUnderstood": return "heard";
    default: return undefined;
  }
}

function topicIdForClaim(claims: ReadonlyMap<string, InformationClaim>, claimId: string): string | undefined {
  return claims.get(claimId)?.topicId;
}

function withinWindow(tick: number, fromTick: number, toTick: number): boolean {
  return tick >= fromTick && tick < toTick;
}

function findLatestMemoryUpdate(
  updates: readonly InformationMemoryUpdateEvent[],
  receptionId: string,
  adoptionId: string | undefined,
): InformationMemoryUpdateEvent | undefined {
  return updates.find((update) =>
    (adoptionId !== undefined && update.adoptionEventId === adoptionId) || update.receptionEventIds.includes(receptionId),
  );
}

function buildCatalog(config: InformationPropagationConfig | undefined, generated: readonly ClaimVariant[]): ClaimCatalog {
  if (!config) return { id: "unavailable", claims: [], variants: [...generated] };
  return mergeGeneratedVariants(config.claimCatalog, generated);
}

function isRemembered(claim: AgentClaimState): boolean {
  return claim.awareness !== "forgotten" && claim.memoryStrength > 0;
}

function filterTransmission(
  item: InformationTransmissionRecord,
  filter: InformationAnalysisFilter,
  agents: ReadonlyMap<string, Agent>,
  claimStates: ReadonlyMap<string, AgentClaimState>,
  fromTick: number,
  toTick: number,
): boolean {
  const topicIds = asSet(filter.topicIds);
  const claimIds = asSet(filter.claimIds);
  const variantIds = asSet(filter.variantIds);
  const agentIds = asSet(filter.agentIds);
  const sourceAgentIds = asSet(filter.sourceAgentIds);
  const clusterIds = asSet(filter.clusterIds);
  const results = asSet(filter.results);
  const retellingResults = asSet(filter.retellingResults);
  if (!withinWindow(item.tick, fromTick, toTick)) return false;
  if (!includes(topicIds, item.topicId) || !includes(claimIds, item.claimId) || !includes(variantIds, item.variantId)) return false;
  if (!includes(clusterIds, item.clusterId) || !includes(results, item.result)) return false;
  if (retellingResults && !includes(retellingResults, item.retellingResult)) return false;
  if (agentIds && !agentIds.has(item.speakerId) && !agentIds.has(item.receiverId)) return false;
  if (!includes(sourceAgentIds, item.speakerId)) return false;
  const receiverState = claimStates.get(`${item.receiverId}:${item.claimId}`);
  if (filter.minConfidence !== undefined && (receiverState?.confidence ?? -Infinity) < filter.minConfidence) return false;
  if (filter.minMemoryStrength !== undefined && (receiverState?.memoryStrength ?? -Infinity) < filter.minMemoryStrength) return false;
  if (filter.observerJoinerMode === "only" && !agents.get(item.speakerId)?.isObserverJoiner && !agents.get(item.receiverId)?.isObserverJoiner) return false;
  if (filter.observerJoinerMode === "exclude" && (agents.get(item.speakerId)?.isObserverJoiner || agents.get(item.receiverId)?.isObserverJoiner)) return false;
  return true;
}

function makeDistributions(
  snapshots: readonly AgentInformationSnapshot[],
  claims: ReadonlyMap<string, InformationClaim>,
  memoryUpdates: readonly InformationMemoryUpdateEvent[],
  adoptions: readonly InformationAdoptionEvent[],
  asOfTick: number,
): InformationDistributionPoint[] {
  type Mutable = { aware: Set<string>; adopted: Set<string>; remembered: Set<string> };
  const byClaim = new Map<string, Mutable>();
  const includedAgentIds = new Set(snapshots.map((snapshot) => snapshot.agentId));
  const get = (claimId: string): Mutable => {
    let value = byClaim.get(claimId);
    if (!value) {
      value = { aware: new Set(), adopted: new Set(), remembered: new Set() };
      byClaim.set(claimId, value);
    }
    return value;
  };
  // 明示initial grantにはeventがないため、現在stateのfirstEncounteredTickを初期seedとして補う。
  const events: Array<{ tick: number; id: string; apply: () => void }> = [];
  for (const snapshot of snapshots) {
    for (const claim of snapshot.claims) {
      events.push({ tick: claim.firstEncounteredTick, id: `initial:${snapshot.agentId}:${claim.claimId}`, apply: () => {
        const value = get(claim.claimId);
        value.aware.add(snapshot.agentId);
        if (claim.acceptance === "adopted") value.adopted.add(snapshot.agentId);
        if (claim.awareness !== "forgotten" && claim.memoryStrength > 0) value.remembered.add(snapshot.agentId);
      }});
    }
  }
  for (const update of memoryUpdates) {
    if (!includedAgentIds.has(update.receiverId)) continue;
    events.push({ tick: update.tick, id: update.id, apply: () => {
      const value = get(update.claimId);
      if (update.nextAwareness === "forgotten") value.remembered.delete(update.receiverId);
      else {
        value.aware.add(update.receiverId);
        value.remembered.add(update.receiverId);
      }
    }});
  }
  for (const adoption of adoptions) {
    if (!includedAgentIds.has(adoption.receiverId)) continue;
    if (adoption.result !== "adopted") continue;
    events.push({ tick: adoption.tick, id: adoption.id, apply: () => get(adoption.claimId).adopted.add(adoption.receiverId) });
  }
  const rows: InformationDistributionPoint[] = [];
  for (const event of events.sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id))) {
    if (event.tick > asOfTick) continue;
    event.apply();
    for (const [claimId, value] of Array.from(byClaim.entries()).sort(([a], [b]) => a.localeCompare(b))) {
      rows.push({
        tick: event.tick,
        topicId: topicIdForClaim(claims, claimId) ?? "unknown",
        claimId,
        awareCount: value.aware.size,
        adoptedCount: value.adopted.size,
        rememberedCount: value.remembered.size,
      });
    }
  }
  return rows;
}

/**
 * Phase 5の状態を一度だけ読み取り、UI・export・統計で共有する分析snapshotを作る。
 * configがない場合もイベント由来のrecordは返し、catalog由来の表示名だけが未解決になる。
 */
export function buildInformationPropagationAnalysis(
  state: SimulationState,
  options: BuildInformationPropagationAnalysisOptions = {},
): InformationPropagationAnalysis {
  const asOfTick = options.asOfTick ?? state.tick;
  const filter = options.filter ?? {};
  const fromTick = Math.max(0, Math.floor(filter.fromTick ?? 0));
  const toTick = Math.max(fromTick, Math.floor(filter.toTick ?? asOfTick) + (filter.toTick === undefined ? 1 : 0));
  const catalog = buildCatalog(options.config, state.generatedClaimVariants ?? []);
  const claims = new Map(catalog.claims.map((claim) => [claim.id, claim]));
  const agents = new Map(state.agents.map((agent) => [agent.id, agent]));
  const claimStates = new Map<string, AgentClaimState>();
  for (const [agentId, runtime] of Object.entries(state.informationRuntime ?? {})) {
    for (const claim of Object.values(runtime.claims)) claimStates.set(`${agentId}:${claim.claimId}`, claim);
  }

  const utterances = sorted(state.contentUtteranceLog ?? []);
  const utteranceById = new Map(utterances.map((item) => [item.id, item]));
  const adoptions = sortByTickThenId(state.informationAdoptionLog ?? []);
  const adoptionByReception = new Map<string, InformationAdoptionEvent>();
  for (const adoption of adoptions) for (const receptionId of adoption.receptionEventIds) adoptionByReception.set(receptionId, adoption);
  const memoryUpdates = sortByTickThenId(state.informationMemoryUpdateLog ?? []);
  const retellings = sortByTickThenId(state.retellingLog ?? []);
  const retellingByUtterance = new Map<string, RetellingEvent>();
  for (const retelling of retellings) if (retelling.contentUtteranceId) retellingByUtterance.set(retelling.contentUtteranceId, retelling);

  const allTransmissions: InformationTransmissionRecord[] = [];
  for (const reception of sortByTickThenId(state.informationReceptionLog ?? [])) {
    const utterance = utteranceById.get(reception.contentUtteranceId);
    if (!utterance) continue; // 孤児eventを推測で補わない
    const adoption = adoptionByReception.get(reception.id);
    const memory = findLatestMemoryUpdate(memoryUpdates, reception.id, adoption?.id);
    const retelling = retellingByUtterance.get(utterance.id);
    allTransmissions.push({
      id: reception.id,
      tick: reception.tick,
      speakerId: reception.speakerId,
      receiverId: reception.receiverId,
      clusterId: reception.clusterId,
      topicId: topicIdForClaim(claims, reception.claimId),
      claimId: reception.claimId,
      variantId: reception.variantId,
      speechEventId: utterance.speechEventId,
      contentUtteranceId: utterance.id,
      speechReceptionEventId: reception.speechReceptionEventId,
      informationReceptionEventId: reception.id,
      adoptionEventId: adoption?.id,
      memoryUpdateEventId: memory?.id,
      result: transmissionResult(reception, adoption),
      confidenceDelta: adoption?.confidenceDelta,
      retellingEventId: retelling?.id,
      retellingResult: retelling?.result,
    });
  }
  const transmissions = sortByTickThenId(allTransmissions).filter((item) => filterTransmission(item, filter, agents, claimStates, fromTick, toTick));
  const propagationEdges = transmissions.flatMap((item): InformationPropagationEdge[] => {
    const kind = toEdgeKind(item.result);
    return kind ? [{ ...item, edgeId: `propagation:${item.id}`, kind }] : [];
  });

  const agentSnapshots = state.agents
    .map((agent): AgentInformationSnapshot => {
      const runtime = state.informationRuntime?.[agent.id];
      const topics = Object.values(runtime?.topics ?? {})
        .sort((a, b) => a.topicId.localeCompare(b.topicId))
        .map((topic) => ({ topicId: topic.topicId, interest: topic.interest, fatigue: topic.fatigue, lastDiscussedTick: topic.lastDiscussedTick }));
      const agentClaims = Object.values(runtime?.claims ?? {})
        .filter((claim) => {
          const topicId = topicIdForClaim(claims, claim.claimId);
          if (filter.claimIds && !filter.claimIds.includes(claim.claimId)) return false;
          if (filter.topicIds && (!topicId || !filter.topicIds.includes(topicId))) return false;
          if (filter.variantIds && (!claim.activeVariantId || !filter.variantIds.includes(claim.activeVariantId))) return false;
          if (filter.minConfidence !== undefined && claim.confidence < filter.minConfidence) return false;
          if (filter.minMemoryStrength !== undefined && claim.memoryStrength < filter.minMemoryStrength) return false;
          return true;
        })
        .sort((a, b) => a.claimId.localeCompare(b.claimId))
        .map((claim) => ({
          claimId: claim.claimId,
          topicId: topicIdForClaim(claims, claim.claimId),
          awareness: claim.awareness,
          acceptance: claim.acceptance,
          confidence: claim.confidence,
          memoryStrength: claim.memoryStrength,
          activeVariantId: claim.activeVariantId,
          firstEncounteredTick: claim.firstEncounteredTick,
          lastEncounteredTick: claim.lastEncounteredTick,
          firstHeardTick: claim.firstHeardTick,
          lastHeardTick: claim.lastHeardTick,
          heardCount: claim.heardCount,
          understoodCount: claim.understoodCount,
          adoptionCount: claim.adoptionCount,
          retellingCount: claim.retellingCount,
          lastRetoldTick: claim.lastRetoldTick,
          sourceTraces: [...claim.sourceTraces].sort((a, b) => a.id.localeCompare(b.id)),
        }));
      return {
        agentId: agent.id,
        label: agent.label,
        isObserverJoiner: agent.isObserverJoiner,
        topicInterest: topics,
        claims: agentClaims,
        notAdoptedTransmissions: transmissions.filter((record) => record.receiverId === agent.id && record.result !== "adopted" && record.result !== "alreadyKnown"),
        // #233のtopic contributionは過去eventとして保存されないため、stateに無い場合は値を捏造しない。
        satisfactionTopicContribution: undefined,
        transitionTopicContribution: undefined,
      };
    })
    .filter((snapshot) => {
      const ids = asSet(filter.agentIds);
      if (ids && !ids.has(snapshot.agentId)) return false;
      if (filter.observerJoinerMode === "only" && !snapshot.isObserverJoiner) return false;
      if (filter.observerJoinerMode === "exclude" && snapshot.isObserverJoiner) return false;
      return true;
    })
    .sort((a, b) => a.agentId.localeCompare(b.agentId));

  const clusterIds = new Set<string>([
    ...Object.keys(state.clusterTopicRuntime ?? {}),
    ...state.groupCandidates.map((candidate) => candidate.id),
    ...utterances.map((utterance) => utterance.clusterId),
  ]);
  const clusterSnapshots = Array.from(clusterIds)
    .sort()
    .map((clusterId): ClusterTopicSnapshot => {
      const topic = state.clusterTopicRuntime?.[clusterId];
      const members = state.agents.filter((agent) => agent.state === "joined" && agent.joinedGroupId === clusterId).map((agent) => agent.id).sort();
      const topicIds = new Set([topic?.currentTopicId, ...(topic?.recentTopicIds ?? [])].filter((value): value is string => value !== undefined));
      const knowledgeSummary = Array.from(topicIds).sort().map((topicId) => {
        let awareCount = 0;
        let adoptedCount = 0;
        let rememberedCount = 0;
        for (const agentId of members) {
          const agentState = state.informationRuntime?.[agentId];
          for (const claim of Object.values(agentState?.claims ?? {})) {
            if (topicIdForClaim(claims, claim.claimId) !== topicId) continue;
            if (claim.awareness !== "forgotten") awareCount += 1;
            if (claim.acceptance === "adopted") adoptedCount += 1;
            if (isRemembered(claim)) rememberedCount += 1;
          }
        }
        return { topicId, awareCount, adoptedCount, rememberedCount };
      });
      const recentUtteranceIds = utterances.filter((utterance) => utterance.clusterId === clusterId).slice(-8).map((utterance) => utterance.id);
      return {
        clusterId,
        currentTopicId: topic?.currentTopicId,
        topicStartedTick: topic?.topicStartedTick,
        changedAtCurrentTick: topic?.topicStartedTick === asOfTick,
        recentTopicIds: [...(topic?.recentTopicIds ?? [])],
        recentUtteranceIds,
        memberIds: members,
        knowledgeSummary,
      };
    })
    .filter((snapshot) =>
      (!filter.clusterIds || filter.clusterIds.includes(snapshot.clusterId)) &&
      (!filter.topicIds || (snapshot.currentTopicId !== undefined && filter.topicIds.includes(snapshot.currentTopicId)) || snapshot.recentTopicIds.some((topicId) => filter.topicIds?.includes(topicId))),
    );

  const lineage = sorted(catalog.variants).map((variant): ClaimLineageRow => ({
    variantId: variant.id,
    claimId: variant.canonicalClaimId,
    topicId: variant.topicId,
    parentVariantId: variant.parentVariantId,
    lineageDepth: variant.lineageDepth,
    hopDistance: variant.hopDistance,
    canonicalDistance: variant.canonicalDistance,
    generatedAtTick: variant.generatedAtTick,
    generatorAgentId: variant.generatorAgentId,
    retellingEventId: variant.retellingEventId,
    mutationFactors: [...variant.mutationFactors],
    childVariantIds: sorted(catalog.variants.filter((child) => child.parentVariantId === variant.id)).map((child) => child.id),
    retellingEventIds: retellings.filter((event) => event.outputVariantId === variant.id).map((event) => event.id),
  })).filter((row) =>
    (!filter.topicIds || filter.topicIds.includes(row.topicId)) &&
    (!filter.claimIds || filter.claimIds.includes(row.claimId)) &&
    (!filter.variantIds || filter.variantIds.includes(row.variantId)) &&
    (!filter.retellingResults || row.retellingEventIds.some((id) => filter.retellingResults?.includes(retellings.find((event) => event.id === id)?.result ?? "faithful"))),
  );

  const timeline: InformationTimelineEntry[] = [
    ...utterances.map((event): InformationTimelineEntry => ({ id: event.id, tick: event.tick, kind: "contentUtterance", topicId: event.topicId, claimId: event.claimId, variantId: event.variantId, speakerId: event.speakerId, clusterId: event.clusterId, result: event.reason, relatedIds: [event.speechEventId, ...event.sourceTraceIds] })),
    ...transmissions.map((event): InformationTimelineEntry => ({ id: event.id, tick: event.tick, kind: "reception", topicId: event.topicId, claimId: event.claimId, variantId: event.variantId, speakerId: event.speakerId, receiverId: event.receiverId, clusterId: event.clusterId, result: event.result, relatedIds: [event.contentUtteranceId, event.speechEventId, event.speechReceptionEventId, ...(event.adoptionEventId ? [event.adoptionEventId] : []), ...(event.memoryUpdateEventId ? [event.memoryUpdateEventId] : [])] })),
    ...adoptions.map((event): InformationTimelineEntry => ({ id: event.id, tick: event.tick, kind: "adoption", claimId: event.claimId, receiverId: event.receiverId, result: event.result, relatedIds: [...event.receptionEventIds] })),
    ...memoryUpdates.map((event): InformationTimelineEntry => ({ id: event.id, tick: event.tick, kind: "memoryUpdate", claimId: event.claimId, receiverId: event.receiverId, result: event.reason, relatedIds: [...event.receptionEventIds, ...(event.adoptionEventId ? [event.adoptionEventId] : []), ...event.sourceTraceIdsAdded] })),
    ...retellings.map((event): InformationTimelineEntry => ({ id: event.id, tick: event.tick, kind: "retelling", claimId: event.claimId, variantId: event.outputVariantId ?? event.inputVariantId, speakerId: event.speakerId, clusterId: event.clusterId, result: event.result, relatedIds: [...event.sourceReceptionIds, ...event.sourceTraceIds, ...(event.contentUtteranceId ? [event.contentUtteranceId] : [])] })),
  ].filter((item) => {
    if (!withinWindow(item.tick, fromTick, toTick)) return false;
    if (filter.topicIds && (!item.topicId || !filter.topicIds.includes(item.topicId))) return false;
    if (filter.claimIds && !filter.claimIds.includes(item.claimId)) return false;
    if (filter.variantIds && (!item.variantId || !filter.variantIds.includes(item.variantId))) return false;
    if (filter.clusterIds && (!item.clusterId || !filter.clusterIds.includes(item.clusterId))) return false;
    if (filter.agentIds && !filter.agentIds.includes(item.speakerId ?? "") && !filter.agentIds.includes(item.receiverId ?? "")) return false;
    if (filter.sourceAgentIds && !filter.sourceAgentIds.includes(item.speakerId ?? "")) return false;
    return true;
  });

  const distributions = makeDistributions(agentSnapshots, claims, memoryUpdates, adoptions, asOfTick);
  const currentCounts = (claimId: string) => {
    const related = agentSnapshots.flatMap((snapshot) => snapshot.claims.filter((claim) => claim.claimId === claimId));
    return {
      awareCount: related.filter((claim) => claim.awareness !== "forgotten").length,
      adoptedCount: related.filter((claim) => claim.acceptance === "adopted").length,
      rememberedCount: related.filter((claim) => claim.awareness !== "forgotten" && claim.memoryStrength > 0).length,
    };
  };
  const claimStats = Array.from(claims.values())
    .filter((claim) => (!filter.topicIds || filter.topicIds.includes(claim.topicId)) && (!filter.claimIds || filter.claimIds.includes(claim.id)))
    .sort((a, b) => a.id.localeCompare(b.id)).map((claim): InformationClaimStatistics => {
    const counts = currentCounts(claim.id);
    const receptions = transmissions.filter((record) => record.claimId === claim.id && record.result !== "notHeard");
    const spread = distributions.filter((point) => point.claimId === claim.id && point.awareCount > 0);
    const uniqueCounts = Array.from(new Set(spread.map((point) => point.awareCount))).sort((a, b) => a - b);
    return {
      claimId: claim.id,
      topicId: claim.topicId,
      ...counts,
      firstSpreadTick: spread[0]?.tick,
      timeToAgentCounts: uniqueCounts.map((agentCount) => ({ agentCount, tick: spread.find((point) => point.awareCount >= agentCount)?.tick })),
      uniqueSpeakerCount: new Set(receptions.map((record) => record.speakerId)).size,
      uniqueReceiverCount: new Set(receptions.map((record) => record.receiverId)).size,
    };
  });
  const topicStats = Array.from(new Set(catalog.claims.map((claim) => claim.topicId))).sort().map((topicId): InformationTopicStatistics => {
    const members = claimStats.filter((stat) => stat.topicId === topicId);
    const spread = distributions.filter((point) => point.topicId === topicId && point.awareCount > 0);
    const maximum = Math.max(0, ...spread.map((point) => point.awareCount));
    return {
      topicId,
      awareCount: members.reduce((sum, item) => sum + item.awareCount, 0),
      adoptedCount: members.reduce((sum, item) => sum + item.adoptedCount, 0),
      rememberedCount: members.reduce((sum, item) => sum + item.rememberedCount, 0),
      firstSpreadTick: spread[0]?.tick,
      timeToAgentCounts: Array.from({ length: maximum }, (_, index) => index + 1).map((agentCount) => ({ agentCount, tick: spread.find((point) => point.awareCount >= agentCount)?.tick })),
    };
  });
  const heard = transmissions.filter((record) => record.result !== "notHeard");
  const adopted = transmissions.filter((record) => record.result === "adopted");
  const successfulRetellings = retellings.filter((event) => event.result !== "blockedByLimit");
  const retellingResultCounts: Record<RetellingResult, number> = { faithful: 0, mutated: 0, variantReused: 0, blockedByLimit: 0 };
  for (const event of retellings) retellingResultCounts[event.result] += 1;
  const sourceHopDistribution: Record<string, number> = {};
  const lineageDepthDistribution: Record<string, number> = {};
  const semanticDistanceDistribution: Record<string, number> = {};
  for (const variant of catalog.variants) {
    sourceHopDistribution[String(variant.hopDistance)] = (sourceHopDistribution[String(variant.hopDistance)] ?? 0) + 1;
    lineageDepthDistribution[String(variant.lineageDepth)] = (lineageDepthDistribution[String(variant.lineageDepth)] ?? 0) + 1;
    semanticDistanceDistribution[String(variant.canonicalDistance)] = (semanticDistanceDistribution[String(variant.canonicalDistance)] ?? 0) + 1;
  }
  const variantCountByClaim: Record<string, number> = {};
  for (const variant of catalog.variants) variantCountByClaim[variant.canonicalClaimId] = (variantCountByClaim[variant.canonicalClaimId] ?? 0) + 1;
  const sourceTraceCount = agentSnapshots.flatMap((snapshot) => snapshot.claims.map((claim) => ({ agentId: snapshot.agentId, claim }))).reduce((sum, item) => sum + new Set(item.claim.sourceTraces.map((trace) => trace.immediateSpeakerId ?? trace.originalSourceId).filter(Boolean)).size, 0);
  const claimStateCount = agentSnapshots.reduce((sum, snapshot) => sum + snapshot.claims.length, 0);
  let crossClusterTransmissionCount = 0;
  const seenReceiverClaimCluster = new Map<string, Set<string>>();
  for (const record of sortByTickThenId(transmissions)) {
    if (record.result === "notHeard") continue;
    const key = `${record.receiverId}:${record.claimId}`;
    const clusters = seenReceiverClaimCluster.get(key) ?? new Set<string>();
    if (clusters.size > 0 && !clusters.has(record.clusterId)) crossClusterTransmissionCount += 1;
    clusters.add(record.clusterId);
    seenReceiverClaimCluster.set(key, clusters);
  }
  const observerIds = state.agents.filter((agent) => agent.isObserverJoiner).map((agent) => agent.id).sort();
  const statistics: InformationPropagationStatistics = {
    topic: topicStats,
    claims: claimStats,
    utteranceToHeard: rate(new Set(heard.map((record) => record.contentUtteranceId)).size, new Set(transmissions.map((record) => record.contentUtteranceId)).size),
    heardToAdopt: rate(adopted.length, heard.length),
    adoptToRetell: rate(successfulRetellings.length, new Set(adopted.map((record) => `${record.receiverId}:${record.claimId}`)).size),
    sourceHopDistribution,
    variantCountByClaim,
    lineageDepthDistribution,
    semanticDistanceDistribution,
    retellingResultCounts,
    sourceDiversity: rate(sourceTraceCount, claimStateCount),
    crossClusterTransmissionCount,
    observerJoiner: {
      agentIds: observerIds,
      receivedCount: transmissions.filter((record) => observerIds.includes(record.receiverId) && record.result !== "notHeard").length,
      adoptedCount: adopted.filter((record) => observerIds.includes(record.receiverId)).length,
      retellingCount: retellings.filter((event) => observerIds.includes(event.speakerId)).length,
    },
    distributions,
  };

  return {
    schemaVersion: INFORMATION_PROPAGATION_ANALYSIS_SCHEMA_VERSION,
    asOfTick,
    filter,
    topics: sorted(options.config?.topicCatalog.topics ?? []),
    claims: sorted(catalog.claims).filter((claim) => (!filter.topicIds || filter.topicIds.includes(claim.topicId)) && (!filter.claimIds || filter.claimIds.includes(claim.id))),
    variants: sorted(catalog.variants).filter((variant) => (!filter.topicIds || filter.topicIds.includes(variant.topicId)) && (!filter.claimIds || filter.claimIds.includes(variant.canonicalClaimId)) && (!filter.variantIds || filter.variantIds.includes(variant.id))),
    transmissions,
    propagationEdges,
    agentSnapshots,
    clusterSnapshots,
    lineage,
    timeline: sortByTickThenId(timeline),
    statistics,
  };
}

/** export/UIが分析の非介入性を回帰テストするための小さなguard。 */
export function assertInformationAnalysisDoesNotMutateState(state: SimulationState, run: () => unknown): void {
  const before = JSON.stringify(state);
  run();
  if (JSON.stringify(state) !== before) throw new Error("informationAnalysis mutated SimulationState");
}
