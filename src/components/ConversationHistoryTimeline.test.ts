/**
 * Issue #215: 会話履歴タイムライン / Filters / Detail のコンポーネントテスト。
 * `renderToStaticMarkup`による静的レンダリング(既存規約。Testing Libraryは未導入)。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationHistoryDetail } from "./ConversationHistoryDetail";
import { ConversationHistoryFilters } from "./ConversationHistoryFilters";
import { ConversationHistoryTimeline } from "./ConversationHistoryTimeline";
import type {
  Agent,
  ClusterLifetimeRecord,
  ConversationEpisodeRecord,
  GroupCandidate,
  LogEntry,
  SimulationState,
} from "../simulation/types";
import type { ConversationHistoryViewFilter } from "./conversationHistoryProjection";

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
    memberIds: ["a"],
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
    tick: 30,
    seed: 42,
    agents: [
      makeAgent({ id: "a", label: "A", state: "joined", joinedGroupId: "g1" }),
      makeAgent({ id: "oj", label: "OJ", isObserverJoiner: true }),
    ],
    groupCandidates: [makeCandidate({ id: "g1", memberIds: ["a"] })],
    log: [
      entry(1, "nucleusCreated", { agentId: "a", groupId: "g1" }),
      entry(2, "agentJoined", {
        agentId: "a",
        groupId: "g1",
        episodeId: "a:g1:2",
        joinedGroupStatus: "confirmed",
      }),
      entry(10, "clusterDepartureCompleted", {
        agentId: "a",
        groupId: "g1",
        episodeId: "a:g1:2",
        episodeEndReason: "voluntaryDeparture",
        ticksInCluster: 8,
      }),
      entry(12, "agentJoined", {
        agentId: "a",
        groupId: "g1",
        episodeId: "a:g1:12",
        joinedGroupStatus: "confirmed",
      }),
      entry(20, "clusterMemberReleased", {
        agentId: "a",
        groupId: "g1",
        episodeId: "a:g1:12",
        episodeEndReason: "memberReleased",
        ticksInCluster: 8,
      }),
      entry(21, "agentJoined", {
        agentId: "oj",
        groupId: "g1",
        episodeId: "oj:g1:21",
        joinedGroupStatus: "confirmed",
      }),
    ],
    width: 800,
    height: 520,
    finished: false,
    formationScenarioId: "standingParty",
    ...overrides,
  };
}

function renderTimeline(state: SimulationState, props: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(ConversationHistoryTimeline, { state, ...props }),
  );
}

describe("ConversationHistoryFilters (Issue #215)", () => {
  const baseFilter: ConversationHistoryViewFilter = {
    mode: "agent",
    fromTick: 0,
    toTick: 30,
  };

  it("agent / cluster mode切替のselectと主要filterを描画する", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationHistoryFilters, {
        filter: baseFilter,
        onFilterChange: () => {},
        agents: [makeAgent({ id: "a", label: "A" })],
        lifetimes: [
          {
            clusterId: "g1",
            createdAtTick: 1,
            status: "active",
            peakMemberCount: 1,
            joinCount: 1,
            voluntaryLeaveCount: 0,
            forcedReleaseCount: 0,
          } satisfies ClusterLifetimeRecord,
        ],
        asOfTick: 30,
      }),
    );
    expect(html).toContain('data-testid="conversation-history-mode"');
    expect(html).toContain("agent timeline");
    expect(html).toContain("cluster timeline");
    expect(html).toContain('data-testid="conversation-history-agent-filter"');
    expect(html).toContain('data-testid="conversation-history-cluster-filter"');
    expect(html).toContain('data-testid="conversation-history-departure-kind"');
    expect(html).toContain("自発離脱のみ");
    expect(html).toContain("強制releaseのみ");
    expect(html).toContain("目的地付き遷移のみ");
    expect(html).toContain('data-testid="conversation-history-oj-only"');
  });

  it("cluster modeの選択値を反映する", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationHistoryFilters, {
        filter: { ...baseFilter, mode: "cluster" },
        onFilterChange: () => {},
        agents: [],
        lifetimes: [],
        asOfTick: 10,
      }),
    );
    const modeTagStart = html.indexOf('data-testid="conversation-history-mode"');
    const modeTag = html.slice(html.lastIndexOf("<select", modeTagStart), html.indexOf("</select>", modeTagStart));
    expect(modeTag).toContain('value="cluster"');
  });
});

describe("ConversationHistoryDetail (Issue #215)", () => {
  it("未選択時はempty stateとreplay境界の注記を出す", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationHistoryDetail, {
        state: makeState(),
        selection: undefined,
      }),
    );
    expect(html).toContain('data-testid="conversation-history-detail-empty"');
    expect(html).toContain("巻き戻りません");
  });

  it("undefined fieldを0や正常と捏造せず未記録・非該当で出す", () => {
    const episode: ConversationEpisodeRecord = {
      episodeId: "a:g1:2",
      agentId: "a",
      clusterId: "g1",
      startedAtTick: 2,
      dwellTicks: 5,
      status: "active",
      joinedGroupStatus: "confirmed",
      startMemberIds: ["a"],
    };
    const html = renderToStaticMarkup(
      createElement(ConversationHistoryDetail, {
        state: makeState(),
        selection: { kind: "episode", id: episode.episodeId },
        episode,
      }),
    );
    expect(html).toContain('data-testid="conversation-history-detail-episode"');
    expect(html).toContain("非該当(進行中)");
    expect(html).toContain("未記録");
    expect(html).not.toContain(">0</span></div><div class=\"conversation-history-detail-row\"><span>終了理由</span>");
  });

  it("voluntary / forced をラベルで区別する", () => {
    const voluntary: ConversationEpisodeRecord = {
      episodeId: "a:g1:2",
      agentId: "a",
      clusterId: "g1",
      startedAtTick: 2,
      endedAtTick: 10,
      dwellTicks: 8,
      status: "completed",
      endReason: "voluntaryDeparture",
      joinedGroupStatus: "confirmed",
      startMemberIds: ["a"],
      endMemberIds: ["a"],
    };
    const html = renderToStaticMarkup(
      createElement(ConversationHistoryDetail, {
        state: makeState(),
        selection: { kind: "episode", id: voluntary.episodeId },
        episode: voluntary,
      }),
    );
    expect(html).toContain("自発離脱");
  });
});

describe("ConversationHistoryTimeline (Issue #215)", () => {
  it("standingParty履歴からagent laneとepisode区間を描画する", () => {
    const html = renderTimeline(makeState());
    expect(html).toContain('data-testid="conversation-history"');
    expect(html).toContain('data-testid="conversation-history-tracks"');
    expect(html).toContain("conversation-history-episode-a:g1:2");
    expect(html).toContain("conversation-history-episode-a:g1:12");
    expect(html).toContain('data-end-reason="voluntaryDeparture"');
    expect(html).toContain('data-end-reason="memberReleased"');
    expect(html).toContain('data-testid="conversation-history-tick-marker"');
  });

  it("同一clusterへの再参加を別区間として描画する", () => {
    const html = renderTimeline(makeState());
    expect(html).toContain("a:g1:2");
    expect(html).toContain("a:g1:12");
  });

  it("履歴が無いときempty stateを出す", () => {
    const html = renderTimeline(
      makeState({
        tick: 0,
        agents: [makeAgent({ id: "a", label: "A" })],
        groupCandidates: [],
        log: [],
      }),
    );
    expect(html).toContain('data-testid="conversation-history-empty"');
  });

  it("selectedAgentIdをagent filterの初期値へ反映する(Canvas/Inspector同期)", () => {
    const html = renderTimeline(makeState(), { selectedAgentId: "oj" });
    const agentFilterIdx = html.indexOf('data-testid="conversation-history-agent-filter"');
    const tagStart = html.lastIndexOf("<select", agentFilterIdx);
    const tagEnd = html.indexOf("</select>", agentFilterIdx);
    const selectHtml = html.slice(tagStart, tagEnd);
    expect(selectHtml).toContain('value="oj"');
  });

  it("主要DOM契約(折りたたみ・filter・axis・detail)を持つ", () => {
    const html = renderTimeline(makeState());
    expect(html).toContain("<details");
    expect(html).toContain('data-testid="conversation-history-filters"');
    expect(html).toContain('data-testid="conversation-history-axis"');
    expect(html).toContain('data-testid="conversation-history-detail-empty"');
    expect(html).toContain("aria-label");
  });

  it("afterPartyのstateでもクラッシュせず空に近い表示になる", () => {
    const html = renderTimeline(
      makeState({
        formationScenarioId: "afterParty",
        log: [],
        groupCandidates: [],
        agents: [makeAgent({ id: "a" })],
      }),
    );
    expect(html).toContain('data-testid="conversation-history"');
    expect(html).toContain('data-testid="conversation-history-empty"');
  });
});
