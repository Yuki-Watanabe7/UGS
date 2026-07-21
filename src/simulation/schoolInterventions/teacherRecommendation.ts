import type { Agent, GroupCandidate } from "../types";
import { clamp, distance } from "../model";
import { createInterventionRandom, stableSortById } from "../schoolInterventionRuntime";
import type {
  InterventionEffect,
  InterventionEvent,
  InterventionRuntimeState,
  SchoolIntervention,
  SchoolInterventionContext,
  SchoolInterventionHookOutput,
} from "../schoolInterventionRuntime";
import { candidateHasVacancy } from "./openGroupSignal";

/**
 * Issue #158: 「教師による候補推薦」介入(`teacher-recommendation`)。
 *
 * 匿名通知済み、または一定時間未決定のagentへ、教師が空きのある班(forming/可変定員confirmed)、
 * または他の未決定agentとの新規組み合わせを推薦する。推薦は「候補選択(純粋関数、rng不使用)」
 * →「提示(teacherRecommendationIssued)」→「受諾/拒否(介入専用rngのみ判定、本体rngは不使用)」→
 * 「(受諾時のみ)一時的な後押し効果」という段階を構造化イベントとして分けて記録する。
 * 直接`joined`へ変更することはせず、承諾しても既存の接近(approaching)判定・容量チェックを
 * そのまま経由させる(#156の契約どおりeffectsのみで表現し、`assignToGroup`アクションは使わない)。
 */

// --- 対象agentの選定 --------------------------------------------------------------------------

/** この介入が動き始める下限tick数(曖昧フェーズが始まってすぐの推薦を避ける) */
export const TEACHER_RECOMMENDATION_MIN_TICK = 12;
/** 匿名通知(anonymousHelpRequested)を経ていなくても、単独で対象になり得る長時間未決定の下限tick数 */
export const TEACHER_RECOMMENDATION_LONG_WAIT_TICK = 40;
/** 拒否/推薦不能の後、同一agentへ再度推薦を試みるまでのクールダウンtick数 */
export const TEACHER_RECOMMENDATION_COOLDOWN_TICKS = 30;
/** 受諾直後、直近で参加失敗した候補への再推薦を避けるクールダウンtick数(既存の再接近クールダウンと同じ考え方) */
const RECENT_FAILURE_COOLDOWN_TICKS = 8;

function recommendationCooldownKey(agentId: string): string {
  return `teacher-recommendation:${agentId}`;
}

function isAgentEligibleForRecommendation(agent: Agent, ctx: SchoolInterventionContext): boolean {
  if (agent.state !== "undecided") return false;
  if (ctx.tick < TEACHER_RECOMMENDATION_MIN_TICK) return false;

  // 既に有効な推薦効果を持つ間は重複推薦しない
  const expiry = ctx.runtimeState.temporaryEffectExpiryByAgentId[agent.id];
  if (expiry !== undefined && ctx.tick < expiry) return false;

  const lastTick = ctx.runtimeState.lastTriggeredAtTick[recommendationCooldownKey(agent.id)];
  if (lastTick !== undefined && ctx.tick - lastTick < TEACHER_RECOMMENDATION_COOLDOWN_TICKS) return false;

  const anonymouslyNotified = ctx.runtimeState.anonymouslyNotifiedAgentIds.includes(agent.id);
  return anonymouslyNotified || ctx.tick >= TEACHER_RECOMMENDATION_LONG_WAIT_TICK;
}

// --- 候補選択(純粋関数、rng不使用) -------------------------------------------------------------

export type RecommendationGroupOption = {
  kind: "group";
  candidate: GroupCandidate;
  remainingCapacity: number;
  distance: number;
  sameClique: boolean;
};

export type RecommendationPeerOption = {
  kind: "peer";
  peer: Agent;
  distance: number;
  sameClique: boolean;
};

export type RecommendationTarget = RecommendationGroupOption | RecommendationPeerOption;

function targetId(target: RecommendationTarget): string {
  return target.kind === "group" ? target.candidate.id : target.peer.id;
}

