/**
 * Issue #229 (Phase 5, roadmap #172): `docs/information-propagation-phase5-model.md`(#228 ADR)
 * §2.4/§2.6/§7.1/§8の契約に基づく、agentごとのtopic/claim情報状態・初期配置・feature flagとconfig。
 *
 * このモジュールはagent状態のlookup/update・source trace・memory helper・初期配置の生成のみを扱う。
 * 発話選択・受信・採用・記憶更新・retellingの実行ロジックは対象外(#230以降) ―― ここでの「初期配置」は
 * tick 0時点の状態を決定的に作るだけで、以後の状態遷移(誰が何を聞いて採用したか)には踏み込まない。
 */
import type {
  ClaimCatalog,
  ClaimVariant,
  InformationClaim,
  TopicCatalog,
} from "./informationModel";
import {
  MAX_LINEAGE_DEPTH,
  MAX_VARIANTS_PER_CLAIM,
  STANDING_PARTY_CLAIM_CATALOG,
  STANDING_PARTY_TOPIC_CATALOG,
  validateClaimCatalog,
  validateTopicCatalog,
} from "./informationModel";
import { SeededRandom } from "./random";

// --- Agentごとの情報関連状態(§2.4) -----------------------------------------------------------

/** run不変のPhase 5専用profile。既存`Agent`のpersonality field(initiative/conformity等)の代替値にしない */
export type AgentInformationProfile = {
  /** [0, 1]、run中不変 */
  retellingTendency: number;
  /** [0, 1]、run中不変 */
  memoryRetention: number;
  baselineTopicInterest: Record<string, number>;
};

export type AgentTopicState = {
  topicId: string;
  /** [0, 1] */
  interest: number;
  /** [0, 1]、同じtopicの反復による一時状態 */
  fatigue: number;
  /** 未経験は`undefined` */
  lastDiscussedTick?: number;
};

/** 状態が存在しないことは"unaware"を表す。`"forgotten"`は「一度も聞いていない」とは異なる */
export type ClaimAwareness = "heardOf" | "understood" | "forgotten";
export type ClaimAcceptance = "notEvaluated" | "adopted" | "uncertain" | "rejected";

export type SourceTraceKind = "initialGrant" | "heardUtterance";

export type SourceTrace = {
  id: string;
  kind: SourceTraceKind;
  /** 不明ならundefined。架空sourceを補わない */
  originalSourceId?: string;
  /** heardUtteranceでは必須、initialGrantでは任意 */
  immediateSpeakerId?: string;
  /** heardUtteranceでは必須 */
  utteranceId?: string;
  /** heardUtteranceでは必須 */
  receptionId?: string;
  variantId: string;
  firstEncounteredTick: number;
  lastEncounteredTick: number;
  encounterCount: number;
};

export type AgentClaimState = {
  claimId: string;
  awareness: ClaimAwareness;
  /** awarenessとは独立 */
  acceptance: ClaimAcceptance;
  /** [0, 1] */
  confidence: number;
  /** [0, 1] */
  memoryStrength: number;
  firstEncounteredTick: number;
  lastEncounteredTick: number;
  /** initial grantだけならundefined。relearnで上書きしない */
  firstHeardTick?: number;
  lastHeardTick?: number;
  heardCount: number;
  understoodCount: number;
  adoptionCount: number;
  activeVariantId?: string;
  encounteredVariantIds: string[];
  sourceTraces: SourceTrace[];
  retellingCount: number;
  lastRetoldTick?: number;
  /** 同一tick cascade防止 */
  retellableFromTick?: number;
  lastMemoryEvaluationTick: number;
  /** 全agent×全claim走査を避けるschedule */
  forgetAtTick?: number;
};

export type AgentInformationState = {
  agentId: string;
  profile: AgentInformationProfile;
  topics: Record<string, AgentTopicState>;
  claims: Record<string, AgentClaimState>;
};

/**
 * `SimulationState.informationRuntime`の型。catalogとruntime stateの責務を分けるため、topic/claim
 * catalogそのものは含まない(catalogは`InformationPropagationConfig`側、run/scenario configに保持する)。
 */
