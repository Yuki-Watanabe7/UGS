/**
 * Issue #213: standing-party Phase 4 接触ネットワーク read model
 * (`deriveContactIntervals` / `buildStandingPartyContactNetwork`)の単体・結合テスト。
 * membership区間の時間重複のみを正本とし、clique/trust/tie・接近・空間近接は接触に数えない。
 */
import { describe, expect, it } from "vitest";
import {
  assertContactDerivationOrderIndependent,
  assertContactNetworkDoesNotMutateState,
  buildContactNetworkFromHistory,
  buildStandingPartyContactNetwork,
  buildStandingPartyContactNetworkMemoized,
  buildStandingPartyConversationHistory,
  createContactIntervalId,
  createContactNetworkEdgeKey,
  deriveContactIntervals,
  detectOverlappingMultiClusterMembership,
} from "./standingPartyAnalysis";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS } from "./presets";
import type { FormationRuntimeOptions } from "./formationPolicy";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG } from "./standingPartyScenarioConfig";
import type {
  Agent,
  ClusterMembershipInterval,
  GroupCandidate,
  LogEntry,
  SimParams,
  SimulationState,
} from "./types";
import { STANDING_PARTY_ANALYSIS_SCHEMA_VERSION } from "./types";

const STANDING_PARTY_RUNTIME: FormationRuntimeOptions = { scenarioId: "standingParty" };

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

function makeCandidate(overrides: Partial<GroupCandidate>): GroupCandidate {
  return {
    id: "group-1",
    x: 400,
    y: 260,
    memberIds: [],
    status: "confirmed",
    age: 0,
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
    formationScenarioId: "standingParty",
    ...overrides,
  };
}

function step(state: SimulationState, params: SimParams, rng: SeededRandom): SimulationState {
  return stepSimulation(
    state,
    params,
    rng,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    STANDING_PARTY_RUNTIME,
  );
}

function entry(
  tick: number,
  eventType: LogEntry["eventType"],
  metadata: NonNullable<LogEntry["metadata"]>,
): LogEntry {
  return { tick, message: `t=${tick}`, tags: [], eventType, metadata };
}

function membership(
  overrides: Partial<ClusterMembershipInterval> &
    Pick<ClusterMembershipInterval, "agentId" | "clusterId" | "startedAtTick">,
): ClusterMembershipInterval {
  const episodeId =
    overrides.episodeId ??
    `${overrides.agentId}:${overrides.clusterId}:${overrides.startedAtTick}`;
  return {
    intervalId: overrides.intervalId ?? episodeId,
    agentId: overrides.agentId,
    clusterId: overrides.clusterId,
    startedAtTick: overrides.startedAtTick,
    endedAtTick: overrides.endedAtTick,
    status: overrides.status ?? (overrides.endedAtTick === undefined ? "active" : "completed"),
    episodeId,
  };
}

describe("contactNetwork helpers (Issue #213)", () => {
  it("pair / contact IDを昇順正規化して決定的に生成する", () => {
    expect(createContactNetworkEdgeKey("b", "a")).toBe("a:b");
    expect(createContactNetworkEdgeKey("a", "b")).toBe("a:b");
    expect(createContactIntervalId("b", "a", "g1", 10)).toBe("a:b:g1:10");
    expect(createContactIntervalId("a", "b", "g1", 10)).toBe("a:b:g1:10");
  });
});