function isRecentJoinFailure(agent: Agent, candidateId: string, tick: number): boolean {
  return (
    agent.lastFailedCandidateId === candidateId &&
    agent.lastFailedCandidateAtTick !== undefined &&
    tick - agent.lastFailedCandidateAtTick < RECENT_FAILURE_COOLDOWN_TICKS
  );
}

function agentById(agents: readonly Agent[], id: string): Agent | undefined {
  return agents.find((a) => a.id === id);
}

function groupHasSameClique(agent: Agent, candidate: GroupCandidate, agents: readonly Agent[]): boolean {
  if (agent.cliqueId === undefined) return false;
  return candidate.memberIds.some((memberId) => agentById(agents, memberId)?.cliqueId === agent.cliqueId);
}

/**
 * `agent`への推薦候補の選択肢一式を組み立てる(rng不使用)。容量違反を起こし得る候補
 * (満員/dissolving/dissolved/expired)、直近で参加失敗した候補、このtickで既に他agentへ
 * 予約済みの班/peerは、この時点で選択肢から除外する。
 */
export function buildRecommendationOptions(
  agent: Agent,
  ctx: SchoolInterventionContext,
  reservedGroupIds: ReadonlySet<string>,
  reservedPeerIds: ReadonlySet<string>,
): RecommendationTarget[] {
  const options: RecommendationTarget[] = [];

  for (const candidate of ctx.groupCandidates) {
    if (reservedGroupIds.has(candidate.id)) continue;
    if (!candidateHasVacancy(candidate, ctx)) continue;
    if (isRecentJoinFailure(agent, candidate.id, ctx.tick)) continue;
    const capacity = ctx.formationPolicy.resolveGroupCapacity(candidate, ctx.params);
    const remainingCapacity = Number.isFinite(capacity.maxGroupSize)
      ? capacity.maxGroupSize - candidate.memberIds.length
      : Number.POSITIVE_INFINITY;
    options.push({
      kind: "group",
      candidate,
      remainingCapacity,
      distance: distance(agent.x, agent.y, candidate.x, candidate.y),
      sameClique: groupHasSameClique(agent, candidate, ctx.agents),
    });
  }

  for (const peer of ctx.agents) {
    if (peer.id === agent.id) continue;
    if (peer.state !== "undecided") continue;
    if (reservedPeerIds.has(peer.id)) continue;
    options.push({
      kind: "peer",
      peer,
      distance: distance(agent.x, agent.y, peer.x, peer.y),
      sameClique: peer.cliqueId !== undefined && peer.cliqueId === agent.cliqueId,
    });
  }

  return options;
}

/**
 * 純粋関数: 容量違反回避を最優先(=無効な選択肢は`buildRecommendationOptions`が事前に除外済み)とし、
 * 残った選択肢を距離昇順 -> 既存clique関係優先 -> 安定ID順で決定的に1件選ぶ
 * (受入条件: 同一seed・同一状態で同じ候補を推薦する)。優先順位を将来差し替えられるよう、
 * この選択ロジックだけをここへ分離している。
 */
export function selectRecommendationTarget(
  options: readonly RecommendationTarget[],
): RecommendationTarget | undefined {
  if (options.length === 0) return undefined;
  const sorted = [...options].sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    if (a.sameClique !== b.sameClique) return a.sameClique ? -1 : 1;
    const idA = targetId(a);
    const idB = targetId(b);
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  });
  return sorted[0];
}

// --- 受諾確率 ----------------------------------------------------------------------------------

/** 受諾確率の距離要素を正規化するための目安半径(この距離を超えるとほぼ0まで下がる) */
export const TEACHER_RECOMMENDATION_DISTANCE_NORM = 220;

/**
 * 純粋関数: willingness・influenceAvoidance・推薦先との距離・既存clique関係・現在のstressから
 * 受諾確率([0,1])を導出する。rngは一切使わない(判定自体は呼び出し側が介入専用rngで行う)。
 */
