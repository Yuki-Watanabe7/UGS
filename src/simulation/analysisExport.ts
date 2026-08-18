/**
 * Issue #217: standing-party Phase 4 分析結果の機械可読 export。
 * 現在runの履歴・接触network・統計を version 付き JSON / CSV で出力する。
 * simulation state / PRNG は消費・mutationしない。UI selection・layout座標は含めない。
 */
import {
  buildStandingPartyContactNetwork,
  buildStandingPartyConversationHistory,
  buildStandingPartyRunStatistics,
  type BuildStandingPartyRunStatisticsOptions,
} from "./standingPartyAnalysis";
import {
  buildInformationPropagationAnalysis,
  INFORMATION_PROPAGATION_ANALYSIS_SCHEMA_VERSION,
  type InformationPropagationAnalysis,
} from "./informationAnalysis";
import type { ContentUtteranceEvent } from "./contentUtterance";
import type {
  InformationAdoptionEvent,
  InformationMemoryUpdateEvent,
  InformationReceptionEvent,
} from "./informationTransmission";
import type { RetellingEvent } from "./retelling";
import type { StandingPartyScenarioConfig } from "./standingPartyScenarioConfig";
import type {
  ContactIntervalRecord,
  ContactNetworkEdge,
  ClusterTransitionRecord,
  ConversationEpisodeRecord,
  SimParams,
  SimulationState,
  StandingPartyAgentStatistics,
  StandingPartyClusterStatistics,
  StandingPartyContactNetwork,
  StandingPartyConversationHistory,
  StandingPartyRunStatistics,
  StandingPartyStatisticsFilter,
} from "./types";
import { STANDING_PARTY_ANALYSIS_SCHEMA_VERSION } from "./types";

/** Issue #217: export bundle の schema。分析 snapshot の schemaVersion とは別系統。 */
export const STANDING_PARTY_ANALYSIS_EXPORT_SCHEMA_VERSION = "standing-party-analysis-export/2";

/** Issue #217 本文の別名。実装正本は`StandingPartyConversationHistory`。 */
export type InteractionHistorySnapshot = StandingPartyConversationHistory;

/** Issue #217 本文の別名。実装正本は`StandingPartyContactNetwork`。 */
export type ContactNetworkSnapshot = StandingPartyContactNetwork;

export type StandingPartyAnalysisExportRunMeta = {
  seed: number;
  presetId?: string;
  formationScenarioId?: string;
  observationHorizon: {
    fromTick: number;
    toTick: number;
    asOfTick: number;
  };
  /** standingParty 専用設定。他シナリオでは null */
  config: StandingPartyScenarioConfig | null;
  /**
   * SimParams の明示列挙(秘密情報は無い前提)。UI一時状態は含めない。
   * 呼び出し側が`simParams`を渡したときはその値。未指定時は population など観測可能な値のみ。
   */
  params: {
    populationSize: number;
    numLeaders: number;
    groupConfirmSize: number;
    lateJoinEase: number;
    overallWillingness: number;
    ambiguityDuration: number;
    existingTieStrength: number;
  };
};

/**
 * Issue #217: 現在runの分析 bundle。
 * 同一入力から内容順序が決定的な JSON になる(キーソート + 既存導出の決定性)。
 */
export type StandingPartyAnalysisExport = {
  schemaVersion: typeof STANDING_PARTY_ANALYSIS_EXPORT_SCHEMA_VERSION;
  analysisSchemaVersion: typeof STANDING_PARTY_ANALYSIS_SCHEMA_VERSION;
  generatedAtTick: number;
  run: StandingPartyAnalysisExportRunMeta;
  history: InteractionHistorySnapshot;
  contactNetwork: ContactNetworkSnapshot;
  statistics: StandingPartyRunStatistics;
  /** Issue #234: Phase 5 event/stateを含む、read-onlyのversioned analysis snapshot。 */
  informationPropagation: InformationPropagationExport;
};

