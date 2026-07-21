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

  it("shows the classroom finish reason and unassigned-agent list", () => {
    const unassigned = makeAgent({ id: "u1", label: "U", state: "unassigned", searchRestartCount: 2 });
    const log: LogEntry[] = [
      {
        tick: 20,
        message: "",
        tags: ["unassigned"],
        eventType: "agentUnassigned",
        metadata: {
          agentId: "u1",
          previousAgentState: "approaching",
          searchRestartCount: 2,
          capacityFailureCount: 1,
          stress: 0.7,
        },
      },
      {
        tick: 20,
        message: "",
        tags: ["simulation"],
        eventType: "simulationFinished",
        metadata: { assignedCount: 18, unassignedCount: 1, finishReason: "deadlineReached" },
      },
    ];
    const state = makeState({
      formationScenarioId: "classroomPair",
      agents: [unassigned],
      log,
      tick: 20,
      finished: true,
    });

    const html = renderToStaticMarkup(createElement(SimulationSummaryPanel, { state }));

    expect(html).toContain("締切到達");
    expect(html).toContain("未割当者一覧");
    expect(html).toContain("確定前: 接近中");
    expect(html).toContain("再探索2回");
    expect(html).toContain("ペア形成サマリー");
    expect(html).toContain("成立ペア数");
    expect(html).not.toContain("成立グループ数");
  });

  it("shows 班 vocabulary, group-size distribution, and structural-unassigned breakdown for a variable-capacity (3-4) group preset (Issue #155)", () => {
    const agents = [
      makeAgent({ id: "a", state: "joined", joinedGroupId: "group-1" }),
      makeAgent({ id: "b", state: "joined", joinedGroupId: "group-1" }),
      makeAgent({ id: "c", state: "joined", joinedGroupId: "group-1" }),
      makeAgent({ id: "d", state: "joined", joinedGroupId: "group-2" }),
      makeAgent({ id: "e", state: "joined", joinedGroupId: "group-2" }),
      makeAgent({ id: "f", state: "joined", joinedGroupId: "group-2" }),
      makeAgent({ id: "g", state: "joined", joinedGroupId: "group-2" }),
      makeAgent({ id: "h", state: "unassigned" }),
    ];
    const log: LogEntry[] = [
      { tick: 5, message: "", tags: [], eventType: "groupConfirmed", metadata: { groupId: "group-1", memberCount: 3 } },
      { tick: 12, message: "", tags: [], eventType: "groupConfirmed", metadata: { groupId: "group-2", memberCount: 4 } },
    ];
    const state = makeState({
      formationScenarioId: "classroomPair",
      formationClassroomGroupSize: { minGroupSize: 3, maxGroupSize: 4 },
      groupCandidates: [
        { id: "group-1", x: 0, y: 0, memberIds: ["a", "b", "c"], status: "confirmed", age: 3 },
        { id: "group-2", x: 0, y: 0, memberIds: ["d", "e", "f", "g"], status: "confirmed", age: 3 },
      ],
      agents,
      log,
      tick: 20,
      finished: true,
    });

    const html = renderToStaticMarkup(createElement(SimulationSummaryPanel, { state }));

    expect(html).toContain("班形成サマリー");
    expect(html).toContain("成立班数");
    expect(html).toContain("班人数の内訳");
    expect(html).toContain("班サイズ分布");
    expect(html).toContain("3人班");
    expect(html).toContain("4人班");
    expect(html).toContain("割当人数");
    expect(html).toContain("未割当人数");
    // populationSize=8, min=3/max=4 -> reachable (3+4=8, floor 0), so all 1 unassigned is "excess"
    expect(html).toContain("構造的未割当人数(定員上どうしても割り切れない人数)");
    expect(html).toContain("構造的未割当を超える未割当人数");
    expect(html).not.toContain("ペア形成サマリー");
    expect(html).not.toContain("2人固定");
  });

  it("keeps the after-party group wording", () => {
    const html = renderToStaticMarkup(
      createElement(SimulationSummaryPanel, { state: makeState({ formationScenarioId: "afterParty" }) }),
    );

    expect(html).toContain("グループ形成サマリー");
    expect(html).toContain("成立グループ数");
  });
});