export type InformationRuntimeState = Record<string, AgentInformationState>;

// --- 初期配置(§2.6) --------------------------------------------------------------------------

export type InitialInformationGrant = {
  agentId: string;
  claimId: string;
  /** 通常はroot */
  variantId: string;
  sourceId?: string;
  acceptance: ClaimAcceptance;
  confidence: number;
  memoryStrength: number;
};

export type InformationValueRange = {
  min: number;
  max: number;
};

export type InformationInitConfig = {
  /** claimごとに0人・1人・複数人を明示指定するfixture配置 */
  explicitGrants: InitialInformationGrant[];
  /** `explicitGrants`で埋まらなかった分の自動配置人数(claimId別)。0は自動配置なし */
  autoHolderCounts: Record<string, number>;
  /** topic interest分布(baseline) */
  interestDistribution: InformationValueRange;
  /** 自動配置holderの`initialConfidence`への加算jitter */
  confidenceJitter: InformationValueRange;
  /** 自動配置holderのmemoryStrength分布 */
  memoryStrengthRange: InformationValueRange;
};

export type InformationPropagationLimits = {
  maxVariantsPerClaim: number;
  maxLineageDepth: number;
  maxSourceTracesPerAgentClaim: number;
};

/**
 * Issue #230 (Phase 5): active clusterでの内容発話機会・話者・topic・claim選択に使う設定(§8.1)。
 * `informationPropagation.enabled`がfalseの間は`contentUtterance.ts`側の生成関数自体が呼ばれない
 * ため、この設定自体は常に存在してもよい(catalog/init/limitsと同じ既定値保持の方針)。
 */
export type ContentUtteranceConfig = {
  /** 同一clusterの発話機会を評価する間隔tick。integer >= 1 */
  utteranceIntervalTicks: number;
  /** 発話機会が巡ってきたclusterで実際に発話が起こる確率。[0, 1] */
  utteranceProbability: number;
  /** 同一cluster・同一tickに許容する発話数上限。integer 0..2 */
  maxUtterancesPerClusterPerTick: number;
  /** 同一agent・同一tickに許容する発話数上限。integer 0..1 */
  maxUtterancesPerAgentPerTick: number;
  /** 同一agentが同一clusterで連続して話者に選ばれないための最小間隔tick。integer >= 0 */
  speakerRepeatCooldownTicks: number;
  /** 同一claimが同一clusterで連続して話されないための最小間隔tick。integer >= 0 */
  claimRepeatCooldownTicks: number;
  /** 同一topicが最低限維持されるtick数(この間は他topicへの切替を抑止する)。integer >= 1 */
  minTopicDurationTicks: number;
  /** 現在topicを維持する方向への重み。[0, 1] */
  topicPersistence: number;
  /** topicが同一clusterで繰り返されるほど蓄積するfatigueの増分係数。[0, 1] */
  fatigueGain: number;
  /** tickごとのfatigue減衰係数。[0, 1] */
  fatigueDecay: number;
  /** cluster audience向け内容発話の到達距離(`SpeechEvent.range`相当)。finite > 0 */
  clusterAudienceRange: number;
  /** cluster audience向け内容発話の強さ(`SpeechEvent.strength`相当)。finite > 0 */
  clusterAudienceStrength: number;
};

/** `StandingPartyScenarioConfig`配下に置くPhase 5専用設定(§7.1/§9)。`enabled: false`が既定 */
export type InformationPropagationConfig = {
  enabled: boolean;
  topicCatalog: TopicCatalog;
  claimCatalog: ClaimCatalog;
  init: InformationInitConfig;
  limits: InformationPropagationLimits;
  contentUtterance: ContentUtteranceConfig;
};

// --- validation -------------------------------------------------------------------------------

function assertFiniteRange(name: string, range: InformationValueRange): void {
  if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) {
    throw new Error(`informationState: ${name} must be finite (got min=${range.min}, max=${range.max})`);
  }
  if (range.min > range.max) {
    throw new Error(`informationState: ${name}.min (${range.min}) must be <= max (${range.max})`);
  }
}

