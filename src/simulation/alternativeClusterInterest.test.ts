import { describe, expect, it } from "vitest";
import type { Agent, GroupCandidate } from "./types";
import type { GroupCapacity } from "./formationPolicy";
import {
  DEFAULT_ALTERNATIVE_CLUSTER_INTEREST_CONFIG,
  deriveAlternativeClusterInterests,
  selectBestAlternativeCluster,
  validateAlternativeClusterInterestConfig,
  type AlternativeClusterInterestConfig,
  type AlternativeClusterInterestContext,
} from "./alternativeClusterInterest";
import { tiePairKey, type TieCorrectionState } from "./relationshipTie";

/**
 * Issue #198 (Phase 3, P3-A): `deriveAlternativeClusterInterests`/`selectBestAlternativeCluster`の
 * 定性的性質を検証する。`docs/cluster-transition-phase3-model.md`(Issue #197 ADR)1節・4節・5節・
 * issue「受入条件」節に列挙された各性質に対応させる。
 */

const CONFIG = DEFAULT_ALTERNATIVE_CLUSTER_INTEREST_CONFIG;

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "observer",
    label: "O",
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
    state: "joined",
    stress: 0,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<GroupCandidate>): GroupCandidate {
  return {
    id: "cluster-x",
    x: 400,
    y: 260,
    memberIds: [],
    status: "forming",
    age: 0,
    ...overrides,
  };
}

const UNLIMITED_CAPACITY: GroupCapacity = { minGroupSize: 3, maxGroupSize: Number.POSITIVE_INFINITY };

function makeContext(overrides: Partial<AlternativeClusterInterestContext> = {}): AlternativeClusterInterestContext {
  return {
    config: CONFIG,
    tick: 100,
    agents: [],
    existingTieStrength: 0.5,
    resolveCapacity: () => UNLIMITED_CAPACITY,
    ...overrides,
  };
}

describe("validateAlternativeClusterInterestConfig", () => {
  it("accepts the default config", () => {
    expect(() => validateAlternativeClusterInterestConfig(CONFIG)).not.toThrow();
  });

  it("rejects a non-positive observationRadius/distanceDecayRadius", () => {
    expect(() => validateAlternativeClusterInterestConfig({ ...CONFIG, observationRadius: 0 })).toThrow();
    expect(() => validateAlternativeClusterInterestConfig({ ...CONFIG, observationRadius: -10 })).toThrow();
    expect(() => validateAlternativeClusterInterestConfig({ ...CONFIG, distanceDecayRadius: 0 })).toThrow();
  });

  it("rejects weights/caps outside [0, 1]", () => {
    expect(() => validateAlternativeClusterInterestConfig({ ...CONFIG, distanceWeight: 1.1 })).toThrow();
    expect(() => validateAlternativeClusterInterestConfig({ ...CONFIG, knownParticipantWeight: -0.1 })).toThrow();
    expect(() => validateAlternativeClusterInterestConfig({ ...CONFIG, cliqueCompatibilityWeight: 2 })).toThrow();
    expect(() => validateAlternativeClusterInterestConfig({ ...CONFIG, outsiderBarrierPenaltyCap: -1 })).toThrow();
    expect(() => validateAlternativeClusterInterestConfig({ ...CONFIG, capacityPressurePenaltyCap: 1.5 })).toThrow();
    expect(() => validateAlternativeClusterInterestConfig({ ...CONFIG, recentlyDepartedPenalty: -0.01 })).toThrow();
    expect(() => validateAlternativeClusterInterestConfig({ ...CONFIG, minTargetInterestScore: 1.5 })).toThrow();
  });

  it("rejects NaN/Infinity", () => {
    expect(() => validateAlternativeClusterInterestConfig({ ...CONFIG, distanceWeight: Number.NaN })).toThrow();
    expect(() =>
      validateAlternativeClusterInterestConfig({ ...CONFIG, observationRadius: Number.POSITIVE_INFINITY }),
    ).toThrow();
  });

  it("rejects a non-positive or non-integer maxTrackedCandidates", () => {
    expect(() => validateAlternativeClusterInterestConfig({ ...CONFIG, maxTrackedCandidates: 0 })).toThrow();
    expect(() => validateAlternativeClusterInterestConfig({ ...CONFIG, maxTrackedCandidates: -3 })).toThrow();
    expect(() => validateAlternativeClusterInterestConfig({ ...CONFIG, maxTrackedCandidates: 2.5 })).toThrow();
  });
});