export function computeRecommendationAcceptanceProbability(agent: Agent, target: RecommendationTarget): number {
  const proximityFactor = clamp(1 - target.distance / TEACHER_RECOMMENDATION_DISTANCE_NORM, 0, 1);
  const stressRatio = agent.leaveThreshold > 0 ? clamp(agent.stress / agent.leaveThreshold, 0, 1) : 0;
  const willingnessFactor = agent.willingness * (1 - agent.influenceAvoidance * 0.6);
  const tieBonus = target.sameClique ? 0.15 : 0;
  return clamp(willingnessFactor * 0.55 + proximityFactor * 0.25 + stressRatio * 0.2 + tieBonus, 0, 1);
}

// --- 一時効果 ----------------------------------------------------------------------------------

/** 受諾後、一時的な後押し効果が続くtick数 */
export const TEACHER_RECOMMENDATION_BOOST_WINDOW = 25;
/** 受諾後、接近確率へ加える一時的な加算値 */
export const TEACHER_RECOMMENDATION_APPROACH_BOOST = 0.22;
/** 受諾後、推薦先へのattractivenessへ加える一時的な加算値 */
export const TEACHER_RECOMMENDATION_ATTRACTIVENESS_BOOST = 0.18;

function buildAcceptedEffects(agentId: string, tick: number, targetGroupId?: string): InterventionEffect[] {
  const expiresAtTick = tick + TEACHER_RECOMMENDATION_BOOST_WINDOW;
  return [
    {
      dimension: "approachProbability",
      agentId,
      value: TEACHER_RECOMMENDATION_APPROACH_BOOST,
      startedAtTick: tick,
      expiresAtTick,
    },
    {
      dimension: "attractiveness",
      agentId,
      targetGroupId,
      value: TEACHER_RECOMMENDATION_ATTRACTIVENESS_BOOST,
      startedAtTick: tick,
      expiresAtTick,
    },
  ];
}

// --- onBeforeApproachDecision: 推薦の発行・受諾/拒否判定 ----------------------------------------