export type InformationPropagationExport = {
  schemaVersion: typeof INFORMATION_PROPAGATION_ANALYSIS_SCHEMA_VERSION;
  /** master OFFのrunではfalse。sub-configを含むためexport単体で観察条件を再現できる。 */
  config: StandingPartyScenarioConfig["informationPropagation"] | null;
  topics: InformationPropagationAnalysis["topics"];
  claims: InformationPropagationAnalysis["claims"];
  variants: InformationPropagationAnalysis["variants"];
  agentInformation: InformationPropagationAnalysis["agentSnapshots"];
  clusterTopics: InformationPropagationAnalysis["clusterSnapshots"];
  utterances: ContentUtteranceEvent[];
  receptions: InformationReceptionEvent[];
  adoptionDecisions: InformationAdoptionEvent[];
  memoryUpdates: InformationMemoryUpdateEvent[];
  retellings: RetellingEvent[];
  transmissions: InformationPropagationAnalysis["transmissions"];
  propagationEdges: InformationPropagationAnalysis["propagationEdges"];
  lineage: InformationPropagationAnalysis["lineage"];
  timeline: InformationPropagationAnalysis["timeline"];
  statistics: InformationPropagationAnalysis["statistics"];
};

export type BuildStandingPartyAnalysisExportOptions = StandingPartyStatisticsFilter & {
  asOfTick?: number;
  presetId?: string;
  standingPartyConfig?: StandingPartyScenarioConfig | null;
  /** 渡された場合`run.params`に SimParams の主要値を載せる */
  simParams?: SimParams;
  /** 事前構築済み。省略時は state から導出 */
  history?: StandingPartyConversationHistory;
  network?: StandingPartyContactNetwork;
  statistics?: StandingPartyRunStatistics;
  seriesSampleIntervalTicks?: number;
};

export type AnalysisCsvFile = {
  filename: string;
  content: string;
};

/** CSV formula injection を避けるため、危険な先頭文字を quote で無害化する */
export function escapeCsvCell(value: string | number | boolean | undefined | null): string {
  if (value === undefined || value === null) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function rowsToCsv(headers: readonly string[], rows: readonly (readonly (string | number | boolean | undefined | null)[])[]): string {
  const lines = [
    headers.map(escapeCsvCell).join(","),
    ...rows.map((row) => row.map(escapeCsvCell).join(",")),
  ];
  // 末尾改行を付け、決定的な LF のみを使う
  return `${lines.join("\n")}\n`;
}

/**
 * オブジェクトキーを再帰的にソートして決定的 JSON 文字列にする。
 * 配列要素の順序は入力どおり(導出側が既に決定的)。
 */
export function stableStringify(value: unknown, space = 2): string {
  return `${JSON.stringify(sortKeysDeep(value), null, space)}\n`;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeysDeep(record[key]);
    }
    return sorted;
  }
  return value;
}

export function serializeStandingPartyAnalysisExport(
  bundle: StandingPartyAnalysisExport,
): string {
  return stableStringify(bundle);
}

