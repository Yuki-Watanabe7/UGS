import { describe, expect, it } from "vitest";
import { distance } from "./model";
import type { AgentRefreshmentNeed, PendingVenueVisit, VenueAnchor } from "./venueAnchors";
import { MVP_DRINK_ANCHOR, MVP_FOOD_ANCHOR, MVP_VENUE_ANCHORS } from "./venueAnchors";
import {
  evaluateVenueVisitDecision,
  recordVenueVisitDecisions,
  type VenueVisitAgentView,
  type VenueVisitDecisionInput,
} from "./venueVisitDecision";

const THRESHOLD = 0.7;

function agent(overrides: Partial<VenueVisitAgentView> = {}): VenueVisitAgentView {
  return {
    id: "agent-a",
    x: 400,
    y: 260,
    state: "undecided",
    hasPendingClusterTransition: false,
    ...overrides,
  };
}

function need(overrides: Partial<AgentRefreshmentNeed> = {}): AgentRefreshmentNeed {
  return { hunger: 0.2, thirst: 0.2, hungerRate: 1, thirstRate: 1, ...overrides };
}

function decide(overrides: Partial<VenueVisitDecisionInput> = {}) {
  const person = overrides.agent ?? agent();
  return evaluateVenueVisitDecision({
    enabled: true,
    tick: 16,
    agent: person,
    need: need(),
    anchors: [...MVP_VENUE_ANCHORS],
    visits: {},
    minStayTicks: 15,
    visitThreshold: THRESHOLD,
    ...overrides,
  });
}

function foodAnchor(id: string, x: number, y: number, capacity = 3): VenueAnchor {
  return { ...MVP_FOOD_ANCHOR, id, x, y, capacity };
}

