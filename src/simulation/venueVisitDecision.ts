/**
 * Issue #263 (Phase 7, standingParty): 飲食目的の `VenueVisitDecision` を純粋に計算する。
 *
 * `docs/standing-party-phase7-venue-anchors.md` §5。rngは呼ばない。愛着・離脱配慮・stress・
 * 会話満足度・他agentのneed・未来のneedは読まない。`enabled === false` のときは他の条件を見ない。
 * engineは無効時にこの関数を呼ばない(`featureDisabled` は単体テスト用)。
 *
 * メンバーシップの解除と `PendingVenueVisit` の生成は #264。ここは意図と理由を返すだけ。
 */
import { distance } from "./model";
import type {
  AgentRefreshmentNeed,
  PendingVenueVisit,
  VenueAgentReadout,
  VenueAnchor,
  VenueAnchorKind,
  VenueVisitDecision,
  VenueVisitDecisionAction,
} from "./venueAnchors";

export type VenueVisitAgentView = {
  id: string;
  x: number;
  y: number;
  state: "undecided" | "forming" | "approaching" | "joined" | "leaving" | "left" | "unassigned";
  /** 社会的移動意図の有無だけを見る。targetの中身は読まない */
  hasPendingClusterTransition: boolean;
  clusterJoinedAtTick?: number;
};

export type VenueVisitDecisionInput = {
  enabled: boolean;
  tick: number;
  agent: VenueVisitAgentView;
  need?: AgentRefreshmentNeed;
  anchors: readonly VenueAnchor[];
  /** 全agentの進行中訪問。占有数は receiving / consuming の他agentだけを数える */
  visits: Readonly<Record<string, PendingVenueVisit>>;
  minStayTicks: number;
  visitThreshold: number;
};

const KINDS: readonly VenueAnchorKind[] = ["food", "drink"];

function needValue(need: AgentRefreshmentNeed, kind: VenueAnchorKind): number {
  return kind === "food" ? need.hunger : need.thirst;
}

function cooldownUntil(need: AgentRefreshmentNeed, kind: VenueAnchorKind): number | undefined {
  return kind === "food" ? need.foodCooldownUntilTick : need.drinkCooldownUntilTick;
}

function cooldownOpen(need: AgentRefreshmentNeed, kind: VenueAnchorKind, tick: number): boolean {
  const until = cooldownUntil(need, kind);
  return until === undefined || tick >= until;
}

function dwellOf(agent: VenueVisitAgentView, tick: number): number | undefined {
  if (agent.clusterJoinedAtTick === undefined) return undefined;
  return tick - agent.clusterJoinedAtTick;
}

function continueAction(state: VenueVisitAgentView["state"]): VenueVisitDecisionAction {
  return state === "joined" ? "continueSocialActivity" : "continueExploration";
}

/**
 * receiving / consuming の同時人数。`traveling` は占有に数えない。
 * `exceptAgentId` の訪問は、自分のdecisionが自分を占有に数えないように除く。
 */
export function countAnchorOccupancy(
  visits: Readonly<Record<string, PendingVenueVisit>>,
  exceptAgentId?: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [agentId, visit] of Object.entries(visits)) {
    if (agentId === exceptAgentId) continue;
    if (visit.phase !== "receiving" && visit.phase !== "consuming") continue;
    counts[visit.anchorId] = (counts[visit.anchorId] ?? 0) + 1;
  }
  return counts;
}

function decide(
  action: VenueVisitDecisionAction,
  reason: VenueVisitDecision["reason"],
  hunger: number,
  thirst: number,
  extra?: Partial<Pick<VenueVisitDecision, "anchorId" | "dwellTicks" | "distance">>,
): VenueVisitDecision {
  return { action, reason, hunger, thirst, ...extra };
}

/**
 * 1agent・1tickの優先順位(ADR §5.2)。上から最初に一致した理由を採用する。
 * kindは閾値超過・cooldown済み・空きanchorのあるものの中で deficit 最大。同値なら drink を先にする。
 * 同一kindのanchorは距離の昇順、同距離は `id` の昇順。
 */