export function buildStandingPartyAnalysisExport(
  state: SimulationState,
  options: BuildStandingPartyAnalysisExportOptions = {},
): StandingPartyAnalysisExport {
  const asOfTick = options.asOfTick ?? state.tick;
  const history =
    options.history ?? buildStandingPartyConversationHistory(state, { asOfTick });
  const fromTick = options.fromTick ?? 0;
  const toTick = options.toTick ?? asOfTick;
  const network =
    options.network ??
    buildStandingPartyContactNetwork(state, {
      history,
      asOfTick,
      fromTick,
      toTick,
      includeActive: options.includeActive ?? true,
    });

  const statsOptions: BuildStandingPartyRunStatisticsOptions = {
    history,
    network,
    asOfTick,
    fromTick: options.fromTick,
    toTick: options.toTick,
    agentIds: options.agentIds,
    clusterIds: options.clusterIds,
    observerJoinerMode: options.observerJoinerMode,
    endReasons: options.endReasons,
    transitionResults: options.transitionResults,
    includeActive: options.includeActive,
    seriesSampleIntervalTicks: options.seriesSampleIntervalTicks,
  };
  const statistics = options.statistics ?? buildStandingPartyRunStatistics(state, statsOptions);
  const simParams = options.simParams;
  const informationConfig = options.standingPartyConfig?.informationPropagation;
  const informationAnalysis = buildInformationPropagationAnalysis(state, {
    config: informationConfig,
    filter: {
      fromTick: options.fromTick,
      toTick: options.toTick,
      agentIds: options.agentIds,
      clusterIds: options.clusterIds,
      observerJoinerMode: options.observerJoinerMode,
    },
    asOfTick,
  });

  return {
    schemaVersion: STANDING_PARTY_ANALYSIS_EXPORT_SCHEMA_VERSION,
    analysisSchemaVersion: STANDING_PARTY_ANALYSIS_SCHEMA_VERSION,
    generatedAtTick: asOfTick,
    run: {
      seed: state.seed ?? 0,
      ...(options.presetId !== undefined ? { presetId: options.presetId } : {}),
      ...(state.formationScenarioId !== undefined
        ? { formationScenarioId: state.formationScenarioId }
        : {}),
      observationHorizon: {
        fromTick: statistics.fromTick,
        toTick: statistics.toTick,
        asOfTick: statistics.asOfTick,
      },
      config: options.standingPartyConfig ?? null,
      params: simParams
        ? {
            populationSize: simParams.populationSize,
            numLeaders: simParams.numLeaders,
            groupConfirmSize: simParams.groupConfirmSize,
            lateJoinEase: simParams.lateJoinEase,
            overallWillingness: simParams.overallWillingness,
            ambiguityDuration: simParams.ambiguityDuration,
            existingTieStrength: simParams.existingTieStrength,
          }
        : {
            populationSize: state.agents.length,
            numLeaders: 0,
            groupConfirmSize: 0,
            lateJoinEase: 0,
            overallWillingness:
              state.agents.length === 0
                ? 0
                : state.agents.reduce((sum, a) => sum + a.willingness, 0) / state.agents.length,
            ambiguityDuration: 0,
            existingTieStrength: 0,
          },
    },
    history,
    contactNetwork: network,
    statistics,
    informationPropagation: {
      schemaVersion: INFORMATION_PROPAGATION_ANALYSIS_SCHEMA_VERSION,
      config: informationConfig ?? null,
      topics: informationAnalysis.topics,
      claims: informationAnalysis.claims,
      variants: informationAnalysis.variants,
      agentInformation: informationAnalysis.agentSnapshots,
      clusterTopics: informationAnalysis.clusterSnapshots,
      utterances: [...(state.contentUtteranceLog ?? [])],
      receptions: [...(state.informationReceptionLog ?? [])],
      adoptionDecisions: [...(state.informationAdoptionLog ?? [])],
      memoryUpdates: [...(state.informationMemoryUpdateLog ?? [])],
      retellings: [...(state.retellingLog ?? [])],
      transmissions: informationAnalysis.transmissions,
      propagationEdges: informationAnalysis.propagationEdges,
      lineage: informationAnalysis.lineage,
      timeline: informationAnalysis.timeline,
      statistics: informationAnalysis.statistics,
    },
  };
}

export function episodesToCsv(episodes: readonly ConversationEpisodeRecord[]): string {
  return rowsToCsv(
    [
      "episodeId",
      "agentId",
      "clusterId",
      "startedAtTick",
      "endedAtTick",
      "dwellTicks",
      "status",
      "endReason",
      "joinedGroupStatus",
      "activeOrCensored",
    ],
    episodes.map((ep) => [
      ep.episodeId,
      ep.agentId,
      ep.clusterId,
      ep.startedAtTick,
      ep.endedAtTick,
      ep.dwellTicks,
      ep.status,
      ep.endReason,
      ep.joinedGroupStatus,
      ep.status !== "completed",
    ]),
  );
}

