import { describe, expect, it } from "vitest";
import type { Agent, GroupCandidate } from "./types";
import type { GroupCapacity } from "./formationPolicy";
import { DEFAULT_SPATIAL_DYNAMICS_CONFIG, validateSpatialDynamicsConfig, type SpatialDynamicsConfig } from "./spatialDynamics";
import {
  computeClusterSearchCandidateScore,
  enumerateClusterSearchCandidates,
  pickBestClusterSearchCandidate,
  type ClusterSearchCandidateScore,
} from "./clusterSearchSelection";

/**
 * Issue #250 (Phase 6 P6-D): 候補列挙・score・argmaxの純粋関数群の定性的性質を検証する
 * (issue「実装範囲10節」の各テスト項目に対応させる)。engine.tsへの結線はendine-wiringテスト側で扱う。
 */

const CONFIG: SpatialDynamicsConfig = { ...DEFAULT_SPATIAL_DYNAMICS_CONFIG, candidateSelectionEnabled: true };

function makeAgent(overrides: Partial<Agent> = {}): Agent {
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
    state: "undecided",
    stress: 0,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<GroupCandidate> = {}): GroupCandidate {
  return {
    id: "cluster-x",
    x: 400,
    y: 260,
    memberIds: [],
    status: "confirmed",
    age: 0,
    ...overrides,
  };
}

const UNLIMITED_CAPACITY: GroupCapacity = { minGroupSize: 2, maxGroupSize: Number.POSITIVE_INFINITY };
const capacityOf = () => UNLIMITED_CAPACITY;

describe("validateSpatialDynamicsConfig (candidateSelection fields)", () => {
  it("accepts the default config", () => {
    expect(() => validateSpatialDynamicsConfig(CONFIG)).not.toThrow();
  });

  it("rejects a non-positive observationRadius", () => {
    expect(() => validateSpatialDynamicsConfig({ ...CONFIG, candidateSelectionObservationRadius: 0 })).toThrow();
  });

  it("rejects a non-positive-integer maxObserved", () => {
    expect(() => validateSpatialDynamicsConfig({ ...CONFIG, candidateSelectionMaxObserved: 0 })).toThrow();
    expect(() => validateSpatialDynamicsConfig({ ...CONFIG, candidateSelectionMaxObserved: 1.5 })).toThrow();
  });

  it("rejects weights outside [0, 1]", () => {
    expect(() => validateSpatialDynamicsConfig({ ...CONFIG, candidateSelectionMinScore: 1.1 })).toThrow();
    expect(() => validateSpatialDynamicsConfig({ ...CONFIG, candidateSelectionSocialWeight: -0.1 })).toThrow();
    expect(() => validateSpatialDynamicsConfig({ ...CONFIG, candidateSelectionDistanceWeight: 2 })).toThrow();
    expect(() => validateSpatialDynamicsConfig({ ...CONFIG, candidateSelectionCrowdingPenalty: -1 })).toThrow();
  });
});

