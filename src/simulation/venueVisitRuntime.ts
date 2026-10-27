/**
 * Issue #264 (Phase 7, standingParty): 飲食ステーションへの目的移動・受け取り・再回遊。
 *
 * `docs/standing-party-phase7-venue-anchors.md` §4・§6・§7・§8。
 * `departFromCluster` は使わない(主系列RNG・中心からの押し出し・clusterDepartureCountを避ける)。
 * 直進・停止・補充・capacity順はrngを消費しない。
 * 近接だけでは会話参加も接触も作らない。形成への接続は `encounterEnabled` のときだけ
 * `venueEncounter.ts`（Issue #265）が、訪問レコードが消えたあとに行う。
 */
import { clamp, distance, WORLD_HEIGHT, WORLD_WIDTH } from "./model";
import { applyRefreshmentRefill, applyVisitCooldown } from "./refreshmentNeeds";
import type { Agent, GroupCandidate, SimulationEventMetadata, SimulationEventType } from "./types";
import type {
  AgentRefreshmentNeed,
  PendingVenueVisit,
  VenueAnchor,
  VenueAnchorKind,
  VenueVisitAbandonReason,
  VenueVisitDecision,
} from "./venueAnchors";

const AGENT_WORLD_MARGIN = 5;

export type VenueVisitLogEvent = {
  eventType: Extract<
    SimulationEventType,
    | "venueVisitStarted"
    | "venueVisitArrived"
    | "refreshmentObtained"
    | "venueVisitCompleted"
    | "venueVisitAbandoned"
  >;
  message: string;
  metadata: SimulationEventMetadata;
};

const INELIGIBLE_STATES: ReadonlySet<Agent["state"]> = new Set(["leaving", "left", "unassigned"]);

function itemName(kind: VenueAnchorKind): "料理" | "ドリンク" {
  return kind === "food" ? "料理" : "ドリンク";
}

function stationName(kind: VenueAnchorKind): "料理台" | "ドリンク台" {
  return kind === "food" ? "料理台" : "ドリンク台";
}