describe("deriveAlternativeClusterInterests: candidate enumeration", () => {
  it("excludes the agent's own current cluster", () => {
    const agent = makeAgent({ joinedGroupId: "current" });
    const current = makeCandidate({ id: "current", x: 410, y: 260 });
    const other = makeCandidate({ id: "other", x: 420, y: 260 });
    const result = deriveAlternativeClusterInterests(agent, [current, other], makeContext());
    expect(result.map((r) => r.targetClusterId)).toEqual(["other"]);
  });

  it("excludes dissolving/dissolved/expired clusters", () => {
    const agent = makeAgent({ joinedGroupId: "current" });
    const candidates = [
      makeCandidate({ id: "dissolving", status: "dissolving" }),
      makeCandidate({ id: "dissolved", status: "dissolved" }),
      makeCandidate({ id: "expired", status: "expired" }),
      makeCandidate({ id: "confirmed", status: "confirmed" }),
    ];
    const result = deriveAlternativeClusterInterests(agent, candidates, makeContext());
    expect(result.map((r) => r.targetClusterId)).toEqual(["confirmed"]);
  });

  it("excludes clusters at capacity, but keeps near-full ones with a capacityPressure penalty", () => {
    const agent = makeAgent({});
    const full = makeCandidate({ id: "full", memberIds: ["a", "b", "c", "d"] });
    const nearFull = makeCandidate({ id: "near-full", memberIds: ["a", "b", "c"] });
    const capacity: GroupCapacity = { minGroupSize: 2, maxGroupSize: 4 };
    const result = deriveAlternativeClusterInterests(
      agent,
      [full, nearFull],
      makeContext({ resolveCapacity: () => capacity }),
    );
    expect(result.map((r) => r.targetClusterId)).toEqual(["near-full"]);
    const factor = result[0].factors.find((f) => f.kind === "capacityPressure");
    expect(factor).toBeDefined();
    expect(factor!.contribution).toBeLessThan(0);
  });

  it("excludes clusters outside the observation radius", () => {
    const agent = makeAgent({ x: 0, y: 0 });
    const near = makeCandidate({ id: "near", x: 50, y: 0 });
    const far = makeCandidate({ id: "far", x: CONFIG.observationRadius + 50, y: 0 });
    const result = deriveAlternativeClusterInterests(agent, [near, far], makeContext());
    expect(result.map((r) => r.targetClusterId)).toEqual(["near"]);
  });

  it("does not mutate the input agent or candidates array", () => {
    const agent = makeAgent({ joinedGroupId: "current" });
    const agentSnapshot = { ...agent };
    const candidates = [makeCandidate({ id: "a" }), makeCandidate({ id: "b" })];
    const candidatesSnapshot = candidates.map((c) => ({ ...c }));
    deriveAlternativeClusterInterests(agent, candidates, makeContext());
    expect(agent).toEqual(agentSnapshot);
    expect(candidates).toEqual(candidatesSnapshot);
  });

  it("never produces NaN/Infinity scores, even at zero distance or very large coordinates", () => {
    const agent = makeAgent({ x: 0, y: 0 });
    const zeroDist = makeCandidate({ id: "zero", x: 0, y: 0 });
    const huge = makeCandidate({ id: "huge", x: 1e9, y: 1e9 });
    const result = deriveAlternativeClusterInterests(agent, [zeroDist, huge], makeContext());
    for (const interest of result) {
      expect(Number.isFinite(interest.score)).toBe(true);
      for (const factor of interest.factors) {
        expect(Number.isFinite(factor.contribution)).toBe(true);
      }
    }
  });
});

describe("deriveAlternativeClusterInterests: distance factor", () => {
  it("is monotonic non-increasing in distance (closer never scores lower, all else equal)", () => {
    const agent = makeAgent({ x: 0, y: 0 });
    const near = makeCandidate({ id: "near", x: 20, y: 0 });
    const mid = makeCandidate({ id: "mid", x: 100, y: 0 });
    const far = makeCandidate({ id: "far", x: 180, y: 0 });
    const result = deriveAlternativeClusterInterests(agent, [near, mid, far], makeContext());
    const byId = new Map(result.map((r) => [r.targetClusterId, r.score]));
    expect(byId.get("near")!).toBeGreaterThanOrEqual(byId.get("mid")!);
    expect(byId.get("mid")!).toBeGreaterThanOrEqual(byId.get("far")!);
  });
});

