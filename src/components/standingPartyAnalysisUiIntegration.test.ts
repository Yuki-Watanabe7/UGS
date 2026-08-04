/**
 * Issue #218 (component integration): Timeline / Network / Dashboard の共通選択・
 * tick filter・export数値が同じ導出結果を指すこと、および mount しても分析結果が
 * 変わらないことを`renderToStaticMarkup`で固定する。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationHistoryTimeline } from "./ConversationHistoryTimeline";
import { ContactNetworkGraph } from "./ContactNetworkGraph";
import { StandingPartyAnalyticsDashboard } from "./StandingPartyAnalyticsDashboard";
import {
  buildStandingPartyAnalysisExport,
  serializeStandingPartyAnalysisExport,
} from "../simulation/analysisExport";
import {
  buildStandingPartyContactNetwork,
  buildStandingPartyConversationHistory,
  buildStandingPartyRunStatistics,
} from "../simulation/standingPartyAnalysis";
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

function makeState(): SimulationState {
  return {
    tick: 40,
    seed: 7,
    agents: [
      makeAgent({
        id: "a",
        label: "A",
        state: "joined",
        joinedGroupId: "g1",
        currentEpisode: {
          episodeId: "a:g1:2",
          clusterId: "g1",
          joinedAtTick: 2,
          lastUpdatedTick: 40,
          memberCountAtJoin: 1,
          lastObservedMemberCount: 2,
        },
      }),
      makeAgent({
        id: "b",
        label: "B",
        state: "joined",
        joinedGroupId: "g1",
        currentEpisode: {
          episodeId: "b:g1:2",
          clusterId: "g1",
          joinedAtTick: 2,
          lastUpdatedTick: 40,
          memberCountAtJoin: 2,
          lastObservedMemberCount: 2,
        },
      }),
      makeAgent({ id: "oj", label: "OJ", isObserverJoiner: true }),
    ],
    groupCandidates: [makeCandidate({ id: "g1", memberIds: ["a", "b"] })],
    log: [
      entry(1, "nucleusCreated", { agentId: "a", groupId: "g1" }),
      entry(2, "groupConfirmed", { groupId: "g1", memberCount: 1 }),
      entry(2, "agentJoined", {
        agentId: "b",
        groupId: "g1",
        episodeId: "b:g1:2",
        joinedGroupStatus: "confirmed",
      }),
    ],
    width: 800,
    height: 520,
    finished: false,
    formationScenarioId: "standingParty",
  };
}

describe("standingParty Phase 4 UI integration (Issue #218)", () => {
  it("共通のselectedAgentId / selectedClusterId / tick窓が3パネルのmarkupへ反映される", () => {
    const state = makeState();
    const selectedAgentId = "a";
    const selectedClusterId = "g1";
    const linkedTickWindow = { fromTick: 0, toTick: 40 };

    const timelineHtml = renderToStaticMarkup(
      createElement(ConversationHistoryTimeline, {
        state,
        selectedAgentId,
        selectedClusterId,
        linkedTickWindow,
      }),
    );
    const networkHtml = renderToStaticMarkup(
      createElement(ContactNetworkGraph, {
        state,
        selectedAgentId,
        selectedClusterId,
      }),
    );
    const dashboardHtml = renderToStaticMarkup(
      createElement(StandingPartyAnalyticsDashboard, {
        state,
        params: DEFAULT_PARAMS,
        presetId: "standing-party",
        standingPartyConfig: DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
        selectedAgentId,
        selectedClusterId,
      }),
    );

    expect(timelineHtml).toContain('data-testid="conversation-history"');
    expect(timelineHtml).toContain('data-testid="conversation-history-episode-a:g1:2"');
    expect(networkHtml).toContain('data-testid="contact-network"');
    expect(networkHtml).toContain('data-testid="contact-network-node-a"');
    expect(dashboardHtml).toContain('data-testid="analytics-dashboard"');
    expect(dashboardHtml).toContain('data-testid="analytics-overview"');
    // exportボタンが到達可能
    expect(dashboardHtml).toContain('data-testid="analytics-export-json"');
    expect(dashboardHtml).toContain('data-testid="analytics-export-csv"');
  });

  it("UI mount前後でanalysis/exportの決定的結果が変わらない", () => {
    const state = makeState();
    const beforeHistory = buildStandingPartyConversationHistory(state);
    const beforeNetwork = buildStandingPartyContactNetwork(state, { history: beforeHistory });
    const beforeStats = buildStandingPartyRunStatistics(state, {
      history: beforeHistory,
      network: beforeNetwork,
    });
    const beforeExport = serializeStandingPartyAnalysisExport(
      buildStandingPartyAnalysisExport(state, {
        history: beforeHistory,
        network: beforeNetwork,
        statistics: beforeStats,
      }),
    );

    // mount相当: 3パネルを描画(SSR)
    renderToStaticMarkup(createElement(ConversationHistoryTimeline, { state }));
    renderToStaticMarkup(createElement(ContactNetworkGraph, { state }));
    renderToStaticMarkup(
      createElement(StandingPartyAnalyticsDashboard, {
        state,
        params: DEFAULT_PARAMS,
        presetId: "standing-party",
        standingPartyConfig: DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
      }),
    );

    const afterHistory = buildStandingPartyConversationHistory(state);
    const afterNetwork = buildStandingPartyContactNetwork(state, { history: afterHistory });
    const afterStats = buildStandingPartyRunStatistics(state, {
      history: afterHistory,
      network: afterNetwork,
    });
    const afterExport = serializeStandingPartyAnalysisExport(
      buildStandingPartyAnalysisExport(state, {
        history: afterHistory,
        network: afterNetwork,
        statistics: afterStats,
      }),
    );

    expect(afterHistory).toEqual(beforeHistory);
    expect(afterNetwork).toEqual(beforeNetwork);
    expect(afterStats).toEqual(beforeStats);
    expect(afterExport).toBe(beforeExport);
  });

  it("dashboard overviewに表示する集計値がexport statisticsと一致する", () => {
    const state = makeState();
    const history = buildStandingPartyConversationHistory(state);
    const network = buildStandingPartyContactNetwork(state, { history });
    const statistics = buildStandingPartyRunStatistics(state, { history, network });
    const bundle = buildStandingPartyAnalysisExport(state, { history, network, statistics });

    const html = renderToStaticMarkup(
      createElement(StandingPartyAnalyticsDashboard, {
        state,
        params: DEFAULT_PARAMS,
        presetId: "standing-party",
        standingPartyConfig: DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
      }),
    );

    const run = bundle.statistics.run;
    expect(html).toContain(`完了 ${run.completedEpisodeCount}`);
    expect(html).toContain(`進行中 ${run.activeEpisodeCount}`);
    expect(html).toContain(`unique edge ${run.network.edgeCount}`);
    expect(html).toContain(`自発離脱 ${run.voluntaryDepartureCount}`);
    expect(html).toContain(`強制release ${run.forcedReleaseCount}`);
  });

  it("empty / single-node相当でも崩れたmarkupを出さない", () => {
    const empty: SimulationState = {
      tick: 0,
      seed: 1,
      agents: [makeAgent({ id: "solo", label: "Solo" })],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
      formationScenarioId: "standingParty",
    };
    const html = renderToStaticMarkup(createElement(ContactNetworkGraph, { state: empty }));
    expect(html).toContain('data-testid="contact-network"');
    expect(html).toContain("edges 0");
  });
});
