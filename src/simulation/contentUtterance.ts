/**
 * Issue #230/#232 (Phase 5, roadmap #172): `docs/information-propagation-phase5-model.md`(#228 ADR)
 * §3〜§6の契約に基づく、active clusterでの発話機会・話者・topic・claim/variant選択と、
 * `ContentUtteranceEvent` + carrier `SpeechEvent`の生成。
 *
 * このモジュールが行うのは「誰が・いつ・何のtopicを・どのclaim/variantとして話すか」の決定と
 * event生成だけである。受け手の認知・採用・記憶更新(`InformationReceptionEvent`以降、#231)は対象外。
 *
 * Issue #232: 既知claim(`reason === "knownClaimShare"`)を話す手番では、variant選択の直後に
 * `retelling.ts`のretelling decision/variant変容を挟む(ADR §5 step5)。そのため`InformationRuntimeState`
 * は「話者自身の`retellingCount`/`lastRetoldTick`更新」だけを例外的に書き換えうる(§4.4: retelling count /
 * lastRetoldTick更新はContentUtterance生成成功と同じcommitで行う) ―― adoption/memory(受信者側の
 * acceptance/confidence/memoryStrength/awareness)は一切書き換えない(#231のまま)。
 *
 * RNGは本体`SeededRandom`を受け取らない。§5.2のとおり`runSeed`から論理decisionごとに
 * entity-key派生streamを作る(`deriveContentRandom`、`retelling.ts`側の派生streamも同様)ため、
 * Phase 5 disabled/未該当tickでは呼び出し自体が発生せず、本体のPRNG消費列に一切影響しない。
 */
import type { Agent, GroupCandidate } from "./types";
import type { ClaimCatalog, ClaimVariant, InformationClaim, TopicCatalog, TopicDefinition } from "./informationModel";
import type {
  AgentClaimState,
  ContentUtteranceConfig,
  InformationPropagationLimits,
  InformationRuntimeState,
  RetellingConfig,
} from "./informationState";
import { withAgentClaimState } from "./informationState";
import type { ClusterTopicRuntimeState, ClusterTopicState } from "./conversationTopic";
import {
  computeClusterTopicFatigue,
  createInitialClusterTopicState,
  pruneClusterTopicRuntimeState,
  recordSkip,
  recordUtterance,
  syncClusterMembership,
} from "./conversationTopic";
import { mergeGeneratedVariants } from "./claimVariant";
import type { RetellingEvent, RetellingRuntimeState } from "./retelling";
import { deriveRetellingOutcome, withClusterVariantTellIncrement } from "./retelling";
import type { SpeechEvent } from "./speech";
import { createSpeechEvent } from "./speech";
import { SeededRandom } from "./random";
import type { InterventionEvent } from "./schoolInterventionRuntime";

/** 発話の分類理由。"retelling"は#232のvariant変容が実際に発生した(`RetellingEvent.result === "mutated"`)手番の分類として使う */
export type ContentUtteranceReason = "originalShare" | "knownClaimShare" | "retelling";

export type ContentUtteranceEvent = {
  id: string;
  tick: number;
  speechEventId: string;
  speakerId: string;
  clusterId: string;
  topicId: string;
  claimId: string;
  variantId: string;
  target?: string;
  audience?: "cluster" | "nearby";
  reason: ContentUtteranceReason;
  sourceTraceIds: string[];
};

export type ContentUtteranceGenerationContext = {
  tick: number;
  agents: readonly Agent[];
  groupCandidates: readonly GroupCandidate[];
  informationRuntime: InformationRuntimeState;
  clusterTopicRuntime: ClusterTopicRuntimeState;
  topicCatalog: TopicCatalog;
  /** 呼び出し側(`engine.ts`)が静的fixture catalogへこのrunで生成済みの全variantをmerge済みのもの */
  claimCatalog: ClaimCatalog;
  config: ContentUtteranceConfig;
  /** Issue #232: `retelling.ts`のdedup/lineage上限判定に使う(`maxVariantsPerClaim`/`maxLineageDepth`) */
  limits: InformationPropagationLimits;
  /** Issue #232: retelling decision/mutationの設定 */
  retellingConfig: RetellingConfig;
  /** Issue #232: 同一cluster内の同一variant反復回数(cluster横断のrun-scoped state) */
  retellingRuntime: RetellingRuntimeState;
  runSeed: number;
};