function onBeforeApproachDecision(ctx: SchoolInterventionContext): SchoolInterventionHookOutput {
  // この介入はclassroomPair系(学校シナリオ)専用。afterPartyへ誤って適用されても既存挙動を
  // 変えないよう明示的にno-opにする(受入条件: 介入なしと二次会シナリオの既存挙動が変化しない)。
  if (ctx.formationPolicy.id !== "classroomPair") return {};

  const eligibleAgents = stableSortById(ctx.agents.filter((agent) => isAgentEligibleForRecommendation(agent, ctx)));
  if (eligibleAgents.length === 0) return {};

  const reservedGroupIds = new Set(Object.values(ctx.runtimeState.recommendedGroupIdByAgentId));
  const reservedPeerIds = new Set(Object.values(ctx.runtimeState.recommendedPeerIdByAgentId));

  const events: InterventionEvent[] = [];
  const effects: InterventionEffect[] = [];
  let runtimeState: InterventionRuntimeState = ctx.runtimeState;

  for (const agent of eligibleAgents) {
    const options = buildRecommendationOptions(agent, ctx, reservedGroupIds, reservedPeerIds);
    const target = selectRecommendationTarget(options);
    const lastTriggeredAtTick = { ...runtimeState.lastTriggeredAtTick, [recommendationCooldownKey(agent.id)]: ctx.tick };

    if (!target) {
      events.push({
        message: `教師が${agent.label}さんへ推薦できる班・相手を見つけられなかった`,
        tags: ["intervention"],
        eventType: "teacherRecommendationUnavailable",
        metadata: {
          schoolInterventionId: "teacher-recommendation",
          agentId: agent.id,
          isTeacherSource: true,
          triggerReason: "noEligibleTarget",
          outcome: "unavailable",
        },
      });
      runtimeState = { ...runtimeState, lastTriggeredAtTick };
      continue;
    }

    const isGroup = target.kind === "group";
    const groupId = target.kind === "group" ? target.candidate.id : undefined;
    const peerId = target.kind === "peer" ? target.peer.id : undefined;
    if (groupId) reservedGroupIds.add(groupId);
    if (peerId) reservedPeerIds.add(peerId);

    const sharedMetadata = {
      schoolInterventionId: "teacher-recommendation" as const,
      agentId: agent.id,
      groupId,
      secondAgentId: peerId,
      secondAgentLabel: target.kind === "peer" ? target.peer.label : undefined,
      isTeacherSource: true,
      recommendationTargetKind: target.kind,
      recommendationDistance: target.distance,
      recommendationSameClique: target.sameClique,
      ...(target.kind === "group" && Number.isFinite(target.remainingCapacity)
        ? { remainingCapacity: target.remainingCapacity }
        : {}),
    };

    events.push({
      message: isGroup
        ? `教師が${agent.label}さんへ空きのある班を推薦した`
        : `教師が${agent.label}さんへ${(target as RecommendationPeerOption).peer.label}さんとの組み合わせを推薦した`,
      tags: ["intervention"],
      eventType: "teacherRecommendationIssued",
      metadata: { ...sharedMetadata, triggerReason: "recommendationIssued", outcome: "presented" },
    });

    const acceptanceProbability = computeRecommendationAcceptanceProbability(agent, target);
    const rng = createInterventionRandom(ctx.runSeed, "teacher-recommendation", ctx.tick, agent.id);
    const accepted = rng.chance(acceptanceProbability);

    const recommendedGroupIdByAgentId = { ...runtimeState.recommendedGroupIdByAgentId };
    const recommendedPeerIdByAgentId = { ...runtimeState.recommendedPeerIdByAgentId };
    const recommendationIssuedAtTick = { ...runtimeState.recommendationIssuedAtTick };
    let temporaryEffectExpiryByAgentId = runtimeState.temporaryEffectExpiryByAgentId;

    if (accepted) {
      effects.push(...buildAcceptedEffects(agent.id, ctx.tick, groupId));
      if (target.kind === "peer") {
        effects.push(...buildAcceptedEffects(target.peer.id, ctx.tick, undefined));
      }
      events.push({
        message: isGroup
          ? `${agent.label}さんが推薦を受け入れ、その班へ向かい始めた`
          : `${agent.label}さんが推薦を受け入れ、${(target as RecommendationPeerOption).peer.label}さんへ近づき始めた`,
        tags: ["intervention"],
        eventType: "teacherRecommendationAccepted",
        metadata: {
          ...sharedMetadata,
          triggerReason: "recommendationAccepted",
          recommendationAcceptanceProbability: acceptanceProbability,
          effectStartedAtTick: ctx.tick,
          effectExpiresAtTick: ctx.tick + TEACHER_RECOMMENDATION_BOOST_WINDOW,
          outcome: "accepted",
        },
      });
      if (groupId) {
        recommendedGroupIdByAgentId[agent.id] = groupId;
        recommendationIssuedAtTick[agent.id] = ctx.tick;
      }
      if (peerId) recommendedPeerIdByAgentId[agent.id] = peerId;
      temporaryEffectExpiryByAgentId = {
        ...temporaryEffectExpiryByAgentId,
        [agent.id]: ctx.tick + TEACHER_RECOMMENDATION_BOOST_WINDOW,
      };
    } else {
      events.push({
        message: isGroup
          ? `${agent.label}さんは推薦された班への参加を見送った`
          : `${agent.label}さんは推薦された組み合わせを見送った`,
        tags: ["intervention"],
        eventType: "teacherRecommendationDeclined",
        metadata: {
          ...sharedMetadata,
          triggerReason: "recommendationDeclined",
          recommendationAcceptanceProbability: acceptanceProbability,
          outcome: "declined",
        },
      });
    }

    runtimeState = {
      ...runtimeState,
      lastTriggeredAtTick,
      recommendedGroupIdByAgentId,
      recommendedPeerIdByAgentId,
      recommendationIssuedAtTick,
      temporaryEffectExpiryByAgentId,
    };
  }

  return { events, effects, runtimeState };
}

// --- onAfterStateTransition: 受諾済み推薦の解決(参加成功/無効化)の追跡 ---------------------------

