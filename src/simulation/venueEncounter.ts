/**
 * Issue #265 (Phase 7, standingParty): 飲食ステーション付近の偶発的接近。
 *
 * `docs/standing-party-phase7-venue-anchors.md` §7.5・§13。
 * 近接だけでは contact も内容発話も作らない。receiving / consuming のあいだは
 * 会話clusterへ移さない。訪問完了後の窓でだけ、既存の GroupCandidate 作成か接近を返す。
 * rngは消費しない。`isObserverJoiner` では分岐しない。
 */
import { clamp, WORLD_HEIGHT, WORLD_WIDTH } from "./model";
import type { Agent, GroupCandidate, SimulationEventMetadata, SimulationEventType } from "./types";
import type {
  VenueAnchor,
  VenueEncounterPhase,
  VenueEncounterReason,
  VenueEncounterWindow,
} from "./venueAnchors";

/** 契約 §7.5。agent id から決まる滞在位置のずれの半径 */
export const VENUE_STAY_OFFSET_RADIUS = 18;
/** このscore未満は、近くにいても会話形成へ進まない */
export const VENUE_ENCOUNTER_SCORE_THRESHOLD = 0.45;
/** cluster中心を台の円から押し出す1tickの上限。物理衝突ではない */
export const VENUE_ANCHOR_CLUSTER_NUDGE_STEP = 4;

const PROXIMITY_WEIGHT = 0.25;
const OPENNESS_WEIGHT = 0.4;
const INITIATIVE_WEIGHT = 0.25;
const TOPIC_MATCH_BONUS = 0.08;
const TOPIC_MISMATCH_PENALTY = 0.04;
const CLUSTER_CENTER_MARGIN = 20;
const AGENT_WORLD_MARGIN = 5;

const ABSENT_STATES: ReadonlySet<Agent["state"]> = new Set(["leaving", "left", "unassigned"]);

export type VenueEncounterAgentView = {
  id: string;
  label: string;
  x: number;
  y: number;
  state: Agent["state"];
  initiative: number;
  willingness: number;
  conformity: number;
  influenceAvoidance: number;
  /**
   * 評価式は読まない。同じ他の特性なら observerJoiner でも score は変わらない、
   * ことを呼び出し側のテストが比較できるように載せるだけ。
   */
  isObserverJoiner: boolean;
  cliqueId?: number;
  pendingSocialTransition: boolean;
  topicId?: string;
  blockedCandidateIds: readonly string[];
};

export type VenueEncounterPresence =
  | { kind: "service"; anchorId: string; obtained: boolean }
  | { kind: "postVisit"; anchorId: string; completedAtTick: number }
  | { kind: "none" };

export type EncounterOpportunity = {
  observed: boolean;
  eligible: boolean;
  score: number;
  reason?: VenueEncounterReason;
  phase?: VenueEncounterPhase;
  anchorId?: string;
  initiatorId?: string;
  counterpartId?: string;
};

export type VenueEncounterCandidateView = {
  id: string;
  x: number;
  y: number;
  status: GroupCandidate["status"];
  joinable: boolean;
};

export type VenueEncounterAction =
  | {
      kind: "create";
      initiatorId: string;
      joinerId: string;
      anchorId: string;
      center: { x: number; y: number };
      score: number;
    }
  | {
      kind: "approach";
      candidateId: string;
      initiatorId: string;
      joinerId: string;
      anchorId: string;
      score: number;
    };

export type VenueEncounterLogEvent = {
  eventType: Extract<SimulationEventType, "venueEncounterOpportunity" | "venueEncounterFormed">;
  message: string;
  metadata: SimulationEventMetadata;
};