export function contactIntervalsToCsv(intervals: readonly ContactIntervalRecord[]): string {
  return rowsToCsv(
    [
      "contactIntervalId",
      "agentIdA",
      "agentIdB",
      "clusterId",
      "startedAtTick",
      "endedAtTick",
      "dwellTicks",
      "status",
      "activeOrCensored",
    ],
    intervals.map((iv) => [
      iv.contactIntervalId,
      iv.agentIdA,
      iv.agentIdB,
      iv.clusterId,
      iv.startedAtTick,
      iv.endedAtTick,
      iv.dwellTicks,
      iv.status,
      iv.status !== "completed",
    ]),
  );
}

export function contactEdgesToCsv(edges: readonly ContactNetworkEdge[]): string {
  return rowsToCsv(
    [
      "edgeKey",
      "agentIdA",
      "agentIdB",
      "totalCoPresenceTicks",
      "contactIntervalCount",
      "distinctClusterCount",
      "firstContactTick",
      "lastContactTick",
      "isActive",
    ],
    edges.map((edge) => [
      edge.edgeKey,
      edge.agentIdA,
      edge.agentIdB,
      edge.totalCoPresenceTicks,
      edge.contactIntervalCount,
      edge.distinctClusterCount,
      edge.firstContactTick,
      edge.lastContactTick,
      edge.isActive,
    ]),
  );
}

export function agentStatisticsToCsv(agents: readonly StandingPartyAgentStatistics[]): string {
  return rowsToCsv(
    [
      "agentId",
      "label",
      "isObserverJoiner",
      "finalState",
      "startedEpisodeCount",
      "completedEpisodeCount",
      "activeEpisodeCount",
      "completedDwellMedian",
      "completedDwellCount",
      "currentEpisodeDwellTicks",
      "distinctContactCount",
      "contactIntervalCount",
      "totalContactTicks",
      "voluntaryDepartureCount",
      "forcedReleaseCount",
      "departAndExploreCount",
      "targetedTransitionStartedCount",
      "targetedTransitionSuccessCount",
      "targetedTransitionFailureCount",
      "targetedTransitionFallbackCount",
      "targetedTransitionSuccessRate",
      "stayedByAttachmentCount",
      "stayedByDepartureConcernCount",
      "stayedByMixedInhibitionCount",
      "venueExitTick",
      "hasExitedVenue",
    ],
    agents.map((a) => [
      a.agentId,
      a.label,
      a.isObserverJoiner,
      a.finalState,
      a.startedEpisodeCount,
      a.completedEpisodeCount,
      a.activeEpisodeCount,
      a.completedDwellTicks.median,
      a.completedDwellTicks.count,
      a.currentEpisodeDwellTicks,
      a.distinctContactCount,
      a.contactIntervalCount,
      a.totalContactTicks,
      a.voluntaryDepartureCount,
      a.forcedReleaseCount,
      a.departAndExploreCount,
      a.targetedTransitionStartedCount,
      a.targetedTransitionSuccessCount,
      a.targetedTransitionFailureCount,
      a.targetedTransitionFallbackCount,
      a.targetedTransitionSuccessRate.rate,
      a.stayedByAttachmentCount,
      a.stayedByDepartureConcernCount,
      a.stayedByMixedInhibitionCount,
      a.venueExitTick,
      a.hasExitedVenue,
    ]),
  );
}

export function clusterStatisticsToCsv(clusters: readonly StandingPartyClusterStatistics[]): string {
  return rowsToCsv(
    [
      "clusterId",
      "founderAgentId",
      "createdAtTick",
      "confirmedAtTick",
      "endedAtTick",
      "status",
      "endReason",
      "lifetimeTicks",
      "activeDurationTicks",
      "peakMemberCount",
      "meanMemberCount",
      "finalMemberCount",
      "uniqueMemberCount",
      "joinCount",
      "voluntaryLeaveCount",
      "forcedReleaseCount",
      "turnoverRate",
      "targetedTransitionInflowCount",
      "targetedTransitionOutflowCount",
      "activeOrCensored",
    ],
    clusters.map((c) => [
      c.clusterId,
      c.founderAgentId,
      c.createdAtTick,
      c.confirmedAtTick,
      c.endedAtTick,
      c.status,
      c.endReason,
      c.lifetimeTicks,
      c.activeDurationTicks,
      c.peakMemberCount,
      c.meanMemberCount,
      c.finalMemberCount,
      c.uniqueMemberCount,
      c.joinCount,
      c.voluntaryLeaveCount,
      c.forcedReleaseCount,
      c.turnoverRate,
      c.targetedTransitionInflowCount,
      c.targetedTransitionOutflowCount,
      c.status !== "completed",
    ]),
  );
}