describe("evaluateVenueVisitDecision (Issue #263 / ADR §5.2)", () => {
  it("enabled falseは他の条件を見ずにfeatureDisabledを返す", () => {
    const result = decide({
      enabled: false,
      need: need({ hunger: 1, thirst: 1 }),
      agent: agent({ state: "joined", clusterJoinedAtTick: 0 }),
    });
    expect(result.reason).toBe("featureDisabled");
    expect(result.action).toBe("continueExploration");
    expect(result.anchorId).toBeUndefined();
  });

  it("状態境界: leaving/left/unassigned/forming/approachingは開始しない", () => {
    for (const state of ["leaving", "left", "unassigned"] as const) {
      const result = decide({ agent: agent({ state }), need: need({ hunger: 1, thirst: 1 }) });
      expect(result.reason).toBe("notEligibleState");
      expect(result.action).toBe("continueExploration");
    }
    for (const state of ["forming", "approaching"] as const) {
      const result = decide({ agent: agent({ state }), need: need({ thirst: 1 }) });
      expect(result.reason).toBe("notEligibleState");
      expect(result.action).toBe("continueSocialActivity");
    }
  });

  it("pendingClusterTransitionがある間は社会的意図を上書きしない", () => {
    const result = decide({
      agent: agent({ hasPendingClusterTransition: true }),
      need: need({ hunger: 1, thirst: 1 }),
    });
    expect(result.reason).toBe("pendingSocialTransition");
    expect(result.action).toBe("continueSocialActivity");
    expect(result.anchorId).toBeUndefined();
  });

  it("進行中の訪問は選び直さない", () => {
    const visit: PendingVenueVisit = {
      visitId: "agent-a:anchor:drink-main:10",
      anchorId: MVP_DRINK_ANCHOR.id,
      purpose: "drink",
      startedAtTick: 10,
      phase: "traveling",
      phaseEnteredAtTick: 10,
      decisionReason: "selectedDrink",
    };
    const result = decide({
      need: need({ hunger: 1, thirst: 0 }),
      visits: { "agent-a": visit },
      anchors: [
        foodAnchor("anchor:food-near", 401, 260),
        MVP_DRINK_ANCHOR,
      ],
    });
    expect(result.reason).toBe("activeVenueVisit");
    expect(result.action).toBe("keepCurrentVisit");
    expect(result.anchorId).toBe(MVP_DRINK_ANCHOR.id);
  });

  it("joinedの最低滞在中は飲食離脱を始めず、滞在を満たせば愛着ではなくneedで選ぶ", () => {
    const hungry = need({ hunger: 0.95, thirst: 0.1 });
    const blocked = decide({
      tick: 10,
      agent: agent({ state: "joined", clusterJoinedAtTick: 0 }),
      need: hungry,
    });
    expect(blocked.reason).toBe("minimumDwell");
    expect(blocked.action).toBe("continueSocialActivity");
    expect(blocked.dwellTicks).toBe(10);

    const open = decide({
      tick: 16,
      agent: agent({ state: "joined", clusterJoinedAtTick: 0 }),
      need: hungry,
    });
    expect(open.reason).toBe("selectedFood");
    expect(open.action).toBe("startFoodVisit");
    expect(open.dwellTicks).toBe(16);
  });

  it("閾値未満は抑制し、foodとdrinkは独立で、補充後のcooldownが再訪を止める", () => {
    expect(decide({ need: need({ hunger: 0.699, thirst: 0.699 }) }).reason).toBe("belowThreshold");
    expect(decide({ agent: agent({ state: "joined", clusterJoinedAtTick: 0 }), need: need() }).action).toBe(
      "continueSocialActivity",
    );

    expect(decide({ need: need({ hunger: 0.9, thirst: 0.1 }) })).toMatchObject({
      action: "startFoodVisit",
      reason: "selectedFood",
      anchorId: MVP_FOOD_ANCHOR.id,
    });
    expect(decide({ need: need({ hunger: 0.1, thirst: 0.9 }) })).toMatchObject({
      action: "startDrinkVisit",
      reason: "selectedDrink",
      anchorId: MVP_DRINK_ANCHOR.id,
    });

    const cooled = need({ hunger: 0.2, thirst: 0.9, drinkCooldownUntilTick: 80 });
    expect(decide({ tick: 79, need: cooled }).reason).toBe("revisitCooldown");
    expect(decide({ tick: 80, need: cooled }).reason).toBe("selectedDrink");

    const drinkBlockedFoodOpen = need({ hunger: 0.9, thirst: 0.9, drinkCooldownUntilTick: 100 });
    expect(decide({ tick: 16, need: drinkBlockedFoodOpen })).toMatchObject({
      reason: "selectedFood",
      anchorId: MVP_FOOD_ANCHOR.id,
    });
  });

  it("同値のdeficitではdrinkを優先し、§10.2の座標からはドリンク台を選ぶ", () => {
    const tied = decide({ need: need({ hunger: 0.9, thirst: 0.9 }) });
    expect(tied.reason).toBe("selectedDrink");

    const fixture = decide({
      tick: 16,
      agent: agent({ x: 400, y: 260, state: "joined", clusterJoinedAtTick: 0 }),
      need: need({ hunger: 0.2032, thirst: 0.704 }),
    });
    expect(fixture.reason).toBe("selectedDrink");
    expect(fixture.anchorId).toBe("anchor:drink-main");
    expect(fixture.distance).toBeCloseTo(distance(400, 260, MVP_DRINK_ANCHOR.x, MVP_DRINK_ANCHOR.y), 6);
  });

  it("anchorが0件・そのkindだけ無い・満席ならfallbackし、複数なら距離次いでidで決める", () => {
    const thirsty = need({ thirst: 0.9, hunger: 0.1 });
    expect(decide({ need: thirsty, anchors: [] }).reason).toBe("noAnchor");
    expect(decide({ need: thirsty, anchors: [MVP_FOOD_ANCHOR] }).reason).toBe("noAnchor");
    expect(decide({ need: need({ hunger: 0.9, thirst: 0.1 }), anchors: [MVP_FOOD_ANCHOR] }).anchorId).toBe(
      MVP_FOOD_ANCHOR.id,
    );

    const near = foodAnchor("anchor:food-near", 410, 260, 1);
    const far = foodAnchor("anchor:food-far", 700, 260, 2);
    const occupying: PendingVenueVisit = {
      visitId: "other:anchor:food-near:1",
      anchorId: near.id,
      purpose: "food",
      startedAtTick: 1,
      phase: "receiving",
      phaseEnteredAtTick: 1,
      decisionReason: "selectedFood",
    };
    const fallback = decide({
      agent: agent({ x: 400, y: 260 }),
      need: need({ hunger: 0.95, thirst: 0.1 }),
      anchors: [near, far],
      visits: { other: occupying },
    });
    expect(fallback.anchorId).toBe(far.id);
    expect(fallback.reason).toBe("selectedFood");

    const travelingOnly: PendingVenueVisit = { ...occupying, phase: "traveling" };
    const travelingDoesNotFill = decide({
      need: need({ hunger: 0.95, thirst: 0.1 }),
      anchors: [near, far],
      visits: { other: travelingOnly },
    });
    expect(travelingDoesNotFill.anchorId).toBe(near.id);

    const bothFull = decide({
      need: need({ hunger: 0.95, thirst: 0.1 }),
      anchors: [near, { ...far, capacity: 1 }],
      visits: {
        other: occupying,
        third: { ...occupying, visitId: "third", anchorId: far.id },
      },
    });
    expect(bothFull.reason).toBe("anchorsAtCapacity");
    expect(bothFull.action).toBe("continueExploration");

    const equalA = foodAnchor("anchor:food-b", 400, 280);
    const equalB = foodAnchor("anchor:food-a", 400, 240);
    const byId = decide({
      agent: agent({ x: 400, y: 260 }),
      need: need({ hunger: 0.9, thirst: 0.1 }),
      anchors: [equalA, equalB],
    });
    const reversed = decide({
      agent: agent({ x: 400, y: 260 }),
      need: need({ hunger: 0.9, thirst: 0.1 }),
      anchors: [equalB, equalA],
    });
    expect(byId.anchorId).toBe("anchor:food-a");
    expect(reversed).toEqual(byId);
  });

  it("recordVenueVisitDecisionsはagentとvisitsを変更せず、同じ入力なら同じ結果になる", () => {
    const person = Object.freeze(agent());
    const visits = Object.freeze({});
    const input = {
      enabled: true,
      tick: 4,
      agents: [person],
      needs: { "agent-a": need({ thirst: 0.8 }) },
      anchors: [...MVP_VENUE_ANCHORS],
      visits,
      minStayTicks: 15,
      visitThreshold: THRESHOLD,
    };
    const first = recordVenueVisitDecisions(input);
    const second = recordVenueVisitDecisions(input);
    expect(first).toEqual(second);
    expect(first["agent-a"].reason).toBe("selectedDrink");
    expect(person.state).toBe("undecided");
  });
});