function onAfterStateTransition(ctx: SchoolInterventionContext): SchoolInterventionHookOutput {
  if (ctx.formationPolicy.id !== "classroomPair") return {};
  if (Object.keys(ctx.runtimeState.recommendedGroupIdByAgentId).length === 0) return {};

  const events: InterventionEvent[] = [];
  const recommendedGroupIdByAgentId = { ...ctx.runtimeState.recommendedGroupIdByAgentId };
  const recommendationIssuedAtTick = { ...ctx.runtimeState.recommendationIssuedAtTick };
  let changed = false;

  for (const [agentId, groupId] of Object.entries(ctx.runtimeState.recommendedGroupIdByAgentId)) {
    const agent = agentById(ctx.agents, agentId);
    const issuedAtTick = recommendationIssuedAtTick[agentId];

    if (!agent) {
      delete recommendedGroupIdByAgentId[agentId];
      delete recommendationIssuedAtTick[agentId];
      changed = true;
      continue;
    }

    if (agent.state === "joined" && agent.joinedGroupId === groupId) {
      events.push({
        message: `${agent.label}さんが推薦された班へ参加した`,
        tags: ["intervention"],
        eventType: "schoolInterventionTriggered",
        metadata: {
          schoolInterventionId: "teacher-recommendation",
          agentId,
          groupId,
          isTeacherSource: true,
          triggerReason: "recommendationFulfilled",
          effectStartedAtTick: issuedAtTick,
          ticksSinceRecommendation: issuedAtTick !== undefined ? ctx.tick - issuedAtTick : undefined,
          outcome: "assigned",
        },
      });
      delete recommendedGroupIdByAgentId[agentId];
      delete recommendationIssuedAtTick[agentId];
      changed = true;
      continue;
    }

    if (agent.state !== "undecided" && agent.state !== "approaching") {
      // 推薦先とは無関係にleave/unassigned等で決着した場合は、静かに追跡を終了する
      delete recommendedGroupIdByAgentId[agentId];
      delete recommendationIssuedAtTick[agentId];
      changed = true;
      continue;
    }

    const candidate = ctx.groupCandidates.find((c) => c.id === groupId);
    const stillValid = candidate !== undefined && candidateHasVacancy(candidate, ctx);
    if (stillValid) continue;

    events.push({
      message: `${agent.label}さんへ推薦された班が利用できなくなった`,
      tags: ["intervention"],
      eventType: "teacherRecommendationTargetInvalidated",
      metadata: {
        schoolInterventionId: "teacher-recommendation",
        agentId,
        groupId,
        isTeacherSource: true,
        triggerReason: candidate ? "groupNoLongerAvailable" : "groupMissing",
        outcome: "unavailable",
      },
    });
    delete recommendedGroupIdByAgentId[agentId];
    delete recommendationIssuedAtTick[agentId];
    changed = true;
  }

  // peer推薦は「相手が決まった/離脱した」ことそのものが自然な決着のため、無効化イベントは出さず
  // 追跡のみを静かに終了する(受入条件の対象は班推薦の満員化・消滅・期限切れ)
  const recommendedPeerIdByAgentId = { ...ctx.runtimeState.recommendedPeerIdByAgentId };
  for (const [agentId, peerId] of Object.entries(ctx.runtimeState.recommendedPeerIdByAgentId)) {
    const agent = agentById(ctx.agents, agentId);
    const peer = agentById(ctx.agents, peerId);
    if (!agent || !peer || agent.state !== "undecided" || peer.state !== "undecided") {
      delete recommendedPeerIdByAgentId[agentId];
      changed = true;
    }
  }

  if (!changed) return {};
  return {
    events,
    runtimeState: {
      ...ctx.runtimeState,
      recommendedGroupIdByAgentId,
      recommendedPeerIdByAgentId,
      recommendationIssuedAtTick,
    },
  };
}

export const teacherRecommendationIntervention: SchoolIntervention = {
  id: "teacher-recommendation",
  onBeforeApproachDecision,
  onAfterStateTransition,
};