export function transitionsToCsv(transitions: readonly ClusterTransitionRecord[]): string {
  return rowsToCsv(
    [
      "transitionId",
      "agentId",
      "sourceClusterId",
      "targetClusterId",
      "focusAgentId",
      "startedAtTick",
      "endedAtTick",
      "result",
      "invalidationReason",
      "sourceEpisodeId",
      "targetEpisodeId",
      "elapsedTicks",
      "activeOrCensored",
    ],
    transitions.map((t) => [
      t.transitionId,
      t.agentId,
      t.sourceClusterId,
      t.targetClusterId,
      t.focusAgentId,
      t.startedAtTick,
      t.endedAtTick,
      t.result,
      t.invalidationReason,
      t.sourceEpisodeId,
      t.targetEpisodeId,
      t.elapsedTicks,
      t.endedAtTick === undefined,
    ]),
  );
}

/** Issue #234: catalogはpresentation文言ではなく、versioned domain ID/構造だけを出力する。 */
export function informationTopicsToCsv(bundle: InformationPropagationExport): string {
  return rowsToCsv(
    ["topicId", "labelKey", "descriptionKey", "relatedTopicIds", "baseSalience"],
    bundle.topics.map((topic) => [topic.id, topic.labelKey, topic.descriptionKey, topic.relatedTopicIds.join("|"), topic.baseSalience]),
  );
}

export function informationClaimsToCsv(bundle: InformationPropagationExport): string {
  return rowsToCsv(
    ["claimId", "topicId", "rootVariantId", "contentKey", "originalSourceId", "originalSourceKind", "originalSourceAgentId", "verifiability", "verificationStatus", "initialConfidence"],
    bundle.claims.map((claim) => [
      claim.id, claim.topicId, claim.rootVariantId, claim.contentKey, claim.originalSource.id,
      claim.originalSource.kind, claim.originalSource.agentId, claim.verifiability, claim.verificationStatus, claim.initialConfidence,
    ]),
  );
}

export function informationVariantsToCsv(bundle: InformationPropagationExport): string {
  return rowsToCsv(
    ["variantId", "claimId", "topicId", "parentVariantId", "hopDistance", "canonicalDistance", "lineageDepth", "generatedAtTick", "generatorAgentId", "retellingEventId", "mutationFactors"],
    bundle.variants.map((variant) => [
      variant.id, variant.canonicalClaimId, variant.topicId, variant.parentVariantId, variant.hopDistance,
      variant.canonicalDistance, variant.lineageDepth, variant.generatedAtTick, variant.generatorAgentId,
      variant.retellingEventId, JSON.stringify(variant.mutationFactors),
    ]),
  );
}

export function agentInformationToCsv(bundle: InformationPropagationExport): string {
  return rowsToCsv(
    ["agentId", "label", "isObserverJoiner", "claimId", "topicId", "awareness", "acceptance", "confidence", "memoryStrength", "activeVariantId", "firstEncounteredTick", "lastEncounteredTick", "firstHeardTick", "lastHeardTick", "heardCount", "understoodCount", "adoptionCount", "retellingCount", "lastRetoldTick", "sourceTraces"],
    bundle.agentInformation.flatMap((agent) => agent.claims.map((claim) => [
      agent.agentId, agent.label, agent.isObserverJoiner, claim.claimId, claim.topicId, claim.awareness,
      claim.acceptance, claim.confidence, claim.memoryStrength, claim.activeVariantId, claim.firstEncounteredTick,
      claim.lastEncounteredTick, claim.firstHeardTick, claim.lastHeardTick, claim.heardCount, claim.understoodCount,
      claim.adoptionCount, claim.retellingCount, claim.lastRetoldTick, JSON.stringify(claim.sourceTraces),
    ])),
  );
}