describe("enumerateClusterSearchCandidates", () => {
  it("列挙: joinable(forming/confirmed)な候補だけを対象にする", () => {
    const agent = makeAgent();
    const candidates = [
      makeCandidate({ id: "c-forming", status: "forming" }),
      makeCandidate({ id: "c-confirmed", status: "confirmed" }),
      makeCandidate({ id: "c-dissolving", status: "dissolving" }),
      makeCandidate({ id: "c-dissolved", status: "dissolved" }),
      makeCandidate({ id: "c-expired", status: "expired" }),
    ];
    const observed = enumerateClusterSearchCandidates(agent, candidates, capacityOf, undefined, CONFIG);
    expect(observed.map((o) => o.candidate.id).sort()).toEqual(["c-confirmed", "c-forming"]);
  });

  it("列挙: 満員の候補を除外する(容量込みjoinable判定)", () => {
    const agent = makeAgent();
    const full = makeCandidate({ id: "full", memberIds: ["a", "b"] });
    const observed = enumerateClusterSearchCandidates(agent, [full], () => ({ minGroupSize: 2, maxGroupSize: 2 }), undefined, CONFIG);
    expect(observed).toHaveLength(0);
  });

  it("列挙: observationRadiusの外側を除外する", () => {
    const agent = makeAgent({ x: 0, y: 0 });
    const near = makeCandidate({ id: "near", x: 10, y: 0 });
    const far = makeCandidate({ id: "far", x: CONFIG.candidateSelectionObservationRadius + 50, y: 0 });
    const observed = enumerateClusterSearchCandidates(agent, [near, far], capacityOf, undefined, CONFIG);
    expect(observed.map((o) => o.candidate.id)).toEqual(["near"]);
  });

  it("列挙: cooldown除外IDを維持する", () => {
    const agent = makeAgent();
    const candidate = makeCandidate({ id: "cooling-down" });
    const observed = enumerateClusterSearchCandidates(agent, [candidate], capacityOf, new Set(["cooling-down"]), CONFIG);
    expect(observed).toHaveLength(0);
  });

  it("列挙: 自分が既に所属するcluster(current/source)を候補へ戻さない", () => {
    const agent = makeAgent({ joinedGroupId: "self-cluster" });
    const candidate = makeCandidate({ id: "self-cluster" });
    const observed = enumerateClusterSearchCandidates(agent, [candidate], capacityOf, undefined, CONFIG);
    expect(observed).toHaveLength(0);
  });

  it("列挙: 距離昇順(同着はid昇順)でソートし、maxObservedで打ち切る", () => {
    const agent = makeAgent({ x: 0, y: 0 });
    const candidates = [
      makeCandidate({ id: "b-tie", x: 100, y: 0 }),
      makeCandidate({ id: "a-tie", x: 100, y: 0 }),
      makeCandidate({ id: "closer", x: 10, y: 0 }),
    ];
    const config = { ...CONFIG, candidateSelectionMaxObserved: 2 };
    const observed = enumerateClusterSearchCandidates(agent, candidates, capacityOf, undefined, config);
    expect(observed.map((o) => o.candidate.id)).toEqual(["closer", "a-tie"]);
  });

  it("列挙: candidates配列順を入れ替えても結果が変わらない", () => {
    const agent = makeAgent({ x: 0, y: 0 });
    const candidates = [
      makeCandidate({ id: "c1", x: 30, y: 0 }),
      makeCandidate({ id: "c2", x: 10, y: 0 }),
      makeCandidate({ id: "c3", x: 20, y: 0 }),
    ];
    const forward = enumerateClusterSearchCandidates(agent, candidates, capacityOf, undefined, CONFIG);
    const reversed = enumerateClusterSearchCandidates(agent, [...candidates].reverse(), capacityOf, undefined, CONFIG);
    expect(forward.map((o) => o.candidate.id)).toEqual(reversed.map((o) => o.candidate.id));
  });
});