function assertUnitRange(name: string, range: InformationValueRange): void {
  assertFiniteRange(name, range);
  if (range.min < 0 || range.max > 1) {
    throw new Error(`informationState: ${name} must be within [0, 1] (got min=${range.min}, max=${range.max})`);
  }
}

function assertUnit(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`informationState: ${name} must be within [0, 1] (got ${value})`);
  }
}

/**
 * Issue #230: `ContentUtteranceConfig`のvalidation(§8.1の定義域表どおり)。NaN/Infinity・
 * 定義域外・非整数のintegerフィールドを拒否する。
 */
export function validateContentUtteranceConfig(config: ContentUtteranceConfig): void {
  for (const [name, value] of [
    ["utteranceIntervalTicks", config.utteranceIntervalTicks],
    ["minTopicDurationTicks", config.minTopicDurationTicks],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`informationState: contentUtterance.${name} must be a positive integer (got ${value})`);
    }
  }
  for (const [name, value] of [
    ["speakerRepeatCooldownTicks", config.speakerRepeatCooldownTicks],
    ["claimRepeatCooldownTicks", config.claimRepeatCooldownTicks],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`informationState: contentUtterance.${name} must be a non-negative integer (got ${value})`);
    }
  }
  if (!Number.isInteger(config.maxUtterancesPerClusterPerTick) || config.maxUtterancesPerClusterPerTick < 0 || config.maxUtterancesPerClusterPerTick > 2) {
    throw new Error(
      `informationState: contentUtterance.maxUtterancesPerClusterPerTick must be an integer within [0, 2] (got ${config.maxUtterancesPerClusterPerTick})`,
    );
  }
  if (!Number.isInteger(config.maxUtterancesPerAgentPerTick) || config.maxUtterancesPerAgentPerTick < 0 || config.maxUtterancesPerAgentPerTick > 1) {
    throw new Error(
      `informationState: contentUtterance.maxUtterancesPerAgentPerTick must be an integer within [0, 1] (got ${config.maxUtterancesPerAgentPerTick})`,
    );
  }
  assertUnit("contentUtterance.utteranceProbability", config.utteranceProbability);
  assertUnit("contentUtterance.topicPersistence", config.topicPersistence);
  assertUnit("contentUtterance.fatigueGain", config.fatigueGain);
  assertUnit("contentUtterance.fatigueDecay", config.fatigueDecay);
  for (const [name, value] of [
    ["clusterAudienceRange", config.clusterAudienceRange],
    ["clusterAudienceStrength", config.clusterAudienceStrength],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`informationState: contentUtterance.${name} must be a finite number > 0 (got ${value})`);
    }
  }
}

/**
 * catalog(委譲)・fixture配置・分布config・上限を検証する。不正ID参照、NaN/Infinity、定義域外値、
 * 負のholder数を拒否する(受入条件)。
 */
export function validateInformationPropagationConfig(config: InformationPropagationConfig): void {
  validateTopicCatalog(config.topicCatalog);
  validateClaimCatalog(config.claimCatalog, config.topicCatalog);
  validateContentUtteranceConfig(config.contentUtterance);

  const claimIds = new Set(config.claimCatalog.claims.map((claim) => claim.id));

  for (const grant of config.init.explicitGrants) {
    if (!grant.agentId) throw new Error("informationState: initial grant agentId must not be empty");
    if (!claimIds.has(grant.claimId)) {
      throw new Error(`informationState: initial grant references unknown claimId "${grant.claimId}"`);
    }
    assertUnit(`initial grant (${grant.agentId}, ${grant.claimId}).confidence`, grant.confidence);
    assertUnit(`initial grant (${grant.agentId}, ${grant.claimId}).memoryStrength`, grant.memoryStrength);
  }

  for (const [claimId, count] of Object.entries(config.init.autoHolderCounts)) {
    if (!claimIds.has(claimId)) {
      throw new Error(`informationState: autoHolderCounts references unknown claimId "${claimId}"`);
    }
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`informationState: autoHolderCounts["${claimId}"] must be a non-negative integer (got ${count})`);
    }
  }

  assertUnitRange("init.interestDistribution", config.init.interestDistribution);
  assertFiniteRange("init.confidenceJitter", config.init.confidenceJitter);
  assertUnitRange("init.memoryStrengthRange", config.init.memoryStrengthRange);

  for (const [name, value] of [
    ["limits.maxVariantsPerClaim", config.limits.maxVariantsPerClaim],
    ["limits.maxLineageDepth", config.limits.maxLineageDepth],
    ["limits.maxSourceTracesPerAgentClaim", config.limits.maxSourceTracesPerAgentClaim],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`informationState: ${name} must be a positive integer (got ${value})`);
    }
  }
}