export function informationUtterancesToCsv(utterances: readonly ContentUtteranceEvent[]): string {
  return rowsToCsv(
    ["contentUtteranceId", "tick", "speechEventId", "speakerId", "clusterId", "topicId", "claimId", "variantId", "reason", "sourceTraceIds"],
    utterances.map((event) => [event.id, event.tick, event.speechEventId, event.speakerId, event.clusterId, event.topicId, event.claimId, event.variantId, event.reason, event.sourceTraceIds.join("|")]),
  );
}

export function informationReceptionsToCsv(receptions: readonly InformationReceptionEvent[]): string {
  return rowsToCsv(
    ["receptionId", "tick", "contentUtteranceId", "speechReceptionEventId", "speakerId", "receiverId", "clusterId", "claimId", "variantId", "heard", "comprehension", "comprehensionFactors"],
    receptions.map((event) => [event.id, event.tick, event.contentUtteranceId, event.speechReceptionEventId, event.speakerId, event.receiverId, event.clusterId, event.claimId, event.variantId, event.heard, event.comprehension, JSON.stringify(event.comprehensionFactors)]),
  );
}

export function informationAdoptionsToCsv(events: readonly InformationAdoptionEvent[]): string {
  return rowsToCsv(
    ["adoptionEventId", "tick", "receiverId", "claimId", "consideredVariantIds", "receptionEventIds", "result", "previousConfidence", "nextConfidence", "confidenceDelta", "probability", "draw", "factors"],
    events.map((event) => [event.id, event.tick, event.receiverId, event.claimId, event.consideredVariantIds.join("|"), event.receptionEventIds.join("|"), event.result, event.previousConfidence, event.nextConfidence, event.confidenceDelta, event.probability, event.draw, JSON.stringify(event.factors)]),
  );
}

export function informationMemoryUpdatesToCsv(events: readonly InformationMemoryUpdateEvent[]): string {
  return rowsToCsv(
    ["memoryUpdateEventId", "tick", "receiverId", "claimId", "adoptionEventId", "receptionEventIds", "reason", "previousAwareness", "nextAwareness", "previousMemoryStrength", "nextMemoryStrength", "sourceTraceIdsAdded"],
    events.map((event) => [event.id, event.tick, event.receiverId, event.claimId, event.adoptionEventId, event.receptionEventIds.join("|"), event.reason, event.previousAwareness, event.nextAwareness, event.previousMemoryStrength, event.nextMemoryStrength, event.sourceTraceIdsAdded.join("|")]),
  );
}

export function informationRetellingsToCsv(events: readonly RetellingEvent[]): string {
  return rowsToCsv(
    ["retellingEventId", "tick", "clusterId", "speakerId", "claimId", "inputVariantId", "outputVariantId", "contentUtteranceId", "result", "probability", "draw", "blockedReason", "sourceReceptionIds", "sourceTraceIds", "mutationFactors"],
    events.map((event) => [event.id, event.tick, event.clusterId, event.speakerId, event.claimId, event.inputVariantId, event.outputVariantId, event.contentUtteranceId, event.result, event.probability, event.draw, event.blockedReason, event.sourceReceptionIds.join("|"), event.sourceTraceIds.join("|"), JSON.stringify(event.mutationFactors)]),
  );
}

export function informationTransmissionsToCsv(bundle: InformationPropagationExport): string {
  return rowsToCsv(
    ["transmissionId", "tick", "speakerId", "receiverId", "clusterId", "topicId", "claimId", "variantId", "speechEventId", "contentUtteranceId", "speechReceptionEventId", "informationReceptionEventId", "adoptionEventId", "memoryUpdateEventId", "result", "confidenceDelta", "retellingEventId", "retellingResult"],
    bundle.transmissions.map((event) => [event.id, event.tick, event.speakerId, event.receiverId, event.clusterId, event.topicId, event.claimId, event.variantId, event.speechEventId, event.contentUtteranceId, event.speechReceptionEventId, event.informationReceptionEventId, event.adoptionEventId, event.memoryUpdateEventId, event.result, event.confidenceDelta, event.retellingEventId, event.retellingResult]),
  );
}

