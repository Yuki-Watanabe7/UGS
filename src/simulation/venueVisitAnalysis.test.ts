import { describe, expect, it } from "vitest";
import type { LogEntry, SimulationState } from "./types";
import { buildVenueVisitAnalysis, readAgentVenueVisitHistory } from "./venueVisitAnalysis";

function state(log: LogEntry[], enabled = true): SimulationState {
  return {
    tick: 20,
    agents: [],
    groupCandidates: [],
    log,
    width: 800,
    height: 520,
    finished: false,
    formationScenarioId: "standingParty",
    standingPartyConfig: enabled
      ? ({
          venueAnchors: { enabled: true },
        } as SimulationState["standingPartyConfig"])
      : undefined,
  };
}

function entry(partial: Pick<LogEntry, "tick" | "message" | "eventType"> & { metadata?: LogEntry["metadata"] }): LogEntry {
  return { tags: ["venueVisit"], ...partial };
}

describe("buildVenueVisitAnalysis (Issue #266)", () => {
  it("counts food and drink visits, distance, and a new cluster join after completion", () => {
    const log: LogEntry[] = [
      entry({
        tick: 4,
        message: "Aさんが料理を取りに移動を始めた",
        eventType: "venueVisitStarted",
        metadata: { agentId: "a", venueAnchorKind: "food", groupId: "c1", venueTravelDistance: 100 },
      }),
      entry({
        tick: 8,
        message: "Aさんが料理台に着いた",
        eventType: "venueVisitArrived",
        metadata: { agentId: "a", venueAnchorKind: "food" },
      }),
      entry({
        tick: 10,
        message: "Aさんが料理を受け取った",
        eventType: "refreshmentObtained",
        metadata: { agentId: "a", venueAnchorKind: "food", venueAnchorId: "anchor:food-main" },
      }),
      entry({
        tick: 12,
        message: "Aさんが料理台を離れ、会場の回遊に戻った",
        eventType: "venueVisitCompleted",
        metadata: { agentId: "a", venueAnchorKind: "food" },
      }),
      entry({
        tick: 14,
        message: "Bさんがドリンクを取りに移動を始めた",
        eventType: "venueVisitStarted",
        metadata: { agentId: "b", venueAnchorKind: "drink", venueTravelDistance: 40 },
      }),
      entry({
        tick: 15,
        message: "Bさんがドリンク台への移動を中断した",
        eventType: "venueVisitAbandoned",
        metadata: { agentId: "b", venueAnchorKind: "drink", venueVisitAbandonReason: "travelTimedOut" },
      }),
      entry({
        tick: 18,
        message: "Aが別の輪へ",
        eventType: "agentJoined",
        metadata: { agentId: "a", groupId: "c2" },
      }),
      entry({
        tick: 19,
        message: "同じ輪へ戻った人は数えない",
        eventType: "venueVisitStarted",
        metadata: { agentId: "c", venueAnchorKind: "drink", groupId: "c9", venueTravelDistance: 10 },
      }),
      entry({
        tick: 19,
        message: "完了",
        eventType: "venueVisitCompleted",
        metadata: { agentId: "c", venueAnchorKind: "drink" },
      }),
      entry({
        tick: 20,
        message: "元の輪",
        eventType: "clusterRejoined",
        metadata: { agentId: "c", groupId: "c9" },
      }),
    ];

    const summary = buildVenueVisitAnalysis(state(log));
    expect(summary.schemaVersion).toBe("venue-visit-analysis/1");
    expect(summary.enabled).toBe(true);
    expect(summary.foodVisitCount).toBe(1);
    expect(summary.drinkVisitCount).toBe(2);
    expect(summary.arrivedCount).toBe(1);
    expect(summary.completedCount).toBe(2);
    expect(summary.abandonedCount).toBe(1);
    expect(summary.travelDistanceSampleCount).toBe(3);
    expect(summary.meanTravelDistance).toBeCloseTo(50, 8);
    expect(summary.newClusterJoinAfterVisitCount).toBe(1);
    expect(state(log).log).toHaveLength(log.length);
  });

  it("reads the latest obtain and abandon ticks without recomputing a threshold", () => {
    const log: LogEntry[] = [
      entry({
        tick: 3,
        message: "着いた",
        eventType: "venueVisitArrived",
        metadata: { agentId: "a", venueAnchorId: "anchor:drink-main", venueAnchorKind: "drink" },
      }),
      entry({
        tick: 6,
        message: "受け取った",
        eventType: "refreshmentObtained",
        metadata: { agentId: "a", venueAnchorKind: "drink" },
      }),
      entry({
        tick: 9,
        message: "戻った",
        eventType: "venueVisitCompleted",
        metadata: { agentId: "a", venueAnchorKind: "drink" },
      }),
    ];
    expect(readAgentVenueVisitHistory(log, "a")).toEqual({
      arrivedAtTick: 3,
      obtainedAtTick: 6,
      completedAtTick: 9,
      lastAnchorId: "anchor:drink-main",
      lastKind: "drink",
    });
    expect(readAgentVenueVisitHistory(log, "missing")).toBeUndefined();
  });
});
