/**
 * Issue #217: 統計ダッシュボードのコンポーネントテスト。
 * `renderToStaticMarkup`による静的レンダリング(既存規約)。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StandingPartyAnalyticsDashboard } from "./StandingPartyAnalyticsDashboard";
import { chooseSeriesSampleInterval, formatDistribution, formatRate } from "./analyticsDashboardFormat";
import { DEFAULT_PARAMS } from "../simulation/presets";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG } from "../simulation/standingPartyScenarioConfig";
import type { Agent, GroupCandidate, LogEntry, SimulationState } from "../simulation/types";

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "a",
    label: "A",
    x: 100,
    y: 100,
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

function makeCandidate(overrides: Partial<GroupCandidate>): GroupCandidate {
  return {
    id: "g1",
    x: 200,
    y: 200,
    memberIds: ["a", "b"],
    status: "confirmed",
    age: 0,
    ...overrides,
  };
}

function entry(
  tick: number,
  eventType: LogEntry["eventType"],
  metadata: NonNullable<LogEntry["metadata"]>,
): LogEntry {
  return { tick, message: `t=${tick}`, tags: [], eventType, metadata };
}

function makeState(overrides: Partial<SimulationState> = {}): SimulationState {
  return {
    tick: 40,
    seed: 7,
    agents: [
      makeAgent({ id: "a", label: "A", state: "joined", joinedGroupId: "g1" }),
      makeAgent({ id: "b", label: "B", state: "joined", joinedGroupId: "g1" }),
      makeAgent({ id: "oj", label: "OJ", isObserverJoiner: true }),
      makeAgent({ id: "c", label: "C" }),
    ],
    groupCandidates: [makeCandidate({ id: "g1", memberIds: ["a", "b"] })],
    log: [
      entry(1, "nucleusCreated", { agentId: "a", groupId: "g1" }),
      entry(2, "agentJoined", {
        agentId: "a",
        groupId: "g1",
        episodeId: "a:g1:2",
      }),
      entry(2, "agentJoined", {
        agentId: "b",
        groupId: "g1",
        episodeId: "b:g1:2",
      }),
      entry(10, "agentJoined", {
        agentId: "oj",
        groupId: "g1",
        episodeId: "oj:g1:10",
      }),
      entry(20, "clusterDepartureCompleted", {
        agentId: "a",
        groupId: "g1",
        episodeId: "a:g1:2",
        ticksInCluster: 18,
        episodeEndReason: "voluntaryDeparture",
        transitionAction: "departAndExplore",
      }),
    ],
    width: 800,
    height: 520,
    finished: false,
    formationScenarioId: "standingParty",
    ...overrides,
  };
}

function renderDashboard(state: SimulationState, props: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(StandingPartyAnalyticsDashboard, {
      state,
      params: DEFAULT_PARAMS,
      presetId: "standing-party-natural",
      standingPartyConfig: DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
      ...props,
    }),
  );
}

describe("analyticsDashboardFormat", () => {
  it("empty分布と分母0を0と捏造しない", () => {
    expect(formatDistribution({ count: 0 })).toContain("非該当");
    expect(formatRate({ numerator: 0, denominator: 0 })).toContain("非該当");
  });

  it("長時間runで時系列を間引く", () => {
    expect(chooseSeriesSampleInterval(0, 100)).toBe(1);
    expect(chooseSeriesSampleInterval(0, 600)).toBeGreaterThan(1);
  });
});

describe("StandingPartyAnalyticsDashboard (Issue #217)", () => {
  it("overview / filter / export / chart領域を描画する", () => {
    const html = renderDashboard(makeState());
    expect(html).toContain('data-testid="analytics-dashboard"');
    expect(html).toContain('data-testid="analytics-overview"');
    expect(html).toContain('data-testid="analytics-filters"');
    expect(html).toContain('data-testid="analytics-export-json"');
    expect(html).toContain('data-testid="analytics-export-csv"');
    expect(html).toContain('data-testid="analytics-charts"');
    expect(html).toContain('data-testid="analytics-dwell-dist"');
    expect(html).toContain('data-testid="analytics-oj-comparison"');
    expect(html).toContain("友人数ではない");
  });

  it("empty runでもクラッシュせず件数0を示す", () => {
    const html = renderDashboard(
      makeState({
        tick: 0,
        agents: [makeAgent({ id: "solo", label: "S" })],
        groupCandidates: [],
        log: [],
      }),
    );
    expect(html).toContain('data-testid="analytics-dashboard"');
    expect(html).toContain("完了サンプルなし");
  });

  it("単一agent filter propsでも描画できる", () => {
    const html = renderDashboard(makeState(), { selectedAgentId: "oj" });
    expect(html).toContain('data-testid="analytics-agent-filter"');
    expect(html).toContain('value="oj"');
  });

  it("代替table切替ボタンとdrill-downボタンがある", () => {
    const html = renderDashboard(makeState());
    expect(html).toContain('data-testid="analytics-view-tables"');
    expect(html).toContain('data-testid="analytics-drilldown"');
  });

  it("人格評価やランキング表現を使わない", () => {
    const html = renderDashboard(makeState());
    expect(html).not.toContain("ランキング");
    expect(html).not.toContain("人気者");
    expect(html).toContain("友人数や人気ではありません");
  });
});