describe("deriveContactIntervals (Issue #213)", () => {
  it("同席membershipからpair contactを生成し、3人clusterでは全pairが重複なく出る", () => {
    const intervals = [
      membership({ agentId: "c", clusterId: "g1", startedAtTick: 5, endedAtTick: 20 }),
      membership({ agentId: "a", clusterId: "g1", startedAtTick: 5, endedAtTick: 20 }),
      membership({ agentId: "b", clusterId: "g1", startedAtTick: 5, endedAtTick: 20 }),
    ];
    const { contactIntervals } = deriveContactIntervals(intervals, { asOfTick: 30 });
    expect(contactIntervals).toHaveLength(3);
    expect(contactIntervals.map((c) => c.contactIntervalId).sort()).toEqual([
      "a:b:g1:5",
      "a:c:g1:5",
      "b:c:g1:5",
    ]);
    expect(contactIntervals.every((c) => c.dwellTicks === 15)).toBe(true);
    expect(contactIntervals.every((c) => c.status === "completed")).toBe(true);
  });

  it("再会・別cluster・再参加は別intervalとして追跡する", () => {
    const intervals = [
      membership({ agentId: "a", clusterId: "g1", startedAtTick: 0, endedAtTick: 10 }),
      membership({ agentId: "b", clusterId: "g1", startedAtTick: 0, endedAtTick: 10 }),
      // 同一clusterへ再参加
      membership({ agentId: "a", clusterId: "g1", startedAtTick: 20, endedAtTick: 30 }),
      membership({ agentId: "b", clusterId: "g1", startedAtTick: 20, endedAtTick: 30 }),
      // 別clusterで再会
      membership({ agentId: "a", clusterId: "g2", startedAtTick: 40, endedAtTick: 50 }),
      membership({ agentId: "b", clusterId: "g2", startedAtTick: 40, endedAtTick: 50 }),
    ];
    const { contactIntervals } = deriveContactIntervals(intervals, { asOfTick: 60 });
    expect(contactIntervals.map((c) => c.contactIntervalId)).toEqual([
      "a:b:g1:0",
      "a:b:g1:20",
      "a:b:g2:40",
    ]);
    const edge = buildContactNetworkFromHistory(
      makeState({
        tick: 60,
        agents: [makeAgent({ id: "a", label: "A" }), makeAgent({ id: "b", label: "B" })],
      }),
      {
        schemaVersion: STANDING_PARTY_ANALYSIS_SCHEMA_VERSION,
        asOfTick: 60,
        episodes: [],
        membershipIntervals: intervals,
        clusterLifetimes: [],
        transitions: [],
        diagnostics: [],
      },
    ).edges[0];
    expect(edge).toMatchObject({
      edgeKey: "a:b",
      totalCoPresenceTicks: 30,
      contactIntervalCount: 3,
      distinctClusterCount: 2,
      firstContactTick: 0,
      lastContactTick: 49,
      isActive: false,
    });
  });

  it("active contactと完了contactを区別し、duration 0は除外する", () => {
    const intervals = [
      membership({ agentId: "a", clusterId: "g1", startedAtTick: 10 }),
      membership({ agentId: "b", clusterId: "g1", startedAtTick: 10 }),
      // 同一tickに入って即終了 → dwell 0
      membership({ agentId: "a", clusterId: "g2", startedAtTick: 5, endedAtTick: 5 }),
      membership({ agentId: "c", clusterId: "g2", startedAtTick: 5, endedAtTick: 5 }),
    ];
    const { contactIntervals } = deriveContactIntervals(intervals, { asOfTick: 15 });
    expect(contactIntervals).toHaveLength(1);
    expect(contactIntervals[0]).toMatchObject({
      contactIntervalId: "a:b:g1:10",
      status: "active",
      dwellTicks: 5,
      endedAtTick: undefined,
    });

    const completedOnly = deriveContactIntervals(intervals, {
      asOfTick: 15,
      includeActive: false,
    });
    expect(completedOnly.contactIntervals).toHaveLength(0);
  });

  it("任意tick範囲でdurationを切り出せ、全期間と0..asOfTickが一致する", () => {
    const intervals = [
      membership({ agentId: "a", clusterId: "g1", startedAtTick: 0, endedAtTick: 100 }),
      membership({ agentId: "b", clusterId: "g1", startedAtTick: 0, endedAtTick: 100 }),
    ];
    const full = deriveContactIntervals(intervals, { asOfTick: 100, fromTick: 0, toTick: 100 });
    const defaultWindow = deriveContactIntervals(intervals, { asOfTick: 100 });
    expect(full.contactIntervals).toEqual(defaultWindow.contactIntervals);
    expect(full.contactIntervals[0].dwellTicks).toBe(100);

    const clipped = deriveContactIntervals(intervals, {
      asOfTick: 100,
      fromTick: 20,
      toTick: 50,
    });
    expect(clipped.contactIntervals).toHaveLength(1);
    expect(clipped.contactIntervals[0]).toMatchObject({
      startedAtTick: 20,
      endedAtTick: 50,
      dwellTicks: 30,
      status: "completed",
      // IDは真の開始tickを保持
      contactIntervalId: "a:b:g1:0",
    });
  });

  it("membership入力順を変えても同一結果になる", () => {
    const intervals = [
      membership({ agentId: "z", clusterId: "g1", startedAtTick: 1, endedAtTick: 8 }),
      membership({ agentId: "a", clusterId: "g1", startedAtTick: 2, endedAtTick: 9 }),
      membership({ agentId: "m", clusterId: "g1", startedAtTick: 3, endedAtTick: 7 }),
    ];
    const result = assertContactDerivationOrderIndependent(intervals, 10);
    expect(result).toHaveLength(3);
  });

  it("同一agentの複数cluster同時所属をdiagnosticとして検出する", () => {
    const intervals = [
      membership({ agentId: "a", clusterId: "g1", startedAtTick: 0, endedAtTick: 10 }),
      membership({ agentId: "a", clusterId: "g2", startedAtTick: 5, endedAtTick: 15 }),
    ];
    const diagnostics = detectOverlappingMultiClusterMembership(intervals, 20);
    expect(diagnostics.some((d) => d.code === "overlappingMultiClusterMembership")).toBe(true);
  });
});

