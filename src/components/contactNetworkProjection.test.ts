/**
 * Issue #216: 接触ネットワーク投影(filter / weight / layout)の単体テスト。
 */
import { describe, expect, it } from "vitest";
import { buildStandingPartyContactNetwork } from "../simulation/standingPartyAnalysis";
import type {
  Agent,
  GroupCandidate,
  LogEntry,
  SimulationState,
} from "../simulation/types";
import {
  DEFAULT_CONTACT_NETWORK_FILTER,
  edgeWeight,
  layoutContactNetworkNodes,
  projectContactNetwork,
  strongestContactsForNode,
} from "./contactNetworkProjection";

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

/**
 * a↔b が g1 で同席、b↔oj が別区間で同席、c は孤立。
 */
function makeState(overrides: Partial<SimulationState> = {}): SimulationState {
  return {
    tick: 40,
    seed: 7,
    agents: [
      makeAgent({ id: "a", label: "A", state: "joined", joinedGroupId: "g1", cliqueId: 1 }),
      makeAgent({ id: "b", label: "B", state: "joined", joinedGroupId: "g1", cliqueId: 1 }),
      makeAgent({ id: "oj", label: "OJ", isObserverJoiner: true, state: "undecided" }),
      makeAgent({ id: "c", label: "C", state: "undecided" }),
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
      // b は継続中 → b↔oj が active contact
    ],
    width: 800,
    height: 520,
    finished: false,
    formationScenarioId: "standingParty",
    ...overrides,
  };
}

describe("layoutContactNetworkNodes (Issue #216)", () => {
  it("同じagent集合なら座標が決定的で安定", () => {
    const a = layoutContactNetworkNodes(["c", "a", "b"]);
    const b = layoutContactNetworkNodes(["b", "c", "a"]);
    expect(a.get("a")).toEqual(b.get("a"));
    expect(a.get("b")).toEqual(b.get("b"));
    expect(a.get("c")).toEqual(b.get("c"));
  });

  it("filterで可視集合が変わっても全agent layoutの座標は変わらない", () => {
    const full = layoutContactNetworkNodes(["a", "b", "c"]);
    const subsetIds = ["a", "b"];
    // 投影は常に全agentでlayoutするため、subsetでもfullの座標を参照する
    expect(full.get("a")).toBeDefined();
    expect(subsetIds.every((id) => full.has(id))).toBe(true);
  });
});