export function informationStatisticsToCsv(bundle: InformationPropagationExport): string {
  return rowsToCsv(
    ["level", "topicId", "claimId", "awareCount", "adoptedCount", "rememberedCount", "firstSpreadTick", "uniqueSpeakerCount", "uniqueReceiverCount"],
    [
      ...bundle.statistics.topic.map((stat) => ["topic", stat.topicId, "", stat.awareCount, stat.adoptedCount, stat.rememberedCount, stat.firstSpreadTick, "", ""]),
      ...bundle.statistics.claims.map((stat) => ["claim", stat.topicId, stat.claimId, stat.awareCount, stat.adoptedCount, stat.rememberedCount, stat.firstSpreadTick, stat.uniqueSpeakerCount, stat.uniqueReceiverCount]),
    ],
  );
}

/**
 * Issue #217: CSV 一式。列名・tick単位・active/censored・reason code をヘッダと列で明示。
 */
export function buildStandingPartyAnalysisCsvFiles(
  bundle: StandingPartyAnalysisExport,
): AnalysisCsvFile[] {
  return [
    {
      filename: "standing-party-episodes.csv",
      content: episodesToCsv(bundle.history.episodes),
    },
    {
      filename: "standing-party-contact-intervals.csv",
      content: contactIntervalsToCsv(bundle.contactNetwork.contactIntervals),
    },
    {
      filename: "standing-party-contact-edges.csv",
      content: contactEdgesToCsv(bundle.contactNetwork.edges),
    },
    {
      filename: "standing-party-agent-statistics.csv",
      content: agentStatisticsToCsv(bundle.statistics.agents),
    },
    {
      filename: "standing-party-cluster-statistics.csv",
      content: clusterStatisticsToCsv(bundle.statistics.clusters),
    },
    {
      filename: "standing-party-transitions.csv",
      content: transitionsToCsv(bundle.history.transitions),
    },
    {
      filename: "standing-party-information-topics.csv",
      content: informationTopicsToCsv(bundle.informationPropagation),
    },
    {
      filename: "standing-party-information-claims.csv",
      content: informationClaimsToCsv(bundle.informationPropagation),
    },
    {
      filename: "standing-party-information-variants.csv",
      content: informationVariantsToCsv(bundle.informationPropagation),
    },
    {
      filename: "standing-party-agent-information.csv",
      content: agentInformationToCsv(bundle.informationPropagation),
    },
    {
      filename: "standing-party-information-utterances.csv",
      content: informationUtterancesToCsv(bundle.informationPropagation.utterances),
    },
    {
      filename: "standing-party-information-receptions.csv",
      content: informationReceptionsToCsv(bundle.informationPropagation.receptions),
    },
    {
      filename: "standing-party-information-adoptions.csv",
      content: informationAdoptionsToCsv(bundle.informationPropagation.adoptionDecisions),
    },
    {
      filename: "standing-party-information-memory-updates.csv",
      content: informationMemoryUpdatesToCsv(bundle.informationPropagation.memoryUpdates),
    },
    {
      filename: "standing-party-information-transmissions.csv",
      content: informationTransmissionsToCsv(bundle.informationPropagation),
    },
    {
      filename: "standing-party-information-retellings.csv",
      content: informationRetellingsToCsv(bundle.informationPropagation.retellings),
    },
    {
      filename: "standing-party-information-statistics.csv",
      content: informationStatisticsToCsv(bundle.informationPropagation),
    },
  ];
}

/** ブラウザ download 用。simulation には触れない。 */
export function triggerTextDownload(filename: string, content: string, mime = "text/plain;charset=utf-8"): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export function assertExportDoesNotMutateState(
  state: SimulationState,
  run: () => unknown,
): void {
  const before = JSON.stringify(state);
  run();
  const after = JSON.stringify(state);
  if (before !== after) {
    throw new Error("analysisExport mutated SimulationState");
  }
}