export function evaluateVenueVisitDecision(input: VenueVisitDecisionInput): VenueVisitDecision {
  const hunger = input.need?.hunger ?? 0;
  const thirst = input.need?.thirst ?? 0;
  if (!input.enabled) {
    return decide("continueExploration", "featureDisabled", hunger, thirst);
  }

  const { agent, tick } = input;
  const dwellTicks = dwellOf(agent, tick);
  const dwell = dwellTicks !== undefined ? { dwellTicks } : {};

  if (agent.state === "leaving" || agent.state === "left" || agent.state === "unassigned") {
    return decide("continueExploration", "notEligibleState", hunger, thirst, dwell);
  }
  if (agent.state === "forming" || agent.state === "approaching") {
    return decide("continueSocialActivity", "notEligibleState", hunger, thirst, dwell);
  }
  if (agent.hasPendingClusterTransition) {
    return decide("continueSocialActivity", "pendingSocialTransition", hunger, thirst, dwell);
  }

  const ownVisit = input.visits[agent.id];
  if (ownVisit) {
    const anchor = input.anchors.find((item) => item.id === ownVisit.anchorId);
    return decide("keepCurrentVisit", "activeVenueVisit", hunger, thirst, {
      ...dwell,
      anchorId: ownVisit.anchorId,
      ...(anchor ? { distance: distance(agent.x, agent.y, anchor.x, anchor.y) } : {}),
    });
  }

  if (agent.state === "joined" && dwellTicks !== undefined && dwellTicks < input.minStayTicks) {
    return decide("continueSocialActivity", "minimumDwell", hunger, thirst, dwell);
  }

  const need = input.need ?? { hunger: 0, thirst: 0, hungerRate: 0, thirstRate: 0 };
  const above = KINDS.filter((kind) => needValue(need, kind) >= input.visitThreshold);
  const hold = continueAction(agent.state);
  if (above.length === 0) {
    return decide(hold, "belowThreshold", hunger, thirst, dwell);
  }

  const cooled = above.filter((kind) => cooldownOpen(need, kind, tick));
  if (cooled.length === 0) {
    return decide(hold, "revisitCooldown", hunger, thirst, dwell);
  }

  const occupancy = countAnchorOccupancy(input.visits, agent.id);
  const anchorsOf = (kind: VenueAnchorKind): VenueAnchor[] => input.anchors.filter((anchor) => anchor.kind === kind);
  const freeOf = (kind: VenueAnchorKind): VenueAnchor[] =>
    anchorsOf(kind).filter((anchor) => (occupancy[anchor.id] ?? 0) < anchor.capacity);

  const withCatalog = cooled.filter((kind) => anchorsOf(kind).length > 0);
  if (withCatalog.length === 0) {
    return decide(hold, "noAnchor", hunger, thirst, dwell);
  }
  const withFree = withCatalog.filter((kind) => freeOf(kind).length > 0);
  if (withFree.length === 0) {
    return decide(hold, "anchorsAtCapacity", hunger, thirst, dwell);
  }

  let best: VenueAnchorKind = withFree[0];
  for (const kind of withFree) {
    const deficit = needValue(need, kind) - input.visitThreshold;
    const bestDeficit = needValue(need, best) - input.visitThreshold;
    if (deficit > bestDeficit || (deficit === bestDeficit && kind === "drink")) best = kind;
  }

  const ranked = [...freeOf(best)].sort((a, b) => {
    const da = distance(agent.x, agent.y, a.x, a.y);
    const db = distance(agent.x, agent.y, b.x, b.y);
    if (da !== db) return da - db;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  const chosen = ranked[0];
  const action: VenueVisitDecisionAction = best === "food" ? "startFoodVisit" : "startDrinkVisit";
  const reason = best === "food" ? "selectedFood" : "selectedDrink";
  return decide(action, reason, hunger, thirst, {
    ...dwell,
    anchorId: chosen.id,
    distance: distance(agent.x, agent.y, chosen.x, chosen.y),
  });
}

export type VenueDecisionAgent = VenueVisitAgentView & { id: string };

/**
 * そのtickの全agentについてdecisionを記録する。agentもvisitsも変更しない。
 * 呼び出し側は増分後のneedを渡す。
 */
export function recordVenueVisitDecisions(input: {
  enabled: boolean;
  tick: number;
  agents: readonly VenueDecisionAgent[];
  needs: Readonly<Record<string, AgentRefreshmentNeed>>;
  anchors: readonly VenueAnchor[];
  visits: Readonly<Record<string, PendingVenueVisit>>;
  minStayTicks: number;
  visitThreshold: number;
}): Record<string, VenueVisitDecision> {
  const lastDecisions: Record<string, VenueVisitDecision> = {};
  for (const agent of input.agents) {
    lastDecisions[agent.id] = evaluateVenueVisitDecision({
      enabled: input.enabled,
      tick: input.tick,
      agent,
      need: input.needs[agent.id],
      anchors: input.anchors,
      visits: input.visits,
      minStayTicks: input.minStayTicks,
      visitThreshold: input.visitThreshold,
    });
  }
  return lastDecisions;
}

/** Inspector用。`lastDecisions` を読むだけで、decisionを再計算しない */
export function readVenueAgentReadout(
  runtime: { needs: Readonly<Record<string, AgentRefreshmentNeed>>; lastDecisions?: Readonly<Record<string, VenueVisitDecision>> } | undefined,
  agentId: string,
): VenueAgentReadout | undefined {
  const need = runtime?.needs[agentId];
  if (!need) return undefined;
  const decision = runtime?.lastDecisions?.[agentId];
  return {
    hunger: need.hunger,
    thirst: need.thirst,
    hungerRate: need.hungerRate,
    thirstRate: need.thirstRate,
    ...(need.foodCooldownUntilTick !== undefined ? { foodCooldownUntilTick: need.foodCooldownUntilTick } : {}),
    ...(need.drinkCooldownUntilTick !== undefined ? { drinkCooldownUntilTick: need.drinkCooldownUntilTick } : {}),
    ...(decision
      ? {
          action: decision.action,
          reason: decision.reason,
          ...(decision.anchorId !== undefined ? { anchorId: decision.anchorId } : {}),
        }
      : {}),
  };
}