export type ContentUtteranceGenerationResult = {
  utterances: ContentUtteranceEvent[];
  speechEvents: SpeechEvent[];
  clusterTopicRuntime: ClusterTopicRuntimeState;
  events: InterventionEvent[];
  /** Issue #232: 話者自身の`retellingCount`/`lastRetoldTick`だけを反映した更新後state(それ以外は入力と同一) */
  informationRuntime: InformationRuntimeState;
  /** Issue #232: このtickで新規生成された(dedupされなかった)`ClaimVariant`。呼び出し側がcatalogへmergeする */
  generatedVariants: ClaimVariant[];
  retellingEvents: RetellingEvent[];
  retellingRuntime: RetellingRuntimeState;
};

const RNG_NAMESPACE = "standing-party-content-utterance-v1";

/** FNV-1a風の単純な文字列ハッシュ(`informationState.ts`/`schoolInterventionRuntime.ts`と同じ表現専用パターン) */
function hashString(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 本体`SeededRandom`とは独立した、論理decisionごとのentity-key派生stream(§5.2) */
function deriveContentRandom(seed: number, stage: string, ...parts: (string | number)[]): SeededRandom {
  return new SeededRandom(hashString([seed, RNG_NAMESPACE, stage, ...parts].join(":")));
}

type WeightedCandidate<T> = { item: T; weight: number };

/**
 * 重み付き乱択。全候補のweightが0以下の場合は一様分布として扱う(deadlock回避)。
 * `candidates`はstable order(呼び出し側がid昇順等で並べたもの)を渡すこと ―― 結果はRNGの1回の
 * 消費だけで決まり、同じ`candidates`順・同じrng状態なら常に同じ結果になる。
 */
function weightedPick<T>(candidates: WeightedCandidate<T>[], rng: SeededRandom): T {
  const total = candidates.reduce((sum, c) => sum + Math.max(0, c.weight), 0);
  const draw = rng.next();
  if (total <= 0) {
    const index = Math.min(candidates.length - 1, Math.floor(draw * candidates.length));
    return candidates[index].item;
  }
  let threshold = draw * total;
  for (const candidate of candidates) {
    threshold -= Math.max(0, candidate.weight);
    if (threshold <= 0) return candidate.item;
  }
  return candidates[candidates.length - 1].item;
}

function sortById<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** `awareness !== "forgotten" && memoryStrength > 0`のpure predicate(§2.4のrememberedの簡約版) */
function isRemembered(claimState: AgentClaimState): boolean {
  return claimState.awareness !== "forgotten" && claimState.memoryStrength > 0;
}

function confirmedClusterMembers(candidate: GroupCandidate, agents: readonly Agent[]): Agent[] {
  return sortById(agents.filter((agent) => agent.state === "joined" && agent.joinedGroupId === candidate.id));
}

/** speakerの既知claimのうち、このtickに話せるもの(rememberedかつclaim cooldown外)を返す */
function eligibleClaimStates(
  speakerId: string,
  runtime: InformationRuntimeState,
  clusterState: ClusterTopicState,
  claimRepeatCooldownTicks: number,
  tick: number,
): AgentClaimState[] {
  const agentState = runtime[speakerId];
  if (!agentState) return [];
  return Object.values(agentState.claims).filter((claimState) => {
    if (!isRemembered(claimState)) return false;
    const lastTold = clusterState.claimLastToldTick[claimState.claimId];
    if (lastTold === undefined) return true;
    return tick - lastTold >= claimRepeatCooldownTicks;
  });
}

function buildSpeakerCandidates(
  members: readonly Agent[],
  excludeAgentIds: ReadonlySet<string>,
  clusterState: ClusterTopicState,
  ctx: ContentUtteranceGenerationContext,
): WeightedCandidate<Agent>[] {
  const candidates: WeightedCandidate<Agent>[] = [];
  for (const member of members) {
    if (excludeAgentIds.has(member.id)) continue;
    const lastTurn = clusterState.speakerLastTurnTick[member.id];
    if (lastTurn !== undefined && ctx.tick - lastTurn < ctx.config.speakerRepeatCooldownTicks) continue;
    const claims = eligibleClaimStates(member.id, ctx.informationRuntime, clusterState, ctx.config.claimRepeatCooldownTicks, ctx.tick);
    if (claims.length === 0) continue;

    const profile = ctx.informationRuntime[member.id]?.profile;
    const topicInterestAvg =
      claims.reduce((sum, c) => {
        const claim = ctx.claimCatalog.claims.find((cl) => cl.id === c.claimId);
        const interest = claim ? (profile?.baselineTopicInterest[claim.topicId] ?? 0) : 0;
        return sum + interest;
      }, 0) / claims.length;
    const memoryStrengthAvg = claims.reduce((sum, c) => sum + c.memoryStrength, 0) / claims.length;
    const retellingTendency = profile?.retellingTendency ?? 0;
    const ticksSinceLastTurn = lastTurn === undefined ? ctx.config.speakerRepeatCooldownTicks * 4 : ctx.tick - lastTurn;
    const fairnessBoost = Math.min(1, ticksSinceLastTurn / (ctx.config.speakerRepeatCooldownTicks * 4 || 1));
    // 直前の発話者そのものは、turn fairnessのため大きく減点する(唯一の話者候補として残る場合を除く)
    const isImmediatelyPreviousSpeaker = clusterState.recentSpeakerIds[clusterState.recentSpeakerIds.length - 1] === member.id;

    const weight =
      0.35 * topicInterestAvg +
      0.2 * retellingTendency +
      0.2 * memoryStrengthAvg +
      0.15 * fairnessBoost +
      // initiativeは会話開始行動のtrait(既存意味)であり、内容発話へは小さな明示係数だけで使う
      0.1 * member.initiative -
      (isImmediatelyPreviousSpeaker ? 0.3 : 0);

    candidates.push({ item: member, weight: Math.max(0, weight) });
  }
  return candidates;
}

type TopicCandidate = { topic: TopicDefinition; claims: AgentClaimState[] };

function buildTopicCandidates(
  speakerId: string,
  members: readonly Agent[],
  clusterState: ClusterTopicState,
  hasNewMember: boolean,
  ctx: ContentUtteranceGenerationContext,
): WeightedCandidate<TopicCandidate>[] {
  const claims = eligibleClaimStates(speakerId, ctx.informationRuntime, clusterState, ctx.config.claimRepeatCooldownTicks, ctx.tick);
  const claimsByTopic = new Map<string, AgentClaimState[]>();
  for (const claimState of claims) {
    const claim = ctx.claimCatalog.claims.find((c) => c.id === claimState.claimId);
    if (!claim) continue;
    const list = claimsByTopic.get(claim.topicId) ?? [];
    list.push(claimState);
    claimsByTopic.set(claim.topicId, list);
  }

  const ticksSinceTopicStarted =
    clusterState.topicStartedTick === undefined ? Infinity : ctx.tick - clusterState.topicStartedTick;
  // 最低維持tickをまだ満たしておらず、かつ新規memberによるrefreshでもない間は、speakerが
  // 現在topicの話者資格を持つ限り現在topicへ固定する(頻繁な話題切替を避ける、§4)。
  const lockToCurrentTopic =
    !hasNewMember &&
    clusterState.currentTopicId !== undefined &&
    ticksSinceTopicStarted < ctx.config.minTopicDurationTicks &&
    claimsByTopic.has(clusterState.currentTopicId);

  const topicIds = lockToCurrentTopic
    ? [clusterState.currentTopicId as string]
    : Array.from(claimsByTopic.keys()).sort();

  const candidates: WeightedCandidate<TopicCandidate>[] = [];
  for (const topicId of topicIds) {
    const topic = ctx.topicCatalog.topics.find((t) => t.id === topicId);
    const topicClaims = claimsByTopic.get(topicId);
    if (!topic || !topicClaims || topicClaims.length === 0) continue;

    const memberInterestAvg =
      members.reduce((sum, member) => {
        const interest = ctx.informationRuntime[member.id]?.topics[topicId]?.interest ?? 0;
        return sum + interest;
      }, 0) / members.length;
    const fatigue = computeClusterTopicFatigue(clusterState, topicId, ctx.config.fatigueGain, ctx.config.fatigueDecay);
    const isCurrentTopic = topicId === clusterState.currentTopicId;
    const persistenceBonus = isCurrentTopic ? ctx.config.topicPersistence * (hasNewMember ? 0.3 : 1) : 0;
    const isRelatedToCurrent =
      clusterState.currentTopicId !== undefined &&
      ctx.topicCatalog.topics
        .find((t) => t.id === clusterState.currentTopicId)
        ?.relatedTopicIds.includes(topicId) === true;

    const weight =
      0.3 * topic.baseSalience +
      0.4 * memberInterestAvg +
      0.5 * persistenceBonus +
      (isRelatedToCurrent ? 0.15 : 0) -
      0.6 * fatigue;

    candidates.push({ item: { topic, claims: topicClaims }, weight: Math.max(0, weight) });
  }
  return candidates;
}

function determineReason(claimState: AgentClaimState): ContentUtteranceReason {
  const isOriginalHolder = claimState.sourceTraces.length > 0 && claimState.sourceTraces.every((trace) => trace.kind === "initialGrant");
  return isOriginalHolder ? "originalShare" : "knownClaimShare";
}

function pickClaim(topicCandidate: TopicCandidate, rng: SeededRandom): AgentClaimState {
  const sorted = [...topicCandidate.claims].sort((a, b) => (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0));
  const candidates: WeightedCandidate<AgentClaimState>[] = sorted.map((claimState) => {
    const neverTold = claimState.lastRetoldTick === undefined;
    const weight = 0.4 * claimState.confidence + 0.4 * claimState.memoryStrength + (neverTold ? 0.2 : 0);
    return { item: claimState, weight: Math.max(0, weight) };
  });
  return weightedPick(candidates, rng);
}

function resolveClaimDefinition(claimCatalog: ClaimCatalog, claimId: string): InformationClaim | undefined {
  return claimCatalog.claims.find((c) => c.id === claimId);
}

function topicTransition(previous: string | undefined, next: string, wasEverSet: boolean): "started" | "changed" | "continued" {
  if (!wasEverSet) return "started";
  return previous === next ? "continued" : "changed";
}

/**
 * confirmed clusterごとの発話機会を評価し、`ContentUtteranceEvent` + carrier `SpeechEvent`を生成する。
 * §5のtick順序どおり、既存Phase 1〜4処理と社会的`SpeechEvent`生成が終わった後段でだけ呼ぶこと。
 * `ctx.informationRuntime`/`ctx.agents`/`ctx.groupCandidates`はこのtickの既存処理が確定させた
 * live snapshotをそのまま渡す(このtick内で再評価しない)。
 */
export function deriveContentUtterances(ctx: ContentUtteranceGenerationContext): ContentUtteranceGenerationResult {
  const utterances: ContentUtteranceEvent[] = [];
  const speechEvents: SpeechEvent[] = [];
  const events: InterventionEvent[] = [];
  const generatedVariants: ClaimVariant[] = [];
  const retellingEvents: RetellingEvent[] = [];
  let runtime = ctx.clusterTopicRuntime;
  // Issue #232: 話者自身の`retellingCount`/`lastRetoldTick`更新だけを反映する(受信者側のadoption/memoryは不可侵)
  let nextInformationRuntime = ctx.informationRuntime;
  // 同一tick内で先に生成したvariantを後続turnのdedup判定でも見えるようにする(§6.3、重複ID防止)
  let effectiveCatalog = ctx.claimCatalog;
  let nextRetellingRuntime = ctx.retellingRuntime;

  const confirmedClusters = sortById(ctx.groupCandidates.filter((c) => c.status === "confirmed"));
  const activeClusterIds = new Set(confirmedClusters.map((c) => c.id));
  runtime = pruneClusterTopicRuntimeState(runtime, activeClusterIds);

  for (const cluster of confirmedClusters) {
    const members = confirmedClusterMembers(cluster, ctx.agents);
    let clusterState = runtime[cluster.id] ?? createInitialClusterTopicState(cluster.id);

    const membershipSync = syncClusterMembership(clusterState, members.map((m) => m.id));
    clusterState = membershipSync.state;

    if (members.length < 2) {
      runtime = { ...runtime, [cluster.id]: clusterState };
      continue;
    }

    const ticksSinceLast = clusterState.lastUtteranceTick === undefined ? Number.POSITIVE_INFINITY : ctx.tick - clusterState.lastUtteranceTick;
    if (ticksSinceLast < ctx.config.utteranceIntervalTicks) {
      runtime = { ...runtime, [cluster.id]: clusterState };
      continue;
    }

    const opportunityRng = deriveContentRandom(ctx.runSeed, "utterance-opportunity", ctx.tick, cluster.id);
    if (!opportunityRng.chance(ctx.config.utteranceProbability)) {
      runtime = { ...runtime, [cluster.id]: clusterState };
      continue;
    }

    const usedAgentIds = new Set<string>();
    // `maxUtterancesPerAgentPerTick === 0`はこのtickの発話自体を無効化する(§8.1、0..1の下限)
    const maxTurns = ctx.config.maxUtterancesPerAgentPerTick === 0 ? 0 : ctx.config.maxUtterancesPerClusterPerTick;
    for (let turnIndex = 0; turnIndex < maxTurns; turnIndex++) {
      const hasNewMember = membershipSync.hasNewMember && turnIndex === 0;
      const speakerCandidates = buildSpeakerCandidates(members, usedAgentIds, clusterState, ctx);
      if (speakerCandidates.length === 0) {
        const skip = recordSkip(clusterState, "noEligibleSpeaker");
        clusterState = skip.state;
        if (skip.shouldLog) {
          events.push({
            message: `会話クラスタ${cluster.id}で発話できる話者がいない`,
            tags: ["contentUtterance"],
            eventType: "contentUtteranceSkipped",
            metadata: { clusterId: cluster.id, contentUtteranceSkipReason: "noEligibleSpeaker" },
          });
        }
        break;
      }

      // `maxUtterancesPerAgentPerTick`は現状[0, 1]の範囲しか取らないため(§8.1)、`usedAgentIds`で
      // 既に選ばれたspeakerを候補から除外する(buildSpeakerCandidates)だけで自然に満たされる。
      const speakerRng = deriveContentRandom(ctx.runSeed, "speaker-selection", ctx.tick, cluster.id, turnIndex);
      const speaker = weightedPick(speakerCandidates, speakerRng);
      usedAgentIds.add(speaker.id);

      const topicCandidates = buildTopicCandidates(speaker.id, members, clusterState, hasNewMember, ctx);
      if (topicCandidates.length === 0) {
        const skip = recordSkip(clusterState, "noEligibleClaim");
        clusterState = skip.state;
        if (skip.shouldLog) {
          events.push({
            message: `会話クラスタ${cluster.id}で話せるtopic/claimを持つ話者がいない`,
            tags: ["contentUtterance"],
            eventType: "contentUtteranceSkipped",
            metadata: { clusterId: cluster.id, contentUtteranceSkipReason: "noEligibleClaim" },
          });
        }
        break;
      }

      const topicRng = deriveContentRandom(ctx.runSeed, "content-selection", ctx.tick, cluster.id, speaker.id, "topic");
      const topicCandidate = weightedPick(topicCandidates, topicRng);

      const claimRng = deriveContentRandom(ctx.runSeed, "content-selection", ctx.tick, cluster.id, speaker.id, "claim");
      const claimState = pickClaim(topicCandidate, claimRng);
      const claimDefinition = resolveClaimDefinition(ctx.claimCatalog, claimState.claimId);
      if (!claimDefinition) {
        // catalogとruntime stateが同期していない防御的なケース(通常発生しない)。このturnは諦める
        break;
      }

      const parentVariantId = claimState.activeVariantId ?? claimDefinition.rootVariantId;
      let reason = determineReason(claimState);

      // Issue #232 (ADR §5 step5): 既に受信/記憶を経た既知claimを話す手番だけがretelling対象。
      // 自分が最初に持っていた情報を初めて話す(originalShare)場合はretellingではない(§4.4)。
      let variantId = parentVariantId;
      // contentUtteranceIdはSpeechEvent/ContentUtteranceEventのIDが決まってから埋める(下でpatchする)
      let pendingRetellingEvent: RetellingEvent | undefined;
      if (reason === "knownClaimShare") {
        const parentVariant = effectiveCatalog.variants.find((v) => v.id === parentVariantId);
        if (parentVariant) {
          const outcome = deriveRetellingOutcome({
            tick: ctx.tick,
            clusterId: cluster.id,
            speakerId: speaker.id,
            claim: claimDefinition,
            parentVariant,
            claimState,
            profile: nextInformationRuntime[speaker.id]?.profile ?? { retellingTendency: 0, memoryRetention: 0, baselineTopicInterest: {} },
            clusterCurrentTopicId: clusterState.currentTopicId,
            catalog: effectiveCatalog,
            limits: ctx.limits,
            config: ctx.retellingConfig,
            retellingRuntime: nextRetellingRuntime,
            runSeed: ctx.runSeed,
          });

          if (outcome.suppressed) {
            // ADR §4.4: blockedByLimitはContentUtteranceを生成しない。この手番は発話なしで終える。
            retellingEvents.push(outcome.event);
            continue;
          }

          variantId = outcome.variantId;
          if (outcome.generatedVariant) {
            generatedVariants.push(outcome.generatedVariant);
            effectiveCatalog = mergeGeneratedVariants(effectiveCatalog, [outcome.generatedVariant]);
          }
          // 実際に語られたvariantがparentと異なる(mutated/variantReused)場合だけ"retelling"として分類する
          if (variantId !== parentVariantId) reason = "retelling";

          nextInformationRuntime = withAgentClaimState(nextInformationRuntime, speaker.id, {
            ...claimState,
            retellingCount: claimState.retellingCount + 1,
            lastRetoldTick: ctx.tick,
          });

          pendingRetellingEvent = outcome.event;
        }
      }

      const transition = topicTransition(clusterState.currentTopicId, topicCandidate.topic.id, clusterState.topicStartedTick !== undefined);

      const speechEvent = createSpeechEvent({
        tick: ctx.tick,
        speakerId: speaker.id,
        intent: "shareInformation",
        reason: "contentTurn",
        audience: "nearby",
        idSuffix: `${cluster.id}-${turnIndex}`,
        originX: speaker.x,
        originY: speaker.y,
        range: ctx.config.clusterAudienceRange,
        strength: ctx.config.clusterAudienceStrength,
      });
      speechEvents.push(speechEvent);

      const utterance: ContentUtteranceEvent = {
        id: `content-${speechEvent.id}`,
        tick: ctx.tick,
        speechEventId: speechEvent.id,
        speakerId: speaker.id,
        clusterId: cluster.id,
        topicId: topicCandidate.topic.id,
        claimId: claimState.claimId,
        variantId,
        audience: "cluster",
        reason,
        sourceTraceIds: claimState.sourceTraces.map((trace) => trace.id),
      };
      utterances.push(utterance);

      if (pendingRetellingEvent) {
        retellingEvents.push({ ...pendingRetellingEvent, contentUtteranceId: utterance.id });
      }

      nextRetellingRuntime = withClusterVariantTellIncrement(nextRetellingRuntime, cluster.id, variantId);

      clusterState = recordUtterance(clusterState, {
        topicId: topicCandidate.topic.id,
        speakerId: speaker.id,
        claimId: claimState.claimId,
        tick: ctx.tick,
      });

      events.push({
        message: `${speaker.label ?? speaker.id}が会話クラスタ${cluster.id}で話題「${topicCandidate.topic.id}」について話した`,
        tags: ["contentUtterance"],
        eventType: "contentUtteranceGenerated",
        metadata: {
          clusterId: cluster.id,
          agentId: speaker.id,
          agentLabel: speaker.label,
          topicId: topicCandidate.topic.id,
          claimId: claimState.claimId,
          variantId,
          contentUtteranceReason: reason,
          topicTransition: transition,
        },
      });
    }

    runtime = { ...runtime, [cluster.id]: clusterState };
  }

  return {
    utterances,
    speechEvents,
    clusterTopicRuntime: runtime,
    events,
    informationRuntime: nextInformationRuntime,
    generatedVariants,
    retellingEvents,
    retellingRuntime: nextRetellingRuntime,
  };
}