// --- default / fixture -------------------------------------------------------------------------

export const DEFAULT_INFORMATION_INIT_CONFIG: InformationInitConfig = {
  explicitGrants: [],
  autoHolderCounts: {},
  interestDistribution: { min: 0.2, max: 0.8 },
  confidenceJitter: { min: -0.05, max: 0.05 },
  memoryStrengthRange: { min: 0.6, max: 0.95 },
};

export const DEFAULT_INFORMATION_PROPAGATION_LIMITS: InformationPropagationLimits = {
  maxVariantsPerClaim: MAX_VARIANTS_PER_CLAIM,
  maxLineageDepth: MAX_LINEAGE_DEPTH,
  maxSourceTracesPerAgentClaim: 8,
};

/** Issue #230: §8.1の初期推奨値。population約24・1000tickを想定した控えめな既定値 */
export const DEFAULT_CONTENT_UTTERANCE_CONFIG: ContentUtteranceConfig = {
  utteranceIntervalTicks: 4,
  utteranceProbability: 0.5,
  maxUtterancesPerClusterPerTick: 1,
  maxUtterancesPerAgentPerTick: 1,
  speakerRepeatCooldownTicks: 3,
  claimRepeatCooldownTicks: 6,
  minTopicDurationTicks: 3,
  topicPersistence: 0.6,
  fatigueGain: 0.2,
  fatigueDecay: 0.05,
  clusterAudienceRange: 90,
  clusterAudienceStrength: 1,
};

/**
 * master flag OFF(既定)。無効時はcatalog/init/limitsを持つが、`createInitialInformationRuntimeState`は
 * `enabled`を見て呼び出し側(engine.ts)が完全にskipする(受入条件: Phase 5 disabled時に既存Agent、
 * state、event、PRNG系列が変わらない)。
 */
export const DEFAULT_INFORMATION_PROPAGATION_CONFIG: InformationPropagationConfig = {
  enabled: false,
  topicCatalog: STANDING_PARTY_TOPIC_CATALOG,
  claimCatalog: STANDING_PARTY_CLAIM_CATALOG,
  init: DEFAULT_INFORMATION_INIT_CONFIG,
  limits: DEFAULT_INFORMATION_PROPAGATION_LIMITS,
  contentUtterance: DEFAULT_CONTENT_UTTERANCE_CONFIG,
};

validateInformationPropagationConfig(DEFAULT_INFORMATION_PROPAGATION_CONFIG);

// --- pure helper: lookup / update --------------------------------------------------------------

/** [0, 1]へclampする。NaN/Infinityは0として扱う(memory clamp、受入条件の定義域外値対策) */
export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function getAgentInformationState(
  runtime: InformationRuntimeState,
  agentId: string,
): AgentInformationState | undefined {
  return runtime[agentId];
}

export function getAgentTopicState(
  runtime: InformationRuntimeState,
  agentId: string,
  topicId: string,
): AgentTopicState | undefined {
  return runtime[agentId]?.topics[topicId];
}

export function getAgentClaimState(
  runtime: InformationRuntimeState,
  agentId: string,
  claimId: string,
): AgentClaimState | undefined {
  return runtime[agentId]?.claims[claimId];
}