describe("deriveAlternativeClusterInterests: recentlyDeparted factor", () => {
  it("penalizes the cluster the agent most recently departed from", () => {
    const agent = makeAgent({ lastDepartedClusterId: "old-cluster" });
    const old = makeCandidate({ id: "old-cluster", x: 410, y: 260 });
    const other = makeCandidate({ id: "other", x: 410, y: 260 });
    const result = deriveAlternativeClusterInterests(agent, [old, other], makeContext());
    const oldInterest = result.find((r) => r.targetClusterId === "old-cluster")!;
    const otherInterest = result.find((r) => r.targetClusterId === "other")!;
    expect(oldInterest.score).toBeLessThan(otherInterest.score);
    expect(oldInterest.factors.find((f) => f.kind === "recentlyDeparted")?.contribution).toBeLessThan(0);
  });
});

describe("deriveAlternativeClusterInterests: clique factors", () => {
  it("boosts score via cliqueCompatibility when clique-mates are present", () => {
    const agent = makeAgent({ cliqueId: 1, x: 400, y: 260 });
    const mate = makeAgent({ id: "mate", cliqueId: 1 });
    const stranger = makeAgent({ id: "stranger", cliqueId: 2 });
    const withMate = makeCandidate({ id: "with-mate", memberIds: ["mate"], x: 410, y: 260 });
    const withoutMate = makeCandidate({ id: "without-mate", memberIds: ["stranger"], x: 410, y: 260 });
    const ctx = makeContext({ agents: [agent, mate, stranger] });
    const result = deriveAlternativeClusterInterests(agent, [withMate, withoutMate], ctx);
    const withMateScore = result.find((r) => r.targetClusterId === "with-mate")!.score;
    const withoutMateScore = result.find((r) => r.targetClusterId === "without-mate")!.score;
    expect(withMateScore).toBeGreaterThan(withoutMateScore);
  });

  it("applies an outsiderBarrier penalty when a cluster is dominated by a clique the agent doesn't belong to", () => {
    const agent = makeAgent({ cliqueId: 1, x: 400, y: 260 });
    const others = ["s1", "s2", "s3"].map((id) => makeAgent({ id, cliqueId: 2 }));
    const dominated = makeCandidate({ id: "dominated", memberIds: others.map((o) => o.id), x: 410, y: 260 });
    const ctx = makeContext({ agents: [agent, ...others] });
    const result = deriveAlternativeClusterInterests(agent, [dominated], ctx);
    const interest = result[0];
    expect(interest.factors.find((f) => f.kind === "outsiderBarrier")?.contribution).toBeLessThan(0);
  });

  it("stays neutral (no clique factors) when cliqueId is undefined and tie history is disabled", () => {
    const agent = makeAgent({ cliqueId: undefined, x: 400, y: 260 });
    const member = makeAgent({ id: "member", cliqueId: 1 });
    const candidate = makeCandidate({ id: "c", memberIds: ["member"], x: 410, y: 260 });
    const ctx = makeContext({ agents: [agent, member] });
    const result = deriveAlternativeClusterInterests(agent, [candidate], ctx);
    expect(result[0].factors.find((f) => f.kind === "cliqueCompatibility")).toBeUndefined();
    expect(result[0].factors.find((f) => f.kind === "knownParticipant")).toBeUndefined();
    expect(Number.isFinite(result[0].score)).toBe(true);
  });
});

