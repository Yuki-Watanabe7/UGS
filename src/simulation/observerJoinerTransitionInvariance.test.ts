import { describe, expect, it } from "vitest";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG } from "./standingPartyScenarioConfig";
import { DEFAULT_CLUSTER_TRANSITION_CONFIG } from "./clusterTransitionDecision";
import {
  DEFAULT_ALTERNATIVE_CLUSTER_INTEREST_CONFIG,
  deriveAlternativeClusterInterests,
  type AlternativeClusterInterestContext,
} from "./alternativeClusterInterest";
import { computeDepartureInhibition, evaluateClusterDissolutionImpact, initializeAttachment } from "./currentClusterAttachment";
import type { Agent, GroupCandidate } from "./types";
import { standingPartyPolicy, type ClusterDepartureContext, type GroupCapacity } from "./formationPolicy";

/**
 * Issue #203 (Phase 3, 検証): `docs/cluster-transition-phase3-model.md` 1.1節/4節が明記する
 * 「`isObserverJoiner`はいかなる式にも入力されない」を、他クラスタ関心・愛着配慮・遷移decisionの
 * それぞれの層で固定する。ADR自体は`evaluateClusterDeparture`が`_agent`を参照しないことで構造的に
 * 保証しているが、この不変条件は将来のリファクタで静かに壊れうるため、回帰検知用のテストとして残す。
 *
 * 「連続値(influenceAvoidance等)が同じならisObserverJoinerの真偽で結果が変わらない」ことを検証する
 * ―― 「observerJoinerだけに架空の心理的葛藤を追加しない」という要件の直接的なテスト化。
 */

const UNLIMITED_CAPACITY: GroupCapacity = { minGroupSize: 3, maxGroupSize: Number.POSITIVE_INFINITY };

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
    influenceAvoidance: 0.7,
    conformity: 0.5,
    leaveThreshold: 0.5,
    isObserverJoiner: false,
    state: "joined",
    stress: 0,
    cliqueId: 1,
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

describe("deriveAlternativeClusterInterests: isObserverJoinerの真偽で結果が変わらない", () => {
  it("influenceAvoidance等の連続値が同じなら、observerJoinerか否かで他クラスタ関心が完全に一致する", () => {
    const ownCluster = makeCandidate({ id: "cluster-own" });
    const targetA = makeCandidate({
      id: "cluster-a",
      x: 420,
      y: 270,
      memberIds: ["mate-1"],
      status: "confirmed",
    });
    const targetB = makeCandidate({ id: "cluster-b", x: 800, y: 700, memberIds: ["stranger-1"], status: "forming" });
    const candidates = [ownCluster, targetA, targetB];

    const mate = makeAgent({ id: "mate-1", cliqueId: 1 });

    const nonObserver = makeAgent({ id: "agent-x", joinedGroupId: ownCluster.id, isObserverJoiner: false });
    const observer = makeAgent({ id: "agent-x", joinedGroupId: ownCluster.id, isObserverJoiner: true });

    const baseCtx: Omit<AlternativeClusterInterestContext, "agents"> = {
      config: DEFAULT_ALTERNATIVE_CLUSTER_INTEREST_CONFIG,
      tick: 42,
      existingTieStrength: 0.6,
      resolveCapacity: () => UNLIMITED_CAPACITY,
    };

    const interestsNonObserver = deriveAlternativeClusterInterests(nonObserver, candidates, {
      ...baseCtx,
      agents: [nonObserver, mate],
    });
    const interestsObserver = deriveAlternativeClusterInterests(observer, candidates, {
      ...baseCtx,
      agents: [observer, mate],
    });

    expect(interestsObserver).toEqual(interestsNonObserver);
    // フィクスチャ自体が空振りでないことを確認する(常に空配列同士が一致しても無意味なため)。
    expect(interestsNonObserver.length).toBeGreaterThan(0);
  });
});