function sortIds(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function baseMetadata(agent: Agent | undefined, agentId: string, visit: PendingVenueVisit): SimulationEventMetadata {
  return {
    agentId,
    agentLabel: agent?.label ?? agentId,
    venueAnchorId: visit.anchorId,
    venueAnchorKind: visit.purpose,
    venueVisitId: visit.visitId,
  };
}

/**
 * anchor中心への直進と、呼び出し側が計算したwall avoidanceを合成する。
 * 合成後の速さは `approachSpeed` を超えない。座標はagentの到達範囲へclampする。
 * 距離0のときは直進成分を足さない。
 */
export function applyVenueTravelStep(
  agent: { x: number; y: number; vx: number; vy: number },
  anchor: { x: number; y: number },
  approachSpeed: number,
  wall: { fx: number; fy: number } = { fx: 0, fy: 0 },
): void {
  const dx = anchor.x - agent.x;
  const dy = anchor.y - agent.y;
  const dist = Math.hypot(dx, dy);
  let stepX = 0;
  let stepY = 0;
  if (dist > 1e-9) {
    stepX = (dx / dist) * approachSpeed;
    stepY = (dy / dist) * approachSpeed;
  }
  let mx = stepX + wall.fx;
  let my = stepY + wall.fy;
  const speed = Math.hypot(mx, my);
  if (speed > approachSpeed && speed > 0) {
    const scale = approachSpeed / speed;
    mx *= scale;
    my *= scale;
  }
  agent.vx = mx;
  agent.vy = my;
  agent.x = clamp(agent.x + mx, AGENT_WORLD_MARGIN, WORLD_WIDTH - AGENT_WORLD_MARGIN);
  agent.y = clamp(agent.y + my, AGENT_WORLD_MARGIN, WORLD_HEIGHT - AGENT_WORLD_MARGIN);
}

/** receiving / consuming、または目的地が無い traveling。その場で止める */
export function holdVenueVisitPosition(agent: { vx: number; vy: number }): void {
  agent.vx = 0;
  agent.vy = 0;
}

/**
 * 進行中の訪問があれば、このtickの移動を飲食ルールで処理して true を返す。
 * 呼び出し側は roaming も wander の乱数もこのagentには適用しない。
 */
export function stepVenueVisitMovement(
  agent: { x: number; y: number; vx: number; vy: number },
  visit: PendingVenueVisit | undefined,
  anchor: VenueAnchor | undefined,
  approachSpeed: number,
  wall: { fx: number; fy: number },
): boolean {
  if (!visit) return false;
  if (!anchor || visit.phase !== "traveling") {
    holdVenueVisitPosition(agent);
    return true;
  }
  applyVenueTravelStep(agent, anchor, approachSpeed, wall);
  return true;
}

function detachMember(candidate: GroupCandidate, agentId: string): void {
  const index = candidate.memberIds.indexOf(agentId);
  if (index >= 0) candidate.memberIds.splice(index, 1);
}

/**
 * `startFoodVisit` / `startDrinkVisit` を訪問レコードへ変える。
 * joined なら membership とエピソードを同じtickで外す。座標は動かさない。
 * `clusterDepartureCount` は増やさない。社会的移動意図があるagentは開始しない。
 */
export function startVenueVisitsFromDecisions(input: {
  agents: Agent[];
  candidates: GroupCandidate[];
  visits: Record<string, PendingVenueVisit>;
  decisions: Readonly<Record<string, VenueVisitDecision>>;
  anchors: readonly VenueAnchor[];
  tick: number;
}): VenueVisitLogEvent[] {
  const anchorsById = new Map(input.anchors.map((anchor) => [anchor.id, anchor]));
  const events: VenueVisitLogEvent[] = [];

  for (const agent of [...input.agents].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (input.visits[agent.id] || agent.pendingClusterTransition) continue;
    if (agent.state !== "joined" && agent.state !== "undecided") continue;
    const decision = input.decisions[agent.id];
    if (!decision || (decision.action !== "startFoodVisit" && decision.action !== "startDrinkVisit")) continue;
    if (!decision.anchorId) continue;
    const anchor = anchorsById.get(decision.anchorId);
    if (!anchor) continue;

    const purpose: VenueAnchorKind = decision.action === "startFoodVisit" ? "food" : "drink";
    const decisionReason = purpose === "food" ? "selectedFood" : "selectedDrink";
    const episodeId = agent.state === "joined" ? agent.currentEpisode?.episodeId : undefined;
    const groupId = agent.state === "joined" ? agent.joinedGroupId : undefined;
    const ticksInCluster =
      agent.state === "joined" && agent.clusterJoinedAtTick !== undefined
        ? input.tick - agent.clusterJoinedAtTick
        : undefined;

    if (agent.state === "joined") {
      const candidate = groupId ? input.candidates.find((item) => item.id === groupId) : undefined;
      if (candidate) detachMember(candidate, agent.id);
      if (groupId) {
        agent.lastDepartedClusterId = groupId;
        agent.lastDepartedClusterAtTick = input.tick;
      }
      agent.joinedGroupId = undefined;
      agent.clusterJoinedAtTick = undefined;
      agent.currentEpisode = undefined;
      agent.state = "undecided";
    }

    const visit: PendingVenueVisit = {
      visitId: `${agent.id}:${anchor.id}:${input.tick}`,
      anchorId: anchor.id,
      purpose,
      startedAtTick: input.tick,
      phase: "traveling",
      phaseEnteredAtTick: input.tick,
      decisionReason,
    };
    input.visits[agent.id] = visit;
    events.push({
      eventType: "venueVisitStarted",
      message: `${agent.label}さんが${itemName(purpose)}を取りに移動を始めた`,
      metadata: {
        ...baseMetadata(agent, agent.id, visit),
        ...(groupId ? { groupId } : {}),
        ...(episodeId
          ? {
              episodeId,
              episodeEndReason: "venueRefreshmentBreak" as const,
              ...(ticksInCluster !== undefined ? { ticksInCluster } : {}),
            }
          : {}),
        refreshmentNeedHunger: decision.hunger,
        refreshmentNeedThirst: decision.thirst,
        ...(decision.distance !== undefined ? { venueTravelDistance: decision.distance } : {}),
      },
    });
  }
  return events;
}

function abandonVisit(
  input: {
    visits: Record<string, PendingVenueVisit>;
    needs: Record<string, AgentRefreshmentNeed>;
    tick: number;
    failedVisitCooldownTicks: number;
  },
  agent: Agent | undefined,
  agentId: string,
  visit: PendingVenueVisit,
  reason: VenueVisitAbandonReason,
  events: VenueVisitLogEvent[],
): void {
  delete input.visits[agentId];
  if (reason !== "agentLeft") {
    const need = input.needs[agentId];
    if (need) {
      input.needs[agentId] = applyVisitCooldown(need, visit.purpose, input.tick, input.failedVisitCooldownTicks);
    }
  }
  if (agent && !INELIGIBLE_STATES.has(agent.state)) {
    agent.state = "undecided";
  }
  events.push({
    eventType: "venueVisitAbandoned",
    message: `${agent?.label ?? agentId}さんが${stationName(visit.purpose)}への移動を中断した`,
    metadata: {
      ...baseMetadata(agent, agentId, visit),
      venueVisitAbandonReason: reason,
    },
  });
}

/**
 * 退場・未割当のagentに残った訪問を、cooldownなしで捨てる。
 * step 7 のあとで leaving になった場合の安全網。phaseは進めない。
 */
export function abandonIneligibleVenueVisits(input: {
  agents: readonly Agent[];
  visits: Record<string, PendingVenueVisit>;
  needs: Record<string, AgentRefreshmentNeed>;
  tick: number;
  failedVisitCooldownTicks: number;
}): VenueVisitLogEvent[] {
  const agentsById = new Map(input.agents.map((agent) => [agent.id, agent]));
  const events: VenueVisitLogEvent[] = [];
  for (const agentId of sortIds(Object.keys(input.visits))) {
    const visit = input.visits[agentId];
    if (!visit) continue;
    const agent = agentsById.get(agentId);
    if (!agent || INELIGIBLE_STATES.has(agent.state)) {
      abandonVisit(input, agent, agentId, visit, "agentLeft", events);
    }
  }
  return events;
}

/**
 * 移動後の到着・満席・移動時間超過・受け取り・消費完了。
 * 到着できたagentを id 昇順で空き枠へ入れる。溢れたagentは待たずに放棄する。
 * 補充は receiving → consuming の遷移で1回だけ。consuming中は再代入しない。
 */
export function advanceVenueVisits(input: {
  agents: Agent[];
  visits: Record<string, PendingVenueVisit>;
  needs: Record<string, AgentRefreshmentNeed>;
  anchors: readonly VenueAnchor[];
  tick: number;
  consumeTicks: number;
  revisitCooldownTicks: number;
  failedVisitCooldownTicks: number;
  maxTravelTicks: number;
  needAfterRefill: number;
}): VenueVisitLogEvent[] {
  const events: VenueVisitLogEvent[] = [];
  const anchorsById = new Map(input.anchors.map((anchor) => [anchor.id, anchor]));
  const agentsById = new Map(input.agents.map((agent) => [agent.id, agent]));

  for (const agentId of sortIds(Object.keys(input.visits))) {
    const visit = input.visits[agentId];
    if (!visit) continue;
    const agent = agentsById.get(agentId);
    if (!agent || INELIGIBLE_STATES.has(agent.state)) {
      abandonVisit(input, agent, agentId, visit, "agentLeft", events);
      continue;
    }
    if (!anchorsById.has(visit.anchorId)) {
      abandonVisit(input, agent, agentId, visit, "anchorMissing", events);
    }
  }

  const occupancy: Record<string, number> = {};
  for (const visit of Object.values(input.visits)) {
    if (visit.phase === "receiving" || visit.phase === "consuming") {
      occupancy[visit.anchorId] = (occupancy[visit.anchorId] ?? 0) + 1;
    }
  }

  const arrivals = new Map<string, string[]>();
  for (const agentId of sortIds(Object.keys(input.visits))) {
    const visit = input.visits[agentId];
    if (!visit || visit.phase !== "traveling") continue;
    const anchor = anchorsById.get(visit.anchorId);
    const agent = agentsById.get(agentId);
    if (!anchor || !agent) continue;
    if (distance(agent.x, agent.y, anchor.x, anchor.y) <= anchor.interactionRadius) {
      const list = arrivals.get(anchor.id) ?? [];
      list.push(agentId);
      arrivals.set(anchor.id, list);
    }
  }

  for (const [anchorId, agentIds] of arrivals) {
    const anchor = anchorsById.get(anchorId);
    if (!anchor) continue;
    const slots = anchor.capacity - (occupancy[anchorId] ?? 0);
    agentIds.forEach((agentId, index) => {
      const visit = input.visits[agentId];
      const agent = agentsById.get(agentId);
      if (!visit || !agent) return;
      if (index < slots) {
        visit.phase = "receiving";
        visit.phaseEnteredAtTick = input.tick;
        occupancy[anchorId] = (occupancy[anchorId] ?? 0) + 1;
        events.push({
          eventType: "venueVisitArrived",
          message: `${agent.label}さんが${stationName(visit.purpose)}に着いた`,
          metadata: baseMetadata(agent, agentId, visit),
        });
      } else {
        abandonVisit(input, agent, agentId, visit, "anchorAtCapacity", events);
      }
    });
  }

  for (const agentId of sortIds(Object.keys(input.visits))) {
    const visit = input.visits[agentId];
    if (!visit || visit.phase !== "traveling") continue;
    const elapsed = input.tick - visit.phaseEnteredAtTick + 1;
    if (elapsed > input.maxTravelTicks) {
      abandonVisit(input, agentsById.get(agentId), agentId, visit, "travelTimedOut", events);
    }
  }

  for (const agentId of sortIds(Object.keys(input.visits))) {
    const visit = input.visits[agentId];
    if (!visit) continue;
    const agent = agentsById.get(agentId);
    const anchor = anchorsById.get(visit.anchorId);
    if (!agent || !anchor) continue;
    if (visit.phase === "receiving") {
      const elapsed = input.tick - visit.phaseEnteredAtTick + 1;
      if (elapsed >= anchor.serviceTicks) {
        const need = input.needs[agentId];
        if (need) input.needs[agentId] = applyRefreshmentRefill(need, visit.purpose, input.needAfterRefill);
        events.push({
          eventType: "refreshmentObtained",
          message: `${agent.label}さんが${itemName(visit.purpose)}を受け取った`,
          metadata: baseMetadata(agent, agentId, visit),
        });
        visit.phase = "consuming";
        visit.phaseEnteredAtTick = input.tick;
      }
    }
    const current = input.visits[agentId];
    if (current?.phase === "consuming") {
      const elapsed = input.tick - current.phaseEnteredAtTick + 1;
      if (elapsed >= input.consumeTicks) {
        const need = input.needs[agentId];
        if (need) {
          input.needs[agentId] = applyVisitCooldown(need, current.purpose, input.tick, input.revisitCooldownTicks);
        }
        delete input.visits[agentId];
        events.push({
          eventType: "venueVisitCompleted",
          message: `${agent.label}さんが${stationName(current.purpose)}を離れ、会場の回遊に戻った`,
          metadata: baseMetadata(agent, agentId, current),
        });
      }
    }
  }

  return events;
}