describe("deriveAlternativeClusterInterests: knownParticipant / focusAgentId", () => {
  it("sets focusAgentId to the member with the strongest positive tie correction, and boosts score", () => {
    const agent = makeAgent({ x: 400, y: 260 });
    const memberA = makeAgent({ id: "a", x: 410, y: 260 });
    const memberB = makeAgent({ id: "b", x: 410, y: 260 });
    const candidate = makeCandidate({ id: "c", memberIds: ["a", "b"], x: 410, y: 260 });
    const withoutTies = deriveAlternativeClusterInterests(agent, [candidate], makeContext({ agents: [agent, memberA, memberB] }));

    const tieCorrections: TieCorrectionState = {
      [tiePairKey(agent.id, "a")]: 0.05,
      [tiePairKey(agent.id, "b")]: 0.15,
    };
    const withTies = deriveAlternativeClusterInterests(
      agent,
      [candidate],
      makeContext({ agents: [agent, memberA, memberB], tieCorrections }),
    );

    expect(withTies[0].focusAgentId).toBe("b");
    expect(withTies[0].score).toBeGreaterThan(withoutTies[0].score);
  });

  it("tie-breaks equal positive tie corrections by the smallest member id", () => {
    const agent = makeAgent({ x: 400, y: 260 });
    const memberA = makeAgent({ id: "a", x: 410, y: 260 });
    const memberZ = makeAgent({ id: "z", x: 410, y: 260 });
    const candidate = makeCandidate({ id: "c", memberIds: ["z", "a"], x: 410, y: 260 });
    const tieCorrections: TieCorrectionState = {
      [tiePairKey(agent.id, "a")]: 0.1,
      [tiePairKey(agent.id, "z")]: 0.1,
    };
    const result = deriveAlternativeClusterInterests(
      agent,
      [candidate],
      makeContext({ agents: [agent, memberA, memberZ], tieCorrections }),
    );
    expect(result[0].focusAgentId).toBe("a");
  });

  it("ignores negative/zero tie corrections (not treated as a known participant)", () => {
    const agent = makeAgent({ x: 400, y: 260 });
    const member = makeAgent({ id: "a", x: 410, y: 260 });
    const candidate = makeCandidate({ id: "c", memberIds: ["a"], x: 410, y: 260 });
    const tieCorrections: TieCorrectionState = { [tiePairKey(agent.id, "a")]: -0.1 };
    const result = deriveAlternativeClusterInterests(
      agent,
      [candidate],
      makeContext({ agents: [agent, member], tieCorrections }),
    );
    expect(result[0].focusAgentId).toBeUndefined();
    expect(result[0].factors.find((f) => f.kind === "knownParticipant")).toBeUndefined();
  });
});

describe("deriveAlternativeClusterInterests: maxTrackedCandidates truncation", () => {
  it("keeps only the nearest maxTrackedCandidates, order-independent of input array order", () => {
    const agent = makeAgent({ x: 0, y: 0 });
    const config: AlternativeClusterInterestConfig = { ...CONFIG, maxTrackedCandidates: 2, observationRadius: 1000 };
    const candidates = [
      makeCandidate({ id: "d30", x: 30, y: 0 }),
      makeCandidate({ id: "d10", x: 10, y: 0 }),
      makeCandidate({ id: "d20", x: 20, y: 0 }),
    ];
    const forward = deriveAlternativeClusterInterests(agent, candidates, makeContext({ config }));
    const reversed = deriveAlternativeClusterInterests(agent, [...candidates].reverse(), makeContext({ config }));
    expect(new Set(forward.map((r) => r.targetClusterId))).toEqual(new Set(["d10", "d20"]));
    expect(new Set(reversed.map((r) => r.targetClusterId))).toEqual(new Set(["d10", "d20"]));
  });
});

describe("selectBestAlternativeCluster", () => {
  it("picks the highest score", () => {
    const interests = [
      { targetClusterId: "low", score: 0.3, factors: [], observedAtTick: 1 },
      { targetClusterId: "high", score: 0.8, factors: [], observedAtTick: 1 },
    ];
    expect(selectBestAlternativeCluster(interests, 0)?.targetClusterId).toBe("high");
  });

  it("tie-breaks equal scores by targetClusterId ascending", () => {
    const interests = [
      { targetClusterId: "zzz", score: 0.5, factors: [], observedAtTick: 1 },
      { targetClusterId: "aaa", score: 0.5, factors: [], observedAtTick: 1 },
    ];
    expect(selectBestAlternativeCluster(interests, 0)?.targetClusterId).toBe("aaa");
  });

  it("returns undefined when the best score is below the threshold", () => {
    const interests = [{ targetClusterId: "only", score: 0.2, factors: [], observedAtTick: 1 }];
    expect(selectBestAlternativeCluster(interests, 0.5)).toBeUndefined();
  });

  it("returns undefined for an empty list", () => {
    expect(selectBestAlternativeCluster([], 0)).toBeUndefined();
  });

  it("is independent of input array order and does not mutate it", () => {
    const interests = [
      { targetClusterId: "b", score: 0.4, factors: [], observedAtTick: 1 },
      { targetClusterId: "a", score: 0.9, factors: [], observedAtTick: 1 },
      { targetClusterId: "c", score: 0.6, factors: [], observedAtTick: 1 },
    ];
    const snapshot = [...interests];
    const forward = selectBestAlternativeCluster(interests, 0);
    const reversed = selectBestAlternativeCluster([...interests].reverse(), 0);
    expect(forward?.targetClusterId).toBe("a");
    expect(reversed?.targetClusterId).toBe("a");
    expect(interests).toEqual(snapshot);
  });
});