/** 指定agentの`AgentTopicState`だけを置き換えた新しい`InformationRuntimeState`を返す(非破壊) */
export function withAgentTopicState(
  runtime: InformationRuntimeState,
  agentId: string,
  topicState: AgentTopicState,
): InformationRuntimeState {
  const existing = runtime[agentId];
  if (!existing) throw new Error(`informationState: unknown agentId "${agentId}"`);
  return {
    ...runtime,
    [agentId]: { ...existing, topics: { ...existing.topics, [topicState.topicId]: topicState } },
  };
}

/** 指定agentの`AgentClaimState`だけを置き換えた新しい`InformationRuntimeState`を返す(非破壊) */
export function withAgentClaimState(
  runtime: InformationRuntimeState,
  agentId: string,
  claimState: AgentClaimState,
): InformationRuntimeState {
  const existing = runtime[agentId];
  if (!existing) throw new Error(`informationState: unknown agentId "${agentId}"`);
  return {
    ...runtime,
    [agentId]: { ...existing, claims: { ...existing.claims, [claimState.claimId]: claimState } },
  };
}

/**
 * source traceを追加する。同一source(kind + originalSourceId + immediateSpeakerId)は既存traceへ
 * fold(encounterCountを加算・lastEncounteredTickを更新)し、上限超過時は初期grant traceを監査用に
 * 優先して残しつつ、最も古いheardUtterance traceから要約(削除)する(§8.2)。
 */
export function addSourceTrace(existingTraces: SourceTrace[], incoming: SourceTrace, cap: number): SourceTrace[] {
  const matchIndex = existingTraces.findIndex(
    (trace) =>
      trace.kind === incoming.kind &&
      trace.originalSourceId === incoming.originalSourceId &&
      trace.immediateSpeakerId === incoming.immediateSpeakerId,
  );

  let next: SourceTrace[];
  if (matchIndex >= 0) {
    const existing = existingTraces[matchIndex];
    const folded: SourceTrace = {
      ...existing,
      lastEncounteredTick: Math.max(existing.lastEncounteredTick, incoming.lastEncounteredTick),
      encounterCount: existing.encounterCount + incoming.encounterCount,
      variantId: incoming.variantId,
    };
    next = [...existingTraces.slice(0, matchIndex), folded, ...existingTraces.slice(matchIndex + 1)];
  } else {
    next = [...existingTraces, incoming];
  }

  if (next.length <= cap) return next;
  const sorted = [...next].sort((a, b) => {
    if (a.kind === "initialGrant" && b.kind !== "initialGrant") return -1;
    if (b.kind === "initialGrant" && a.kind !== "initialGrant") return 1;
    return b.lastEncounteredTick - a.lastEncounteredTick;
  });
  return sorted.slice(0, cap);
}

/**
 * variantの祖先チェーンをroot→対象variantの順で返す(variant lineage traversal、受入条件のpure helper)。
 * cycleを検出した場合は例外を投げる(catalog validationをすり抜けた場合の防御)。
 */
export function traverseVariantLineage(catalog: ClaimCatalog, variantId: string): ClaimVariant[] {
  const variantById = new Map(catalog.variants.map((variant) => [variant.id, variant]));
  const start = variantById.get(variantId);
  if (!start) throw new Error(`informationState: unknown variantId "${variantId}"`);

  const chain: ClaimVariant[] = [];
  const visited = new Set<string>();
  let current: ClaimVariant | undefined = start;
  while (current) {
    if (visited.has(current.id)) {
      throw new Error(`informationState: lineage cycle detected while traversing variant "${variantId}"`);
    }
    visited.add(current.id);
    chain.unshift(current);
    current = current.parentVariantId ? variantById.get(current.parentVariantId) : undefined;
  }
  return chain;
}

/** そのclaimを認識している(claim stateを持つ)agent IDの集合をid昇順で返す */
export function listAgentsAwareOfClaim(runtime: InformationRuntimeState, claimId: string): string[] {
  return Object.values(runtime)
    .filter((agentState) => agentState.claims[claimId] !== undefined)
    .map((agentState) => agentState.agentId)
    .sort();
}