function hashString(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function pairKey(anchorId: string, idA: string, idB: string, phase: string, reason: string): string {
  const lo = idA < idB ? idA : idB;
  const hi = idA < idB ? idB : idA;
  return `${anchorId}|${lo}|${hi}|${phase}|${reason}`;
}

/** 関心が最大のtopic。同点はid昇順。情報stateが無い、または関心0なら undefined */
export function primaryTopicId(
  topics: Readonly<Record<string, { interest: number }>> | undefined,
): string | undefined {
  if (!topics) return undefined;
  let bestId: string | undefined;
  let best = -1;
  for (const [id, topic] of Object.entries(topics)) {
    if (!Number.isFinite(topic.interest) || topic.interest <= 0) continue;
    if (bestId === undefined || topic.interest > best || (topic.interest === best && id < bestId)) {
      best = topic.interest;
      bestId = id;
    }
  }
  return bestId;
}

/**
 * agent id から決まる、半径 `radius` 以内の滞在オフセット。
 * 同じidは常に同じ位置。原点には置かない。
 */
export function venueStayOffset(agentId: string, radius = VENUE_STAY_OFFSET_RADIUS): { dx: number; dy: number } {
  const hash = hashString(`venue-stay:${agentId}`);
  const angle = ((hash % 3600) / 3600) * 2 * Math.PI;
  const radiusFrac = 0.55 + ((Math.floor(hash / 3600) % 1000) / 1000) * 0.45;
  const r = radius * radiusFrac;
  return { dx: Math.cos(angle) * r, dy: Math.sin(angle) * r };
}

/**
 * receiving / consuming のagentを、台の中心から半径18以内の決定的な位置へ置く。
 * 円の外には出さない。traveling や訪問が無いagentは動かさない。
 */
export function applyVenueStayPositions(
  agents: { id: string; x: number; y: number; vx: number; vy: number }[],
  visits: Readonly<Record<string, { phase: string; anchorId: string }>>,
  anchors: readonly { id: string; x: number; y: number; interactionRadius: number }[],
): void {
  const anchorsById = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  for (const agent of agents) {
    const visit = visits[agent.id];
    if (!visit || (visit.phase !== "receiving" && visit.phase !== "consuming")) continue;
    const anchor = anchorsById.get(visit.anchorId);
    if (!anchor) continue;
    const offset = venueStayOffset(agent.id);
    let x = anchor.x + offset.dx;
    let y = anchor.y + offset.dy;
    const limit = Math.min(VENUE_STAY_OFFSET_RADIUS, anchor.interactionRadius);
    const dist = Math.hypot(x - anchor.x, y - anchor.y);
    if (dist > limit && dist > 1e-9) {
      const scale = limit / dist;
      x = anchor.x + (x - anchor.x) * scale;
      y = anchor.y + (y - anchor.y) * scale;
    }
    agent.x = clamp(x, AGENT_WORLD_MARGIN, WORLD_WIDTH - AGENT_WORLD_MARGIN);
    agent.y = clamp(y, AGENT_WORLD_MARGIN, WORLD_HEIGHT - AGENT_WORLD_MARGIN);
    agent.vx = 0;
    agent.vy = 0;
  }
}

function clampClusterCenter(point: { x: number; y: number }): { x: number; y: number } {
  return {
    x: clamp(point.x, CLUSTER_CENTER_MARGIN, WORLD_WIDTH - CLUSTER_CENTER_MARGIN),
    y: clamp(point.y, CLUSTER_CENTER_MARGIN, WORLD_HEIGHT - CLUSTER_CENTER_MARGIN),
  };
}

function outwardUnit(anchor: { x: number; y: number }, dx: number, dy: number): { ux: number; uy: number } {
  const dist = Math.hypot(dx, dy);
  if (dist > 1e-6) return { ux: dx / dist, uy: dy / dist };
  const fx = WORLD_WIDTH / 2 - anchor.x;
  const fy = WORLD_HEIGHT / 2 - anchor.y;
  const fl = Math.hypot(fx, fy) || 1;
  return { ux: fx / fl, uy: fy / fl };
}

/**
 * 新しい会話の中心を、対象anchorの円の外へ置く。
 * メンバーの重心が円の中なら、その方向へ `interactionRadius + clusterClearance` まで押し出す。
 */
export function resolveEncounterClusterCenter(
  anchor: { x: number; y: number; interactionRadius: number },
  members: readonly { x: number; y: number }[],
  clusterClearance: number,
): { x: number; y: number } {
  const minDist = anchor.interactionRadius + clusterClearance;
  let sx = 0;
  let sy = 0;
  for (const member of members) {
    sx += member.x;
    sy += member.y;
  }
  const count = Math.max(1, members.length);
  const centroidX = sx / count;
  const centroidY = sy / count;
  const { ux, uy } = outwardUnit(anchor, centroidX - anchor.x, centroidY - anchor.y);
  const centroidDist = Math.hypot(centroidX - anchor.x, centroidY - anchor.y);
  const desired = Math.max(centroidDist, minDist);
  const place = (angle: number, distance: number) =>
    clampClusterCenter({
      x: anchor.x + Math.cos(angle) * distance,
      y: anchor.y + Math.sin(angle) * distance,
    });
  const base = Math.atan2(uy, ux);
  const first = place(base, desired);
  if (Math.hypot(first.x - anchor.x, first.y - anchor.y) + 1e-6 >= minDist) return first;
  for (let step = 1; step <= 24; step++) {
    const delta = (step * Math.PI) / 12;
    for (const angle of [base + delta, base - delta]) {
      const candidate = place(angle, minDist);
      if (Math.hypot(candidate.x - anchor.x, candidate.y - anchor.y) + 1e-6 >= minDist) return candidate;
    }
  }
  return first;
}

/** 台のクリアランス円に入っているcluster中心を、1tickぶん外へずらす。円の外なら動かさない */
export function nudgeClusterFromAnchors(
  cluster: { x: number; y: number },
  anchors: readonly { x: number; y: number; interactionRadius: number }[],
  clusterClearance: number,
  maxStep = VENUE_ANCHOR_CLUSTER_NUDGE_STEP,
): { x: number; y: number } {
  let chosen: { x: number; y: number; deficit: number } | undefined;
  for (const anchor of anchors) {
    const minDist = anchor.interactionRadius + clusterClearance;
    const dist = Math.hypot(cluster.x - anchor.x, cluster.y - anchor.y);
    const deficit = minDist - dist;
    if (deficit > 1e-6 && (!chosen || deficit > chosen.deficit)) {
      chosen = { x: anchor.x, y: anchor.y, deficit };
    }
  }
  if (!chosen) return { x: cluster.x, y: cluster.y };
  const { ux, uy } = outwardUnit(chosen, cluster.x - chosen.x, cluster.y - chosen.y);
  const step = Math.min(maxStep, chosen.deficit);
  return clampClusterCenter({ x: cluster.x + ux * step, y: cluster.y + uy * step });
}

function topicFactor(a: string | undefined, b: string | undefined): number {
  if (!a || !b) return 0;
  return a === b ? TOPIC_MATCH_BONUS : -TOPIC_MISMATCH_PENALTY;
}

function openness(agent: VenueEncounterAgentView): number {
  return clamp01(agent.willingness * (0.5 + 0.5 * agent.conformity) * (1 - agent.influenceAvoidance * 0.5));
}

function chooseInitiator(a: VenueEncounterAgentView, b: VenueEncounterAgentView): VenueEncounterAgentView {
  if (a.initiative > b.initiative) return a;
  if (b.initiative > a.initiative) return b;
  return a.id < b.id ? a : b;
}

function phaseOf(
  a: VenueEncounterPresence,
  b: VenueEncounterPresence,
  tick: number,
  windowTicks: number,
): { phase: VenueEncounterPhase; anchorId: string } | undefined {
  if (a.kind === "none" || b.kind === "none") return undefined;
  if (a.anchorId !== b.anchorId) return undefined;
  if (a.kind === "postVisit" && b.kind === "postVisit") {
    const ageA = tick - a.completedAtTick;
    const ageB = tick - b.completedAtTick;
    if (ageA < 0 || ageB < 0 || ageA > windowTicks || ageB > windowTicks) return undefined;
    return { phase: "postVisit", anchorId: a.anchorId };
  }
  const serviceA = a.kind === "service";
  const serviceB = b.kind === "service";
  if (!serviceA && !serviceB) return undefined;
  const obtainedA = a.kind === "postVisit" || (a.kind === "service" && a.obtained);
  const obtainedB = b.kind === "postVisit" || (b.kind === "service" && b.obtained);
  return {
    phase: obtainedA && obtainedB ? "afterObtain" : "beforeObtain",
    anchorId: a.anchorId,
  };
}

/**
 * 二人の機会。距離・phase・topic・関係・initiative・社会的な開きやすさからscoreを決める。
 * scoreが閾値未満、またはサービス中なら、会話形成の対象にしない。
 */
export function evaluateEncounterOpportunity(input: {
  a: VenueEncounterAgentView;
  b: VenueEncounterAgentView;
  presenceA: VenueEncounterPresence;
  presenceB: VenueEncounterPresence;
  tick: number;
  radius: number;
  windowTicks: number;
  existingTieStrength: number;
  tieCorrection?: number;
}): EncounterOpportunity {
  const { a, b } = input;
  if (ABSENT_STATES.has(a.state) || ABSENT_STATES.has(b.state)) {
    return { observed: false, eligible: false, score: 0 };
  }
  const phased = phaseOf(input.presenceA, input.presenceB, input.tick, input.windowTicks);
  if (!phased) return { observed: false, eligible: false, score: 0 };
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  if (input.radius <= 0 ? dist > 0 : dist > input.radius) {
    return { observed: false, eligible: false, score: 0 };
  }

  const proximity = input.radius <= 0 ? 1 : clamp01(1 - dist / input.radius);
  const initiator = chooseInitiator(a, b);
  const counterpart = initiator.id === a.id ? b : a;
  const sameClique = a.cliqueId !== undefined && a.cliqueId === b.cliqueId;
  const relationship = clamp((sameClique ? input.existingTieStrength * 0.5 : 0) + (input.tieCorrection ?? 0), -0.2, 0.7);
  const score = clamp01(
    PROXIMITY_WEIGHT * proximity +
      OPENNESS_WEIGHT * ((openness(a) + openness(b)) / 2) +
      INITIATIVE_WEIGHT * initiator.initiative +
      relationship +
      topicFactor(a.topicId, b.topicId),
  );
  const base = {
    observed: true,
    score,
    phase: phased.phase,
    anchorId: phased.anchorId,
    initiatorId: initiator.id,
    counterpartId: counterpart.id,
  };
  if (score < VENUE_ENCOUNTER_SCORE_THRESHOLD) {
    return { ...base, eligible: false, reason: "belowSocialThreshold" };
  }
  if (phased.phase !== "postVisit") {
    return { ...base, eligible: false, reason: "serviceInProgress" };
  }
  const ready =
    a.state === "undecided" &&
    b.state === "undecided" &&
    !a.pendingSocialTransition &&
    !b.pendingSocialTransition;
  if (!ready) return { ...base, eligible: false, reason: "unavailable" };
  return { ...base, eligible: true, reason: "postVisitGreeting" };
}

function outsideAnchorClearance(
  point: { x: number; y: number },
  anchors: readonly { x: number; y: number; interactionRadius: number }[],
  clusterClearance: number,
): boolean {
  for (const anchor of anchors) {
    const minDist = anchor.interactionRadius + clusterClearance;
    if (Math.hypot(point.x - anchor.x, point.y - anchor.y) + 1e-6 < minDist) return false;
  }
  return true;
}

function findApproachTarget(
  initiator: VenueEncounterAgentView,
  joiner: VenueEncounterAgentView,
  candidates: readonly VenueEncounterCandidateView[],
  anchors: readonly { x: number; y: number; interactionRadius: number }[],
  clusterClearance: number,
  mergeRadius: number,
): VenueEncounterCandidateView | undefined {
  const blocked = new Set([...initiator.blockedCandidateIds, ...joiner.blockedCandidateIds]);
  const ranked = candidates
    .filter((candidate) => candidate.joinable && !blocked.has(candidate.id))
    .filter((candidate) => outsideAnchorClearance(candidate, anchors, clusterClearance))
    .map((candidate) => ({ candidate, dist: Math.hypot(candidate.x - initiator.x, candidate.y - initiator.y) }))
    .filter((item) => item.dist <= mergeRadius)
    .sort((a, b) => a.dist - b.dist || (a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0));
  return ranked[0]?.candidate;
}

export function updateEncounterWindows(
  windows: Readonly<Record<string, VenueEncounterWindow>>,
  events: readonly { eventType: string; metadata: { agentId?: string; venueAnchorId?: string } }[],
  tick: number,
  windowTicks: number,
  activeVisitAgentIds: ReadonlySet<string>,
): Record<string, VenueEncounterWindow> {
  const next: Record<string, VenueEncounterWindow> = { ...windows };
  for (const event of events) {
    const agentId = event.metadata.agentId;
    if (!agentId) continue;
    if (event.eventType === "venueVisitStarted" || event.eventType === "venueVisitAbandoned") {
      delete next[agentId];
    }
    if (event.eventType === "venueVisitCompleted" && event.metadata.venueAnchorId) {
      next[agentId] = { anchorId: event.metadata.venueAnchorId, completedAtTick: tick };
    }
  }
  for (const agentId of activeVisitAgentIds) delete next[agentId];
  for (const [agentId, window] of Object.entries(next)) {
    if (tick - window.completedAtTick > windowTicks) delete next[agentId];
  }
  return next;
}

/** 新しい訪問を始めたagentの機会ログ印を外し、次の訪問で再度記録できるようにする */
export function pruneEncounterSignals(
  signals: Readonly<Record<string, true>>,
  restartedAgentIds: readonly string[],
): Record<string, true> {
  if (restartedAgentIds.length === 0) return { ...signals };
  const drop = new Set(restartedAgentIds);
  const next: Record<string, true> = {};
  for (const key of Object.keys(signals)) {
    const [, idA, idB] = key.split("|");
    if ((idA && drop.has(idA)) || (idB && drop.has(idB))) continue;
    next[key] = true;
  }
  return next;
}

function anchorLabel(anchors: readonly VenueAnchor[], anchorId: string): string {
  return anchors.find((anchor) => anchor.id === anchorId)?.label ?? anchorId;
}

/**
 * このtickの機会ログと、訪問完了後に実行してよい形成/接近。
 * サービス中の組はログだけで、actionには入れない。
 */
export function planVenueEncounters(input: {
  agents: readonly VenueEncounterAgentView[];
  presences: Readonly<Record<string, VenueEncounterPresence>>;
  candidates: readonly VenueEncounterCandidateView[];
  anchors: readonly VenueAnchor[];
  tick: number;
  radius: number;
  windowTicks: number;
  clusterClearance: number;
  mergeRadius: number;
  existingTieStrength: number;
  tieCorrectionBetween: (idA: string, idB: string) => number;
  signals: Readonly<Record<string, true>>;
}): { events: VenueEncounterLogEvent[]; actions: VenueEncounterAction[]; signals: Record<string, true> } {
  const signals = { ...input.signals };
  const events: VenueEncounterLogEvent[] = [];
  const byId = new Map(input.agents.map((agent) => [agent.id, agent]));
  const ids = [...byId.keys()].sort();
  const eligible: { opportunity: EncounterOpportunity; a: VenueEncounterAgentView; b: VenueEncounterAgentView }[] = [];

  const remember = (
    opportunity: EncounterOpportunity,
    a: VenueEncounterAgentView,
    b: VenueEncounterAgentView,
    groupId?: string,
  ): void => {
    if (!opportunity.observed || !opportunity.reason || !opportunity.phase || !opportunity.anchorId) return;
    const key = pairKey(opportunity.anchorId, a.id, b.id, opportunity.phase, opportunity.reason);
    if (signals[key]) return;
    signals[key] = true;
    const initiator = byId.get(opportunity.initiatorId ?? a.id) ?? a;
    const counterpart = initiator.id === a.id ? b : a;
    const label = anchorLabel(input.anchors, opportunity.anchorId);
    const message =
      opportunity.reason === "belowSocialThreshold"
        ? `${a.label}さんと${b.label}さんは${label}の近くにいたが、会話の輪には入らなかった`
        : opportunity.reason === "serviceInProgress"
          ? `${a.label}さんと${b.label}さんが${label}の近くで顔を合わせた`
          : opportunity.reason === "unavailable"
            ? `${initiator.label}さんと${counterpart.label}さんは${label}のあと、別の行動中で会話を始めなかった`
            : `${initiator.label}さんが${counterpart.label}さんに、${label}のあとで声をかけた`;
    events.push({
      eventType: "venueEncounterOpportunity",
      message,
      metadata: {
        agentId: opportunity.reason === "postVisitGreeting" ? initiator.id : a.id < b.id ? a.id : b.id,
        agentLabel: opportunity.reason === "postVisitGreeting" ? initiator.label : a.id < b.id ? a.label : b.label,
        counterpartAgentId: opportunity.reason === "postVisitGreeting" ? counterpart.id : a.id < b.id ? b.id : a.id,
        counterpartAgentLabel:
          opportunity.reason === "postVisitGreeting" ? counterpart.label : a.id < b.id ? b.label : a.label,
        venueAnchorId: opportunity.anchorId,
        venueEncounterPhase: opportunity.phase,
        venueEncounterReason: opportunity.reason,
        venueEncounterScore: opportunity.score,
        ...(groupId ? { groupId } : {}),
      },
    });
  };

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = byId.get(ids[i])!;
      const b = byId.get(ids[j])!;
      const opportunity = evaluateEncounterOpportunity({
        a,
        b,
        presenceA: input.presences[a.id] ?? { kind: "none" },
        presenceB: input.presences[b.id] ?? { kind: "none" },
        tick: input.tick,
        radius: input.radius,
        windowTicks: input.windowTicks,
        existingTieStrength: input.existingTieStrength,
        tieCorrection: input.tieCorrectionBetween(a.id, b.id),
      });
      if (!opportunity.observed) continue;
      if (opportunity.eligible) eligible.push({ opportunity, a, b });
      else remember(opportunity, a, b);
    }
  }

  eligible.sort((left, right) => {
    const score = right.opportunity.score - left.opportunity.score;
    if (score !== 0) return score;
    const a = (left.opportunity.initiatorId ?? "").localeCompare(right.opportunity.initiatorId ?? "");
    if (a !== 0) return a;
    return (left.opportunity.counterpartId ?? "").localeCompare(right.opportunity.counterpartId ?? "");
  });

  const assigned = new Set<string>();
  const actions: VenueEncounterAction[] = [];
  for (const item of eligible) {
    const initiator = byId.get(item.opportunity.initiatorId ?? "") ?? item.a;
    const joiner = initiator.id === item.a.id ? item.b : item.a;
    if (assigned.has(initiator.id) || assigned.has(joiner.id)) continue;
    const anchorId = item.opportunity.anchorId;
    if (!anchorId) continue;
    const anchor = input.anchors.find((candidate) => candidate.id === anchorId);
    if (!anchor) continue;
    const existing = findApproachTarget(
      initiator,
      joiner,
      input.candidates,
      input.anchors,
      input.clusterClearance,
      input.mergeRadius,
    );
    if (existing) {
      actions.push({
        kind: "approach",
        candidateId: existing.id,
        initiatorId: initiator.id,
        joinerId: joiner.id,
        anchorId,
        score: item.opportunity.score,
      });
      remember(item.opportunity, item.a, item.b, existing.id);
    } else {
      actions.push({
        kind: "create",
        initiatorId: initiator.id,
        joinerId: joiner.id,
        anchorId,
        center: resolveEncounterClusterCenter(anchor, [initiator, joiner], input.clusterClearance),
        score: item.opportunity.score,
      });
      remember(item.opportunity, item.a, item.b);
    }
    assigned.add(initiator.id);
    assigned.add(joiner.id);
  }

  return { events, actions, signals };
}