describe("buildStandingPartyContactNetwork (Issue #213)", () => {
  it("log由来のmembershipからnetworkを構築し、接近のみは接触に数えない", () => {
    const state = makeState({
      tick: 30,
      agents: [
        makeAgent({
          id: "a",
          label: "A",
          state: "joined",
          joinedGroupId: "g1",
          isObserverJoiner: true,
          cliqueId: 1,
        }),
        makeAgent({
          id: "b",
          label: "B",
          state: "joined",
          joinedGroupId: "g1",
          cliqueId: 1,
        }),
        makeAgent({
          id: "approach-only",
          label: "P",
          state: "approaching",
          // 同じcliqueでもmembershipが無ければ接触しない
          cliqueId: 1,
        }),
      ],
      groupCandidates: [
        makeCandidate({ id: "g1", memberIds: ["a", "b"], status: "confirmed" }),
      ],
      log: [
        entry(1, "nucleusCreated", { agentId: "a", groupId: "g1" }),
        entry(2, "groupConfirmed", { groupId: "g1", memberCount: 1 }),
        entry(5, "agentJoined", {
          agentId: "b",
          groupId: "g1",
          episodeId: "b:g1:5",
          joinedGroupStatus: "confirmed",
        }),
      ],
    });

    const network = buildStandingPartyContactNetwork(state);
    expect(network.schemaVersion).toBe(STANDING_PARTY_ANALYSIS_SCHEMA_VERSION);
    expect(network.edges).toHaveLength(1);
    expect(network.edges[0].edgeKey).toBe("a:b");
    expect(network.edges[0].isActive).toBe(true);
    // approach-onlyはedgeに出ない
    expect(network.edges.every((e) => !e.edgeKey.includes("approach-only"))).toBe(true);
    expect(network.nodes).toHaveLength(3);
    const observer = network.nodes.find((n) => n.agentId === "a")!;
    expect(observer.isObserverJoiner).toBe(true);
    expect(observer.degree).toBe(1);
    expect(observer.comparisonAttributes?.cliqueId).toBe(1);
    const approachNode = network.nodes.find((n) => n.agentId === "approach-only")!;
    expect(approachNode.degree).toBe(0);
    expect(network.metrics.isolatedNodeCount).toBe(1);
    expect(network.metrics.nodeCount).toBe(3);
    expect(network.metrics.edgeCount).toBe(1);
    expect(network.metrics.density).toBeCloseTo(2 / (3 * 2), 10);
  });

  it("clique/trust/tieの有無はedge weightに混ざらない", () => {
    const log: LogEntry[] = [
      entry(1, "nucleusCreated", { agentId: "a", groupId: "g1" }),
      entry(2, "groupConfirmed", { groupId: "g1", memberCount: 1 }),
      entry(3, "agentJoined", {
        agentId: "b",
        groupId: "g1",
        episodeId: "b:g1:3",
        joinedGroupStatus: "confirmed",
      }),
    ];
    const plain = buildStandingPartyContactNetwork(
      makeState({
        tick: 10,
        agents: [
          makeAgent({ id: "a", label: "A", state: "joined", joinedGroupId: "g1" }),
          makeAgent({ id: "b", label: "B", state: "joined", joinedGroupId: "g1" }),
        ],
        groupCandidates: [makeCandidate({ id: "g1", memberIds: ["a", "b"] })],
        log,
      }),
    );
    const withRelationAttrs = buildStandingPartyContactNetwork(
      makeState({
        tick: 10,
        agents: [
          makeAgent({
            id: "a",
            label: "A",
            state: "joined",
            joinedGroupId: "g1",
            cliqueId: 9,
          }),
          makeAgent({
            id: "b",
            label: "B",
            state: "joined",
            joinedGroupId: "g1",
            cliqueId: 9,
          }),
        ],
        groupCandidates: [makeCandidate({ id: "g1", memberIds: ["a", "b"] })],
        log,
        speechTrustEnabled: true,
        relationshipTieEnabled: true,
        speechTrustUpdateLog: [
          {
            id: "trust-1",
            tick: 5,
            observerId: "a",
            speakerId: "b",
            speechEventId: "s1",
            intent: "invite",
            observedFromState: "undecided",
            observedToState: "approaching",
            observation: "consistent",
            distance: 10,
            previousTrust: 0.5,
            newTrust: 0.9,
            delta: 0.4,
          },
        ],
        relationshipTieUpdateLog: [
          {
            id: "tie-1",
            tick: 5,
            observerId: "a",
            speakerId: "b",
            speechEventId: "s1",
            intent: "invite",
            observedFromState: "undecided",
            observedToState: "approaching",
            observation: "consistent",
            distance: 10,
            previousCorrection: 0,
            newCorrection: 0.1,
            delta: 0.1,
            historySize: 1,
          },
        ],
      }),
    );

    expect(plain.edges[0].totalCoPresenceTicks).toBe(
      withRelationAttrs.edges[0].totalCoPresenceTicks,
    );
    expect(plain.edges[0].contactIntervalCount).toBe(
      withRelationAttrs.edges[0].contactIntervalCount,
    );
    expect(withRelationAttrs.nodes.find((n) => n.agentId === "a")?.comparisonAttributes).toEqual({
      cliqueId: 9,
    });
  });

  it("stateをmutationせず、同一入力で同一結果・memo化でも変わらない", () => {
    const state = makeState({
      tick: 12,
      agents: [
        makeAgent({ id: "a", label: "A", state: "joined", joinedGroupId: "g1" }),
        makeAgent({ id: "b", label: "B", state: "joined", joinedGroupId: "g1" }),
      ],
      groupCandidates: [makeCandidate({ id: "g1", memberIds: ["a", "b"] })],
      log: [
        entry(2, "agentJoined", {
          agentId: "a",
          groupId: "g1",
          episodeId: "a:g1:2",
          joinedGroupStatus: "confirmed",
        }),
        entry(2, "agentJoined", {
          agentId: "b",
          groupId: "g1",
          episodeId: "b:g1:2",
          joinedGroupStatus: "confirmed",
        }),
      ],
    });
    const history = buildStandingPartyConversationHistory(state);
    const network = assertContactNetworkDoesNotMutateState(state, history);
    expect(network.edges).toHaveLength(1);

    const first = buildStandingPartyContactNetworkMemoized(state);
    const second = buildStandingPartyContactNetworkMemoized(state);
    expect(first).toBe(second);
    expect(first).toEqual(buildStandingPartyContactNetwork(state));
  });

  it("agent subset / minDuration フィルタが効く", () => {
    const intervals = [
      membership({ agentId: "a", clusterId: "g1", startedAtTick: 0, endedAtTick: 50 }),
      membership({ agentId: "b", clusterId: "g1", startedAtTick: 0, endedAtTick: 50 }),
      membership({ agentId: "c", clusterId: "g1", startedAtTick: 0, endedAtTick: 2 }),
    ];
    const state = makeState({
      tick: 50,
      agents: [
        makeAgent({ id: "a", label: "A" }),
        makeAgent({ id: "b", label: "B" }),
        makeAgent({ id: "c", label: "C" }),
      ],
    });
    const history = {
      schemaVersion: STANDING_PARTY_ANALYSIS_SCHEMA_VERSION,
      asOfTick: 50,
      episodes: [],
      membershipIntervals: intervals,
      clusterLifetimes: [],
      transitions: [],
      diagnostics: [],
    };

    const subset = buildContactNetworkFromHistory(state, history, {
      agentIds: ["a", "b"],
    });
    expect(subset.nodes.map((n) => n.agentId)).toEqual(["a", "b"]);
    expect(subset.edges).toHaveLength(1);

    const minDur = buildContactNetworkFromHistory(state, history, {
      minDurationTicks: 10,
    });
    // a-c / b-c は dwell 2 で落ち、a-bのみ残る
    expect(minDur.edges.map((e) => e.edgeKey)).toEqual(["a:b"]);
  });

  it("engine結合: standingParty runでもPRNG系列を消費せずnetworkを導出できる", () => {
    const params: SimParams = {
      ...DEFAULT_PARAMS,
      populationSize: 12,
      numLeaders: 2,
    };
    let state = createInitialState(
      7,
      params,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        scenarioId: "standingParty",
        standingPartyConfig: DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
      },
      80,
    );
    const rng = new SeededRandom(7);
    for (let i = 0; i < 40; i++) {
      state = step(state, params, rng);
    }
    const drawBefore = rng.next();
    const network = buildStandingPartyContactNetwork(state);
    const drawAfter = rng.next();
    // network導出はrngを読まない。2回nextした差だけが進む。
    expect(drawBefore).not.toBe(drawAfter);
    expect(network.asOfTick).toBe(state.tick);
    expect(network.metrics.nodeCount).toBe(state.agents.length);
    expect(Number.isFinite(network.metrics.density)).toBe(true);
    expect(network.contactIntervals.every((c) => c.dwellTicks >= 1)).toBe(true);

    // 全期間 == 0..currentTick
    const explicit = buildStandingPartyContactNetwork(state, {
      fromTick: 0,
      toTick: state.tick,
    });
    expect(explicit.contactIntervals).toEqual(network.contactIntervals);
    expect(explicit.edges).toEqual(network.edges);
  });
});