/** そのtopicへの関心が`minInterest`以上のagent IDの集合をid昇順で返す */
export function listAgentsInterestedInTopic(
  runtime: InformationRuntimeState,
  topicId: string,
  minInterest = 0,
): string[] {
  return Object.values(runtime)
    .filter((agentState) => (agentState.topics[topicId]?.interest ?? 0) >= minInterest)
    .map((agentState) => agentState.agentId)
    .sort();
}

// --- 初期配置の生成(§2.6/§5.2) ---------------------------------------------------------------

/** FNV-1a風の単純な文字列ハッシュ(`schoolInterventionRuntime.ts`/`model.ts`と同じ表現専用パターン) */
function hashString(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const INIT_STREAM_NAMESPACE = "standing-party-information-init-v1";

/**
 * 本体`SeededRandom`とは独立したentity-key派生streamを作る(§5.2、§9受入条件: 対象選択のための乱数消費が
 * 本体の行動乱数系列を不用意にずらさない)。この関数・呼び出し元は本体`rng`を一切受け取らない。
 */
function deriveInitRandom(seed: number, ...parts: (string | number)[]): SeededRandom {
  return new SeededRandom(hashString([seed, INIT_STREAM_NAMESPACE, ...parts].join(":")));
}

/**
 * agentごとのrun不変profile(§2.4)を、`seed`と`agentId`から決定的に導出する。topic interestの
 * baselineは`interestRange`(claimごとの分布とは独立、topic単位の分布)からサンプルする。
 */
export function createAgentInformationProfile(
  seed: number,
  agentId: string,
  topicCatalog: TopicCatalog,
  interestRange: InformationValueRange = { min: 0, max: 1 },
): AgentInformationProfile {
  const profileRng = deriveInitRandom(seed, "profile", agentId);
  const baselineTopicInterest: Record<string, number> = {};
  for (const topic of topicCatalog.topics) {
    const topicRng = deriveInitRandom(seed, "topic-interest", topic.id, agentId);
    baselineTopicInterest[topic.id] = clampUnit(topicRng.range(interestRange.min, interestRange.max));
  }
  return {
    retellingTendency: profileRng.range(0, 1),
    memoryRetention: profileRng.range(0, 1),
    baselineTopicInterest,
  };
}

function createEmptyAgentInformationState(
  agentId: string,
  seed: number,
  topicCatalog: TopicCatalog,
  interestRange: InformationValueRange,
): AgentInformationState {
  const profile = createAgentInformationProfile(seed, agentId, topicCatalog, interestRange);
  const topics: Record<string, AgentTopicState> = {};
  for (const topic of topicCatalog.topics) {
    topics[topic.id] = {
      topicId: topic.id,
      interest: profile.baselineTopicInterest[topic.id] ?? 0,
      fatigue: 0,
      lastDiscussedTick: undefined,
    };
  }
  return { agentId, profile, topics, claims: {} };
}

/**
 * 実際に誰かから聞いていない初期保有(initial grant)を1件、agent stateへ適用する。
 * `SourceTrace(kind: "initialGrant")`を作り、`firstEncounteredTick`/`lastEncounteredTick`は`tick`、
 * `firstHeardTick`/`lastHeardTick`はundefinedのままにする(§2.6: immediate speaker/utterance/receptionを
 * 捏造しない)。
 */
export function applyInitialGrant(
  state: AgentInformationState,
  grant: InitialInformationGrant,
  tick: number,
): AgentInformationState {
  const trace: SourceTrace = {
    id: `source-initial-${grant.agentId}-${grant.claimId}`,
    kind: "initialGrant",
    originalSourceId: grant.sourceId,
    immediateSpeakerId: undefined,
    utteranceId: undefined,
    receptionId: undefined,
    variantId: grant.variantId,
    firstEncounteredTick: tick,
    lastEncounteredTick: tick,
    encounterCount: 1,
  };
  const claimState: AgentClaimState = {
    claimId: grant.claimId,
    awareness: "understood",
    acceptance: grant.acceptance,
    confidence: clampUnit(grant.confidence),
    memoryStrength: clampUnit(grant.memoryStrength),
    firstEncounteredTick: tick,
    lastEncounteredTick: tick,
    firstHeardTick: undefined,
    lastHeardTick: undefined,
    heardCount: 0,
    understoodCount: 0,
    adoptionCount: grant.acceptance === "adopted" ? 1 : 0,
    activeVariantId: grant.variantId,
    encounteredVariantIds: [grant.variantId],
    sourceTraces: [trace],
    retellingCount: 0,
    lastRetoldTick: undefined,
    retellableFromTick: tick,
    lastMemoryEvaluationTick: tick,
    forgetAtTick: undefined,
  };
  return { ...state, claims: { ...state.claims, [grant.claimId]: claimState } };
}

function selectAutoHolders(
  seed: number,
  claim: InformationClaim,
  candidateAgentIds: readonly string[],
  holderCount: number,
): string[] {
  const scored = candidateAgentIds
    .map((agentId) => ({ agentId, score: deriveInitRandom(seed, "holder-selection", claim.id, agentId).next() }))
    .sort((a, b) => a.score - b.score || (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
  return scored.slice(0, holderCount).map((entry) => entry.agentId);
}

/**
 * tick 0時点の`InformationRuntimeState`を、明示fixture配置(`config.init.explicitGrants`)と
 * seed付き自動配置(`config.init.autoHolderCounts`)の両方から決定的に生成する(§2.6)。
 *
 * - 呼び出し側(engine.ts)は`config.enabled`を見て、無効時はこの関数自体を呼ばない
 *   (受入条件: Phase 5 disabled時に既存Agent、state、event、PRNG系列が変わらない)。
 * - 本体`SeededRandom`は一切受け取らない。全ての乱数は`deriveInitRandom`由来の独立streamであり、
 *   `agents`配列の順序に依存しない(`candidateAgentIds`をsortしてから選出する)。
 * - 同一`seed`・同一`config`なら常に同一の結果になる(受入条件)。
 */
export function createInitialInformationRuntimeState(
  agents: readonly { id: string }[],
  seed: number,
  config: InformationPropagationConfig,
  tick = 0,
): InformationRuntimeState {
  validateInformationPropagationConfig(config);

  const runtime: InformationRuntimeState = {};
  for (const agent of agents) {
    runtime[agent.id] = createEmptyAgentInformationState(agent.id, seed, config.topicCatalog, config.init.interestDistribution);
  }

  const agentIds = agents.map((agent) => agent.id).filter((id) => runtime[id] !== undefined).sort();
  const grantedPairs = new Set<string>();

  for (const grant of config.init.explicitGrants) {
    if (!runtime[grant.agentId]) continue; // fixtureがこのrunの人口外のagentIdを参照した場合は無視する
    runtime[grant.agentId] = applyInitialGrant(runtime[grant.agentId], grant, tick);
    grantedPairs.add(`${grant.claimId}:${grant.agentId}`);
  }

  for (const claim of config.claimCatalog.claims) {
    const holderCount = config.init.autoHolderCounts[claim.id] ?? 0;
    if (holderCount <= 0) continue;
    const candidates = agentIds.filter((agentId) => !grantedPairs.has(`${claim.id}:${agentId}`));
    const chosen = selectAutoHolders(seed, claim, candidates, holderCount);
    for (const agentId of chosen) {
      const confidenceRng = deriveInitRandom(seed, "holder-confidence", claim.id, agentId);
      const memoryRng = deriveInitRandom(seed, "holder-memory", claim.id, agentId);
      const jitter = confidenceRng.range(config.init.confidenceJitter.min, config.init.confidenceJitter.max);
      const grant: InitialInformationGrant = {
        agentId,
        claimId: claim.id,
        variantId: claim.rootVariantId,
        sourceId: claim.originalSource.id,
        acceptance: "adopted",
        confidence: clampUnit(claim.initialConfidence + jitter),
        memoryStrength: memoryRng.range(config.init.memoryStrengthRange.min, config.init.memoryStrengthRange.max),
      };
      runtime[agentId] = applyInitialGrant(runtime[agentId], grant, tick);
    }
  }

  return runtime;
}