describe("computeDepartureInhibition: isObserverJoinerの真偽で結果が変わらない", () => {
  it("influenceAvoidanceが同じなら、observerJoinerか否かで愛着・配慮の抑制が完全に一致する", () => {
    // computeDepartureInhibitionはagent全体ではなくinfluenceAvoidance(連続値)だけを受け取るため、
    // ここでは「isObserverJoinerを直接の入力に取らない」契約そのものを固定する。
    const attachment = initializeAttachment({
      config: DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.attachment,
      tick: 0,
      memberIds: ["agent-x", "mate-1"],
    });
    const dissolutionImpact = evaluateClusterDissolutionImpact({
      memberIds: ["agent-x"],
      minGroupSize: 3,
      confirmedClusterIsMutable: true,
      candidateStatus: "confirmed",
      everConfirmed: true,
    });

    const forObserverLikeInfluenceAvoidance = computeDepartureInhibition({
      config: DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.attachment,
      attachment,
      tick: 42,
      dissolutionImpact,
      influenceAvoidance: 0.8,
    });
    const sameCallAgain = computeDepartureInhibition({
      config: DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.attachment,
      attachment,
      tick: 42,
      dissolutionImpact,
      influenceAvoidance: 0.8,
    });

    // isObserverJoinerを渡す経路が存在しないこと自体が契約(型シグネチャにフィールドがない)だが、
    // 同一の連続値入力からは常に同一の結果になることも合わせて固定する(決定性)。
    expect(sameCallAgain).toEqual(forObserverLikeInfluenceAvoidance);
  });
});

describe("standingPartyPolicy.evaluateClusterDeparture: isObserverJoinerの真偽で結果が変わらない", () => {
  it("同一のctx(departure/transition入力)なら、agentがobserverJoinerか否かでdeparture決定が完全に一致する", () => {
    // 実際のengine実行を比較すると、observerJoiner専用の「様子見を継続」フレーバーログ
    // (rng.chance(0.1)、Phase 1由来・Phase 3とは無関係)がrng消費量をずらし、以降の
    // イベント列全体が発散してしまう。これはPhase 3の式がisObserverJoinerを参照しているからでは
    // ないため、比較対象を`evaluateClusterDeparture`(rngを一切消費しない純粋関数)自体に絞る。
    const candidate: GroupCandidate = {
      id: "group-a",
      x: 400,
      y: 260,
      memberIds: ["agent-x", "mate-1", "mate-2"],
      status: "confirmed",
      age: 10,
    };
    const bestAlternativeInterest = {
      targetClusterId: "group-b",
      focusAgentId: "mate-9",
      score: 0.72,
      factors: [{ kind: "distance" as const, contribution: 0.5 }],
      observedAtTick: 42,
    };
    const inhibition = {
      attachment: 0.4,
      concern: 0.2,
      total: 0.5,
      factors: [{ kind: "episodeAttachment" as const, contribution: 0.3 }],
    };
    const ctx: ClusterDepartureContext = {
      ticksInCluster: 20,
      memberCount: candidate.memberIds.length,
      tick: 42,
      conversationSatisfaction: 0.3,
      socialCirculationTendency: 0.9,
      transition: {
        config: { ...DEFAULT_CLUSTER_TRANSITION_CONFIG, enabled: true },
        bestAlternativeInterest,
        minTargetInterestScore: DEFAULT_ALTERNATIVE_CLUSTER_INTEREST_CONFIG.minTargetInterestScore,
        inhibition,
      },
    };

    const nonObserver = makeAgent({ id: "agent-x", isObserverJoiner: false, influenceAvoidance: 0.8 });
    const observer = makeAgent({ id: "agent-x", isObserverJoiner: true, influenceAvoidance: 0.8 });

    const nonObserverDecision = standingPartyPolicy.evaluateClusterDeparture(nonObserver, candidate, ctx);
    const observerDecision = standingPartyPolicy.evaluateClusterDeparture(observer, candidate, ctx);

    expect(observerDecision).toEqual(nonObserverDecision);
    // フィクスチャがswitchToTargetClusterを選ぶだけの寄与を持つことを確認する(空振り防止)。
    expect(nonObserverDecision.transition?.actionProbabilities.switchToTargetCluster).toBeGreaterThan(0);
  });
});