describe("computeClusterSearchCandidateScore", () => {
  it("score contract: 各factorが定義され、最終scoreはfiniteかつ[0,1]", () => {
    const agent = makeAgent();
    const candidate = makeCandidate();
    const result = computeClusterSearchCandidateScore(agent, candidate, 50, 0.6, CONFIG, {
      agents: [agent],
      candidates: [candidate],
    });
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.clusterId).toBe(candidate.id);
    expect(result.eligible).toBe(true);
    expect(typeof result.factors.distance).toBe("number");
    expect(typeof result.factors.socialAttractiveness).toBe("number");
  });

  it("distance factor: 0距離で有限、距離の単調減少(distance weightの単調性)", () => {
    const agent = makeAgent();
    const near = makeCandidate({ id: "near" });
    const mid = makeCandidate({ id: "mid" });
    const far = makeCandidate({ id: "far" });
    const scoreAt = (dist: number, id: string) =>
      computeClusterSearchCandidateScore(agent, { ...near, id }, dist, 0, CONFIG, { agents: [agent], candidates: [] }).factors
        .distance;
    const d0 = scoreAt(0, near.id);
    const d1 = scoreAt(100, mid.id);
    const d2 = scoreAt(200, far.id);
    expect(Number.isFinite(d0)).toBe(true);
    expect(d0).toBeGreaterThan(d1);
    expect(d1).toBeGreaterThan(d2);
  });

  it("近い低魅力clusterと少し遠い高魅力clusterの比較: 高魅力が総合scoreで勝てる", () => {
    const agent = makeAgent();
    const nearLowAppeal = makeCandidate({ id: "near-low" });
    const farHighAppeal = makeCandidate({ id: "far-high" });
    const nearScore = computeClusterSearchCandidateScore(agent, nearLowAppeal, 10, 0.05, CONFIG, {
      agents: [agent],
      candidates: [nearLowAppeal, farHighAppeal],
    });
    const farScore = computeClusterSearchCandidateScore(agent, farHighAppeal, 150, 0.9, CONFIG, {
      agents: [agent],
      candidates: [nearLowAppeal, farHighAppeal],
    });
    expect(farScore.score).toBeGreaterThan(nearScore.score);
  });

  it("crowded target penalty: 過密な候補にはcrowdingPenaltyが付き、scoreが下がる", () => {
    const agent = makeAgent();
    const candidate = makeCandidate({ id: "crowded", x: 400, y: 260 });
    // 候補の周囲を多数のjoinedエージェントで埋める(自身の輪のmemberではないため密度に数えられる)
    const crowd: Agent[] = Array.from({ length: 15 }, (_, i) =>
      makeAgent({ id: `crowd-${i}`, x: 405 + i, y: 260, state: "joined", joinedGroupId: "other-cluster" }),
    );
    const sparseCandidate = makeCandidate({ id: "sparse", x: 0, y: 0 });
    const crowdedScore = computeClusterSearchCandidateScore(agent, candidate, 50, 0.5, CONFIG, {
      agents: crowd,
      candidates: [candidate],
    });
    const sparseScore = computeClusterSearchCandidateScore(agent, sparseCandidate, 50, 0.5, CONFIG, {
      agents: crowd,
      candidates: [sparseCandidate],
    });
    expect(crowdedScore.factors.crowdingPenalty ?? 0).toBeGreaterThan(0);
    expect(crowdedScore.score).toBeLessThan(sparseScore.score);
  });

  it("cooldown候補: lastFailedCandidateId/lastDepartedClusterIdと一致すると減点される", () => {
    const candidate = makeCandidate({ id: "same-as-failed" });
    const agentFailed = makeAgent({ lastFailedCandidateId: "same-as-failed" });
    const agentNeutral = makeAgent();
    const failedScore = computeClusterSearchCandidateScore(agentFailed, candidate, 50, 0.5, CONFIG, {
      agents: [agentFailed],
      candidates: [candidate],
    });
    const neutralScore = computeClusterSearchCandidateScore(agentNeutral, candidate, 50, 0.5, CONFIG, {
      agents: [agentNeutral],
      candidates: [candidate],
    });
    expect(failedScore.factors.recentVisitPenalty ?? 0).toBeGreaterThan(0);
    expect(failedScore.score).toBeLessThan(neutralScore.score);
  });

  it("Phase 5 disabled(alternativeInterestCtx未指定)ではalternativeInterest/informationOpportunityが常にundefined", () => {
    const agent = makeAgent();
    const candidate = makeCandidate();
    const result = computeClusterSearchCandidateScore(agent, candidate, 50, 0.5, CONFIG, {
      agents: [agent],
      candidates: [candidate],
    });
    expect(result.factors.alternativeInterest).toBeUndefined();
    expect(result.factors.informationOpportunity).toBeUndefined();
  });
});

describe("pickBestClusterSearchCandidate", () => {
  function score(clusterId: string, value: number): ClusterSearchCandidateScore {
    return {
      clusterId,
      eligible: true,
      score: value,
      factors: { distance: 0, socialAttractiveness: value },
    };
  }

  it("threshold未満ならroaming継続(undefinedを返す)", () => {
    const result = pickBestClusterSearchCandidate([score("a", 0.1), score("b", 0.2)], 0.35);
    expect(result).toBeUndefined();
  });

  it("no candidateでもroaming継続(空配列でundefined)", () => {
    expect(pickBestClusterSearchCandidate([], 0.35)).toBeUndefined();
  });

  it("最高scoreの候補を選ぶ", () => {
    const result = pickBestClusterSearchCandidate([score("low", 0.4), score("high", 0.8)], 0.35);
    expect(result?.clusterId).toBe("high");
  });

  it("top scoreが上昇しても選択確率が下がらない(決定的argmaxであり、同じ最大値なら常に選ばれる)", () => {
    const boosted = pickBestClusterSearchCandidate([score("a", 0.9), score("b", 0.5)], 0.35);
    expect(boosted?.clusterId).toBe("a");
    const evenMoreBoosted = pickBestClusterSearchCandidate([score("a", 0.99), score("b", 0.5)], 0.35);
    expect(evenMoreBoosted?.clusterId).toBe("a");
  });

  it("同点はclusterId昇順でtie-breakし、配列順に依存しない", () => {
    const forward = pickBestClusterSearchCandidate([score("b", 0.5), score("a", 0.5)], 0.35);
    const backward = pickBestClusterSearchCandidate([score("a", 0.5), score("b", 0.5)], 0.35);
    expect(forward?.clusterId).toBe("a");
    expect(backward?.clusterId).toBe("a");
  });
});