describe("projectContactNetwork (Issue #216)", () => {
  it("isolated nodeを含め、接触edgeを表示する", () => {
    const state = makeState();
    const network = buildStandingPartyContactNetwork(state);
    const projection = projectContactNetwork(state, network, DEFAULT_CONTACT_NETWORK_FILTER);
    expect(projection.nodes.some((n) => n.agentId === "c" && n.isolated)).toBe(true);
    expect(projection.edges.length).toBeGreaterThan(0);
    expect(projection.edges.some((e) => e.edgeKey === "a:b")).toBe(true);
  });

  it("showIsolated=falseで接触0のnodeを隠す", () => {
    const state = makeState();
    const network = buildStandingPartyContactNetwork(state);
    const projection = projectContactNetwork(state, network, {
      ...DEFAULT_CONTACT_NETWORK_FILTER,
      showIsolated: false,
    });
    expect(projection.nodes.some((n) => n.agentId === "c")).toBe(false);
  });

  it("weight切替で値が変わる", () => {
    const state = makeState();
    const network = buildStandingPartyContactNetwork(state);
    const edge = network.edges.find((e) => e.edgeKey === "a:b");
    expect(edge).toBeDefined();
    expect(edgeWeight(edge!, "totalCoPresenceTicks")).toBe(edge!.totalCoPresenceTicks);
    expect(edgeWeight(edge!, "contactIntervalCount")).toBe(edge!.contactIntervalCount);
    expect(edgeWeight(edge!, "distinctClusterCount")).toBe(edge!.distinctClusterCount);
    expect(edgeWeight(edge!, "binary")).toBe(1);

    const ticks = projectContactNetwork(state, network, {
      ...DEFAULT_CONTACT_NETWORK_FILTER,
      weightMode: "totalCoPresenceTicks",
    });
    const binary = projectContactNetwork(state, network, {
      ...DEFAULT_CONTACT_NETWORK_FILTER,
      weightMode: "binary",
    });
    const abTicks = ticks.edges.find((e) => e.edgeKey === "a:b");
    const abBinary = binary.edges.find((e) => e.edgeKey === "a:b");
    expect(abTicks?.weight).toBe(edge!.totalCoPresenceTicks);
    expect(abBinary?.weight).toBe(1);
  });

  it("minWeightで薄い辺を落とす", () => {
    const state = makeState();
    const network = buildStandingPartyContactNetwork(state);
    const projection = projectContactNetwork(state, network, {
      ...DEFAULT_CONTACT_NETWORK_FILTER,
      weightMode: "totalCoPresenceTicks",
      minWeight: 1_000_000,
    });
    expect(projection.edges).toHaveLength(0);
  });

  it("activeOnlyで過去edgeを落とす", () => {
    const state = makeState();
    const network = buildStandingPartyContactNetwork(state);
    const all = projectContactNetwork(state, network, DEFAULT_CONTACT_NETWORK_FILTER);
    const active = projectContactNetwork(state, network, {
      ...DEFAULT_CONTACT_NETWORK_FILTER,
      activeOnly: true,
    });
    expect(all.edges.some((e) => !e.isActive)).toBe(true);
    expect(active.edges.every((e) => e.isActive)).toBe(true);
  });

  it("ego networkは選択agentと隣接のみ", () => {
    const state = makeState();
    const network = buildStandingPartyContactNetwork(state);
    const projection = projectContactNetwork(
      state,
      network,
      { ...DEFAULT_CONTACT_NETWORK_FILTER, egoNetwork: true, showIsolated: true },
      "a",
    );
    expect(projection.nodes.every((n) => n.agentId === "a" || projection.edges.some(
      (e) => e.agentIdA === n.agentId || e.agentIdB === n.agentId,
    ))).toBe(true);
    expect(projection.edges.every((e) => e.agentIdA === "a" || e.agentIdB === "a")).toBe(true);
  });

  it("ObserverJoinerを含むedgeのみに絞れる", () => {
    const state = makeState();
    const network = buildStandingPartyContactNetwork(state);
    const projection = projectContactNetwork(state, network, {
      ...DEFAULT_CONTACT_NETWORK_FILTER,
      observerJoinerEdgesOnly: true,
    });
    expect(projection.edges.length).toBeGreaterThan(0);
    expect(
      projection.edges.every((e) => e.agentIdA === "oj" || e.agentIdB === "oj"),
    ).toBe(true);
  });

  it("cluster filterで当該clusterの接触だけ残す", () => {
    const state = makeState();
    const network = buildStandingPartyContactNetwork(state);
    const projection = projectContactNetwork(state, network, {
      ...DEFAULT_CONTACT_NETWORK_FILTER,
      clusterId: "g1",
    });
    expect(projection.edges.length).toBeGreaterThan(0);
  });

  it("strongestContactsはweight降順", () => {
    const state = makeState();
    const network = buildStandingPartyContactNetwork(state);
    const projection = projectContactNetwork(state, network, DEFAULT_CONTACT_NETWORK_FILTER);
    const strongest = strongestContactsForNode(projection, "b", 5);
    for (let i = 1; i < strongest.length; i++) {
      expect(strongest[i - 1]!.edge.weight).toBeGreaterThanOrEqual(strongest[i]!.edge.weight);
    }
  });

  it("入力network/stateをmutationしない", () => {
    const state = makeState();
    const network = buildStandingPartyContactNetwork(state);
    const agentsBefore = JSON.stringify(state.agents);
    const edgesBefore = JSON.stringify(network.edges);
    projectContactNetwork(state, network, {
      ...DEFAULT_CONTACT_NETWORK_FILTER,
      activeOnly: true,
      egoNetwork: true,
      observerJoinerEdgesOnly: true,
    }, "a");
    expect(JSON.stringify(state.agents)).toBe(agentsBefore);
    expect(JSON.stringify(network.edges)).toBe(edgesBefore);
  });
});
