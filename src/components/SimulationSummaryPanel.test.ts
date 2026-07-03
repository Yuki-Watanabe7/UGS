import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SimulationSummaryPanel } from "./SimulationSummaryPanel";
import type { Agent, LogEntry, SimulationState } from "../simulation/types";

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-x",
    label: "X",
    x: 400,
    y: 260,
    vx: 0,
    vy: 0,
    willingness: 0.5,
    initiative: 0.3,
    ambiguityTolerance: 0.5,
    influenceAvoidance: 0.3,
    conformity: 0.5,
    leaveThreshold: 0.5,
    isObserverJoiner: false,
    state: "undecided",
    stress: 0,
    ...overrides,
  };
}

function makeState(overrides: Partial<SimulationState>): SimulationState {
  return {
    tick: 0,
    agents: [],
    groupCandidates: [],
    log: [],
    width: 800,
    height: 520,
    finished: false,
    ...overrides,
  };
}

describe("SimulationSummaryPanel", () => {
  it("renders without throwing when the simulation has not finished and nothing has happened yet", () => {
    const state = makeState({ agents: [makeAgent({ id: "a" })] });
    const html = renderToStaticMarkup(createElement(SimulationSummaryPanel, { state }));
    expect(html).toContain("現在時点の暫定集計");
    expect(html).toContain("未発生");
  });

  it("renders finished summary with an observerJoiner that joined and later left", () => {
    const observer = makeAgent({ id: "observer-1", label: "Observer", isObserverJoiner: true, state: "left" });
    const log: LogEntry[] = [
      { tick: 2, message: "", tags: [], eventType: "nucleusCreated", metadata: { groupId: "g1" } },
      { tick: 4, message: "", tags: [], eventType: "groupConfirmed", metadata: { groupId: "g1" } },
      {
        tick: 6,
        message: "",
        tags: [],
        eventType: "observerJoinedConfirmed",
        metadata: { agentId: "observer-1", joinedGroupStatus: "confirmed" },
      },
      { tick: 10, message: "", tags: [], eventType: "observerLeaveStarted", metadata: { agentId: "observer-1" } },
      { tick: 12, message: "", tags: [], eventType: "observerLeft", metadata: { agentId: "observer-1" } },
      { tick: 12, message: "", tags: [], eventType: "simulationFinished" },
    ];
    const state = makeState({ agents: [observer], log, tick: 12, finished: true });

    const html = renderToStaticMarkup(createElement(SimulationSummaryPanel, { state }));

    expect(html).toContain("終了済み");
    expect(html).toContain("tick 6");
    expect(html).toContain("成立済みグループ");
    expect(html).toContain("tick 10");
    expect(html).toContain("tick 12");
    expect(html).not.toContain("現在時点の暫定集計");
  });

  it("shows explicit placeholders when nucleus/group formation and observerJoiner activity never occurred", () => {
    const observer = makeAgent({ id: "observer-1", label: "Observer", isObserverJoiner: true });
    const state = makeState({ agents: [observer] });

    const html = renderToStaticMarkup(createElement(SimulationSummaryPanel, { state }));

    expect(html).toContain("未参加");
    expect(html).toContain("未離脱");
    expect(html).toContain("未発生");
  });
});
