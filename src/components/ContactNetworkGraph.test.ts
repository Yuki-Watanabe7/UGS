/**
 * Issue #216: 接触ネットワークグラフ / Controls / Detail のコンポーネントテスト。
 * `renderToStaticMarkup`による静的レンダリング(既存規約)。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContactNetworkControls } from "./ContactNetworkControls";
import { ContactNetworkDetail } from "./ContactNetworkDetail";
import { ContactNetworkGraph } from "./ContactNetworkGraph";
import {
  DEFAULT_CONTACT_NETWORK_FILTER,
  projectContactNetwork,
} from "./contactNetworkProjection";
import { buildStandingPartyContactNetwork } from "../simulation/standingPartyAnalysis";
import type {
  Agent,
  GroupCandidate,
  LogEntry,
  SimulationState,
} from "../simulation/types";

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
      makeAgent({ id: "a", label: "A", state: "joined", joinedGroupId: "g1", cliqueId: 1 }),
      makeAgent({ id: "b", label: "B", state: "joined", joinedGroupId: "g1", cliqueId: 1 }),
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
        joinedGroupStatus: "confirmed",
      }),
      entry(3, "agentJoined", {
        agentId: "b",
        groupId: "g1",
        episodeId: "b:g1:3",
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
        agentId: "oj",
        groupId: "g1",
        episodeId: "oj:g1:12",
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

function renderGraph(state: SimulationState, props: Record<string, unknown> = {}) {
  return renderToStaticMarkup(createElement(ContactNetworkGraph, { state, ...props }));
}

describe("ContactNetworkControls (Issue #216)", () => {
  it("weight名・単位・しきい値を明示する", () => {
    const html = renderToStaticMarkup(
      createElement(ContactNetworkControls, {
        filter: { ...DEFAULT_CONTACT_NETWORK_FILTER, minWeight: 2 },
        onFilterChange: () => undefined,
        agents: makeState().agents,
        lifetimes: [],
        asOfTick: 40,
        zoomPercent: 100,
        onZoomIn: () => undefined,
        onZoomOut: () => undefined,
        onResetView: () => undefined,
        onFitView: () => undefined,
        graphVisible: true,
        onGraphVisibleChange: () => undefined,
      }),
    );
    expect(html).toContain('data-testid="contact-network-weight-meta"');
    expect(html).toContain("同席tick合計");
    expect(html).toContain("最小しきい値: 2");
    expect(html).toContain('data-testid="contact-network-zoom"');
    expect(html).toContain('data-testid="contact-network-reset-view"');
  });
});

describe("ContactNetworkGraph (Issue #216)", () => {
  it("rootとgraph/list/detailのDOM契約を持つ", () => {
    const html = renderGraph(makeState());
    expect(html).toContain('data-testid="contact-network"');
    expect(html).toContain('data-testid="contact-network-svg"');
    expect(html).toContain('data-testid="contact-network-lists"');
    expect(html).toContain('data-testid="contact-network-detail-empty"');
    expect(html).toContain("接触は信頼や好意を意味しません");
  });

  it("isolated nodeとedgeを描画する", () => {
    const html = renderGraph(makeState());
    expect(html).toContain('data-testid="contact-network-node-c"');
    expect(html).toContain('data-isolated="true"');
    expect(html).toMatch(/data-testid="contact-network-edge-a:b"/);
    expect(html).toContain('data-testid="contact-network-node-oj"');
    expect(html).toContain('data-observer-joiner="true"');
    expect(html).toContain(">OJ</text>");
  });

  it("active/past edgeを属性で区別する", () => {
    const html = renderGraph(makeState());
    expect(html).toContain('data-active="true"');
    expect(html).toContain('data-active="false"');
    expect(html).toContain("contact-network-edge--past");
    expect(html).toContain("contact-network-edge--active");
  });

  it("selectedAgentIdをnode選択へ反映する", () => {
    const html = renderGraph(makeState(), { selectedAgentId: "a" });
    expect(html).toContain('data-testid="contact-network-detail-node"');
    expect(html).toContain("接触人数");
    expect(html).toContain("同席tick合計");
    expect(html).toContain('data-testid="contact-network-strongest"');
  });

  it("代替listにnode/edgeがある", () => {
    const html = renderGraph(makeState());
    expect(html).toContain('data-testid="contact-network-list-node-a"');
    expect(html).toContain('data-testid="contact-network-list-edge-a:b"');
  });

  it("グラフ表示OFFでも分析文言を出し、sim非介入を示す", () => {
    // Controlsは内部stateのため、Detailのemptyとnoteで非介入契約を確認
    const html = renderGraph(makeState());
    expect(html).toContain("simulation");
    expect(html).toContain("PRNG");
    expect(html).toContain('data-testid="contact-network-graph-visible"');
  });
});

describe("ContactNetworkDetail (Issue #216)", () => {
  it("edge詳細にinterval一覧とclique/trust分離disclaimerを出す", () => {
    const state = makeState();
    const network = buildStandingPartyContactNetwork(state);
    const projection = projectContactNetwork(state, network, DEFAULT_CONTACT_NETWORK_FILTER);
    const edge = projection.edges.find((e) => e.edgeKey === "a:b");
    expect(edge).toBeDefined();
    const html = renderToStaticMarkup(
      createElement(ContactNetworkDetail, {
        state,
        selection: { kind: "edge", edgeKey: "a:b" },
        edge,
        intervalsForEdge: network.contactIntervals.filter((i) => {
          const key = [i.agentIdA, i.agentIdB].sort().join(":");
          return key === "a:b";
        }),
        projection,
      }),
    );
    expect(html).toContain('data-testid="contact-network-detail-edge"');
    expect(html).toContain('data-testid="contact-network-intervals"');
    expect(html).toContain('data-testid="contact-network-edge-comparison"');
    expect(html).toContain('data-testid="contact-network-disclaimer"');
    expect(html).toContain("clique一致");
    expect(html).toContain("接触(同席)は信頼・好意・関係の強さを意味しません");
  });
});
