/**
 * Issue #252 (standingParty Phase 6 統合検証, roadmap #172): #246〜#251が個別に実装・検証した
 * 空間ダイナミクス(cluster間斥力・persistent roaming・crowding avoidance・候補選択の一般化・
 * 設定UI/診断/統計)を、実際のengine run・複数機能の組み合わせ・長時間実行を通じて横断的に検証する。
 *
 * 個々の数式・単体の結線規則は各Issueのテスト(`spatialDynamics*.test.ts`/`roaming*.test.ts`/
 * `spatialOccupancy*.test.ts`/`clusterSearchSelection*.test.ts`)に委ねる。このファイルは
 * 「複数の空間力が同時に働いてもmembership/episode/情報伝播(Phase 5)が非自明に維持されること」
 * 「座標・velocity・runtime stateの不変条件が長時間run・複数seedで壊れないこと」
 * 「paired seedで空間分散が改善する一方、社会的凝集が崩壊しないこと」というPhase 6全体の境界を固定する。
 *
 * 中立性(issue受入条件と同じ): spatial coverageやcluster間斥力の強さは「良い/悪いパーティー」を
 * 意味しない。paired比較は分布・件数の記録であり、個々のseedへ単調差を要求しない。
 */
import { describe, expect, it } from "vitest";
import {
  buildStandingPartyAnalysisCsvFiles,
  buildStandingPartyAnalysisExport,
} from "./analysisExport";
import { buildStandingPartyContactNetwork } from "./standingPartyAnalysis";
import { createInitialState, stepSimulation } from "./engine";
import { getFormationPolicyById, type FormationRuntimeOptions } from "./formationPolicy";
import { getPresetById } from "./presets";
import { SeededRandom } from "./random";
import {
  computeClusterSearchCandidateScore,
  enumerateClusterSearchCandidates,
  pickBestClusterSearchCandidate,
} from "./clusterSearchSelection";
import { computeCrowdingVector, isPresentForOccupancy } from "./spatialOccupancy";
import { computeAgentWallAvoidanceForce, computeRoamingVector } from "./roaming";
import { applyClusterSpatialDynamics, DEFAULT_SPATIAL_DYNAMICS_CONFIG } from "./spatialDynamics";
import { buildStandingPartySpatialAnalysis } from "./spatialAnalysis";
import { assertStandingPartyInvariants, assertStandingPartySpatialInvariants } from "./standingPartyInvariants";
import {
  DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  INFO_RICH_STANDING_PARTY_CONFIG,
  SPATIAL_ROAMING_STANDING_PARTY_CONFIG,
  validateStandingPartyScenarioConfig,
} from "./standingPartyScenarioConfig";
import { distance, WORLD_HEIGHT, WORLD_WIDTH } from "./model";
import type { Agent, GroupCandidate, SimulationState } from "./types";
import type { StandingPartyScenarioConfig } from "./standingPartyScenarioConfig";

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

function makeState(
  agents: Agent[],
  candidates: GroupCandidate[],
  tick: number,
  formation: FormationRuntimeOptions,
): SimulationState {
  return {
    tick,
    agents,
    groupCandidates: candidates,
    log: [],
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    finished: false,
    formationScenarioId: formation.scenarioId,
    standingPartyConfig: formation.standingPartyConfig,
  };
}

function step(state: SimulationState, rng: SeededRandom, formation: FormationRuntimeOptions): SimulationState {
  return stepSimulation(state, MIN_SIZE_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, formation);
}

function formationOptionsFor(presetId: string): FormationRuntimeOptions {
  const preset = getPresetById(presetId);
  return {
    scenarioId: "standingParty",
    standingPartyConfig: preset.formationStandingPartyConfig ?? DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  };
}

const MIN_SIZE_PARAMS = { ...getPresetById("standing-party").params, groupConfirmSize: 2 };
const POLICY = getFormationPolicyById("standingParty");

function cellIndexOf(x: number, y: number, cols: number, rows: number): string {
  const col = Math.min(cols - 1, Math.max(0, Math.floor((x / WORLD_WIDTH) * cols)));
  const row = Math.min(rows - 1, Math.max(0, Math.floor((y / WORLD_HEIGHT) * rows)));
  return `${row}:${col}`;
}

// ================================================================================================
// 1. 決定的spatial fixture(issue実装範囲1節)
// ================================================================================================

describe("Issue #252: 決定的spatial fixture", () => {
  it("近接した2つのconfirmed clusterはcluster repulsionで中心間距離が増え、memberが追従する(rng非消費)", () => {
    const config = { ...DEFAULT_SPATIAL_DYNAMICS_CONFIG, enabled: true };
    const clusterA = makeCandidate({ id: "a", x: 380, y: 260, memberIds: ["a-member"], status: "confirmed" });
    const clusterB = makeCandidate({ id: "b", x: 420, y: 260, memberIds: ["b-member"], status: "confirmed" });
    const aMember = makeAgent({ id: "a-member", state: "joined", joinedGroupId: "a", x: 380, y: 260 });
    const bMember = makeAgent({ id: "b-member", state: "joined", joinedGroupId: "b", x: 420, y: 260 });
    const candidates = [clusterA, clusterB];
    const agents = [aMember, bMember];

    const startDistance = distance(clusterA.x, clusterA.y, clusterB.x, clusterB.y);
    let previousVelocity = {};
    for (let i = 0; i < 10; i++) {
      const result = applyClusterSpatialDynamics(candidates, agents, config, previousVelocity);
      previousVelocity = result.clusterVelocity;
    }
    const endDistance = distance(clusterA.x, clusterA.y, clusterB.x, clusterB.y);
    expect(endDistance, "cluster間斥力で中心間距離が増える").toBeGreaterThan(startDistance);

    // memberは中心へ追従する(元のcluster中心からの相対offsetを保つ)
    expect(distance(aMember.x, aMember.y, clusterA.x, clusterA.y)).toBeLessThan(5);
    expect(distance(bMember.x, bMember.y, clusterB.x, clusterB.y)).toBeLessThan(5);
  });

  it("undecided agentはpersistent roaming中、高密度領域をcrowding avoidanceで押し返される", () => {
    const config = { ...DEFAULT_SPATIAL_DYNAMICS_CONFIG, enabled: true };
    const roamer = makeAgent({ id: "roamer", state: "undecided", x: 300, y: 260 });
    // roamerの右側に密集した他agentを置く(密度sourceとして数えられる、同clusterではない)
    const crowd: Agent[] = Array.from({ length: 6 }, (_, i) =>
      makeAgent({ id: `crowd-${i}`, state: "undecided", x: 340 + i * 4, y: 260 + (i % 2 === 0 ? 6 : -6) }),
    );
    const allAgents = [roamer, ...crowd];
    const crowding = computeCrowdingVector(roamer, allAgents, [], config);
    expect(crowding.localDensity, "密集領域の近くではlocalDensityが閾値を超える").toBeGreaterThan(config.crowdDensityThreshold);
    expect(crowding.crowded).toBe(true);
    // 押し出しは密集(右側=+x)と逆方向、つまり-x成分を持つ
    expect(crowding.vectorX).toBeLessThan(0);

    // roaming vector(右向きheading)にcrowding vectorが合成されると、素のroamingより左へ寄る
    const rightwardHeading = 0; // 0 rad = +x方向
    const roamOnly = computeRoamingVector(rightwardHeading, 1, config);
    const wall = computeAgentWallAvoidanceForce(roamer, config);
    const combinedDx = roamOnly.dx + crowding.vectorX + wall.fx;
    expect(combinedDx, "crowding avoidanceが右向きroamingを打ち消す方向へ働く").toBeLessThan(roamOnly.dx + wall.fx);
  });

  it("候補選択は観察半径外のclusterを見送り、roamingで近づいた後の高scoreな遠方clusterを選ぶ", () => {
    const config = { ...DEFAULT_SPATIAL_DYNAMICS_CONFIG, enabled: true, candidateSelectionEnabled: true };
    const nearCluster = makeCandidate({ id: "near", x: 150, y: 100, memberIds: ["m1"], status: "confirmed" });
    const farCluster = makeCandidate({ id: "far", x: 500, y: 100, memberIds: ["m2"], status: "confirmed" });
    const capacityOf = () => ({ minGroupSize: 2, maxGroupSize: 6 });
    // near clusterの周囲を混雑させ、spatial exploration bonus(閑散地への小加点)ではなく
    // crowding penaltyが働くようにする(混雑していない候補は自動的にbonusを得るため、
    // 「近いが低魅力」を素直に低scoreにするにはcrowdingでbonus側を打ち消す必要がある)。
    const crowdNearNear: Agent[] = Array.from({ length: 4 }, (_, i) =>
      makeAgent({ id: `crowd-${i}`, state: "undecided", x: 150 + (i % 2 === 0 ? 12 : -12), y: 100 + (i < 2 ? 12 : -12) }),
    );
    const extras = { agents: crowdNearNear, candidates: [nearCluster, farCluster] };

    // 今tick: agentは(100,100)。nearは観察半径内(dist 50)だが混雑・低社会魅力でminScore未満。
    // farは観察半径(既定260)の外なので列挙されず、候補は見送られてroamingを継続する。
    const agentNow = makeAgent({ id: "seeker", x: 100, y: 100 });
    const observedNow = enumerateClusterSearchCandidates(agentNow, [nearCluster, farCluster], capacityOf, undefined, config);
    expect(observedNow.map((o) => o.candidate.id)).toEqual(["near"]);
    const scoresNow = observedNow.map(({ candidate, dist }) =>
      computeClusterSearchCandidateScore(agentNow, candidate, dist, 0.05, config, extras),
    );
    expect(scoresNow[0].factors.crowdingPenalty, "near clusterはcrowding penaltyを受ける").toBeGreaterThan(0);
    const bestNow = pickBestClusterSearchCandidate(scoresNow, config.candidateSelectionMinScore);
    expect(bestNow, "混雑した低魅力の近傍候補だけではminScore未満のため見送る").toBeUndefined();

    // 後のtick: roamingでagentが(250,100)まで進み、farが観察半径内(dist 250)に入る。
    // farは閑散・社会的に魅力的(welcoming)なので、混雑・距離penaltyを持つnearより高scoreになる。
    const agentLater = makeAgent({ id: "seeker", x: 250, y: 100 });
    const observedLater = enumerateClusterSearchCandidates(agentLater, [nearCluster, farCluster], capacityOf, undefined, config);
    expect(observedLater.map((o) => o.candidate.id).sort()).toEqual(["far", "near"]);
    const scoresLater = observedLater.map(({ candidate, dist }) =>
      computeClusterSearchCandidateScore(agentLater, candidate, dist, candidate.id === "far" ? 0.9 : 0.05, config, extras),
    );
    const bestLater = pickBestClusterSearchCandidate(scoresLater, config.candidateSelectionMinScore);
    expect(bestLater?.clusterId, "近い混雑・低魅力候補ではなく遠い閑散・高魅力候補を選ぶ").toBe("far");
  });

  it("approaching中のagentは、cluster repulsionで動くcluster中心を追従し、到達してjoinする(新episode成立)", () => {
    const formation: FormationRuntimeOptions = {
      scenarioId: "standingParty",
      standingPartyConfig: {
        ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
        spatialDynamics: { ...DEFAULT_SPATIAL_DYNAMICS_CONFIG, enabled: true },
      },
    };
    // target clusterはrepulsion源となるもう1つのclusterから押されて動き続ける
    const target = makeCandidate({ id: "target", x: 300, y: 260, memberIds: ["target-member"], status: "confirmed" });
    const pusher = makeCandidate({ id: "pusher", x: 340, y: 260, memberIds: ["pusher-member"], status: "confirmed" });
    const targetMember = makeAgent({ id: "target-member", state: "joined", joinedGroupId: "target", x: 300, y: 260 });
    const pusherMember = makeAgent({ id: "pusher-member", state: "joined", joinedGroupId: "pusher", x: 340, y: 260 });
    // 十分遠くに置き、1tickでは到達できないようにする(engine.test.tsの既存慣習と同じ理由)
    const approaching = makeAgent({ id: "approacher", state: "approaching", joinedGroupId: "target", x: 100, y: 260 });

    let state = makeState([approaching, targetMember, pusherMember], [target, pusher], 0, formation);
    const rng = new SeededRandom(11);
    let joined = false;
    for (let i = 0; i < 200 && !joined; i++) {
      state = step(state, rng, formation);
      const agent = state.agents.find((a) => a.id === "approacher")!;
      if (agent.state === "joined") joined = true;
    }
    expect(joined, "動くtarget clusterへ追従し続け、最終的にjoinできる").toBe(true);
    const finalAgent = state.agents.find((a) => a.id === "approacher")!;
    expect(finalAgent.joinedGroupId).toBe("target");
    expect(finalAgent.currentEpisode, "join成功で新しい会話episodeが成立する").toBeDefined();
    expect(finalAgent.currentEpisode!.clusterId).toBe("target");
  });
});

// ================================================================================================
// 2〜3. 座標・movement不変条件 + ordering/determinism(長時間run・複数seed・複数preset)
// ================================================================================================

describe("Issue #252: 座標・movement不変条件(長時間run・複数seed)", () => {
  const PRESET_IDS = ["standing-party-spatial-roaming", "standing-party-spatial-fixed-baseline"] as const;
  const SEEDS = [41, 42] as const;
  const TICKS = 1000;

  it.each(PRESET_IDS)("プリセット「%s」で1000tick・複数seedにわたり座標・velocity・runtime stateの不変条件が壊れない", (presetId) => {
    const preset = getPresetById(presetId);
    const formation = formationOptionsFor(presetId);
    const spatialConfig = formation.standingPartyConfig!.spatialDynamics;

    for (const seed of SEEDS) {
      const rng = new SeededRandom(seed);
      let state = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
      for (let i = 0; i < TICKS; i++) {
        state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
        const label = `preset=${presetId} seed=${seed} tick=${state.tick}`;
        assertStandingPartyInvariants(state, { maxEmptyFormingAge: POLICY.defaultMaxAge, label });
        assertStandingPartySpatialInvariants(state, spatialConfig, label);
      }
    }
  }, 180_000);
});

describe("Issue #252: ordering/determinism(空間計算がagents/groupCandidates配列順に依存しない)", () => {
  // 注記: `stepSimulation`全体(社会的decision含む)は共有の主系列`SeededRandom`を配列走査順に
  // 消費するため、agents配列を丸ごと逆順にして複数tick回すと「誰が何番目にrng.chance()を引くか」が
  // 変わり、Phase 6と無関係に(元々そういう仕様の)異なる乱数列を消費して別の軌跡になる
  // (社会的decisionのagent配列順への非依存はもともと契約されていない)。Phase 6が実際に契約しているのは
  // 「空間計算(cluster repulsion/occupancy/crowding/候補選択score)自体」の配列順非依存
  // (各module冒頭のコメント、`spatialDynamics.test.ts`等で単体検証済み)なので、ここでは実runから
  // 得た現実的なsnapshotに対し、それらの純粋関数を直接、配列順を変えて呼び出して一致を確認する。
  it("実runのsnapshotに対し、cluster repulsion/crowding/候補選択列挙をagents・candidates配列順を変えて呼んでも一致する", () => {
    const presetId = "standing-party-spatial-roaming";
    const preset = getPresetById(presetId);
    const formation = formationOptionsFor(presetId);
    const config = formation.standingPartyConfig!.spatialDynamics;
    const seed = 77;
    const rng = new SeededRandom(seed);
    let state = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
    for (let i = 0; i < 60; i++) {
      state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
    }
    const confirmedClusters = state.groupCandidates.filter((c) => c.status === "confirmed");
    expect(confirmedClusters.length, "fixtureはconfirmed clusterを含む必要がある").toBeGreaterThan(0);

    // 1. cluster repulsion: candidates/agents配列順を変えても、各clusterのvelocity/座標(id別)は一致する
    //    (内部でid昇順に安定ソートしてから計算するため、浮動小数点の加算順序自体が変わらない)。
    const previousVelocity = state.spatialRuntimeState?.clusterVelocity ?? {};
    const candidatesA = state.groupCandidates.map((c) => ({ ...c }));
    const agentsA = state.agents.map((a) => ({ ...a }));
    const resultA = applyClusterSpatialDynamics(candidatesA, agentsA, config, previousVelocity);
    const candidatesB = [...state.groupCandidates].reverse().map((c) => ({ ...c }));
    const agentsB = [...state.agents].reverse().map((a) => ({ ...a }));
    const resultB = applyClusterSpatialDynamics(candidatesB, agentsB, config, previousVelocity);
    expect(resultB.clusterVelocity).toEqual(resultA.clusterVelocity);
    const byIdA = new Map(candidatesA.map((c) => [c.id, { x: c.x, y: c.y }] as const));
    for (const c of candidatesB) expect(byIdA.get(c.id)).toEqual({ x: c.x, y: c.y });
    const memberByIdA = new Map(agentsA.map((a) => [a.id, { x: a.x, y: a.y }] as const));
    for (const a of agentsB) expect(memberByIdA.get(a.id)).toEqual({ x: a.x, y: a.y });

    // 2. crowding vector: agents/candidates配列順を変えても、実質的に同じpush(浮動小数点誤差程度の
    //    許容差内)になる(加算順序が変わるため、bit-exactな一致までは要求しない)。
    const undecidedAgent = state.agents.find((a) => a.state === "undecided");
    if (undecidedAgent) {
      const forwardCrowd = computeCrowdingVector(undecidedAgent, state.agents, state.groupCandidates, config);
      const reversedCrowd = computeCrowdingVector(
        undecidedAgent,
        [...state.agents].reverse(),
        [...state.groupCandidates].reverse(),
        config,
      );
      expect(reversedCrowd.crowded).toBe(forwardCrowd.crowded);
      expect(reversedCrowd.localDensity).toBeCloseTo(forwardCrowd.localDensity, 9);
      expect(reversedCrowd.vectorX).toBeCloseTo(forwardCrowd.vectorX, 9);
      expect(reversedCrowd.vectorY).toBeCloseTo(forwardCrowd.vectorY, 9);
    }

    // 3. 候補列挙: candidates配列順を変えても、列挙される候補集合・距離は完全一致する
    if (undecidedAgent) {
      const capacityOf = () => ({ minGroupSize: 2, maxGroupSize: 8 });
      const forwardObserved = enumerateClusterSearchCandidates(undecidedAgent, state.groupCandidates, capacityOf, undefined, config);
      const reversedObserved = enumerateClusterSearchCandidates(
        undecidedAgent,
        [...state.groupCandidates].reverse(),
        capacityOf,
        undefined,
        config,
      );
      expect(reversedObserved).toEqual(forwardObserved);
    }
  });

  it("pause/resume(UIの一時停止)は状態・event・main PRNG系列を変えない(同じtick数なら同一結果)", () => {
    const formation: FormationRuntimeOptions = {
      scenarioId: "standingParty",
      standingPartyConfig: SPATIAL_ROAMING_STANDING_PARTY_CONFIG,
    };
    const preset = getPresetById("standing-party-spatial-roaming");
    const seed = 88;
    const totalTicks = 80;

    function run(): { state: SimulationState; rngProbe: number } {
      const rng = new SeededRandom(seed);
      let state = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
      for (let i = 0; i < totalTicks; i++) {
        state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
        // pauseはUI側でsetIntervalを止めるだけであり、stateへは一切触れない(何もしないこと自体を確認する)
      }
      return { state, rngProbe: rng.next() };
    }

    expect(run()).toEqual(run());
  });
});

// ================================================================================================
// 4〜5. paired seed: 空間局所固定の改善 + 逆方向の退化防止(凝集維持)
// ================================================================================================

describe("Issue #252: paired seedでの空間分散改善と凝集維持", () => {
  const SEEDS = [101, 102, 103, 104] as const;
  const TICKS = 400;
  const SAMPLE_EVERY = 20;
  const GRID_COLS = 8;
  const GRID_ROWS = 5;

  type RunAggregate = {
    coverageRates: number[];
    visitedZones: Set<string>;
    roamingSpeedSum: number;
    nearestNeighborMedians: number[];
    localDensityP90s: number[];
    overlapRates: number[];
    activeClusterTicks: number;
    sampledTicks: number;
    joinedRatios: number[];
    completedEpisode: boolean;
    nonTrivialContactEdges: boolean;
  };

  function runAndAggregate(presetId: string, seed: number): RunAggregate {
    const preset = getPresetById(presetId);
    const formation = formationOptionsFor(presetId);
    const spatialConfig = formation.standingPartyConfig!.spatialDynamics;
    const rng = new SeededRandom(seed);
    let state = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);

    const aggregate: RunAggregate = {
      coverageRates: [],
      visitedZones: new Set(),
      roamingSpeedSum: 0,
      nearestNeighborMedians: [],
      localDensityP90s: [],
      overlapRates: [],
      activeClusterTicks: 0,
      sampledTicks: 0,
      joinedRatios: [],
      completedEpisode: false,
      nonTrivialContactEdges: false,
    };

    for (let i = 0; i < TICKS; i++) {
      state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
      if (state.log.some((e) => e.eventType === "clusterDepartureCompleted")) {
        aggregate.completedEpisode = true;
      }
      if (state.tick % SAMPLE_EVERY !== 0) continue;

      const analysis = buildStandingPartySpatialAnalysis(state, spatialConfig);
      aggregate.sampledTicks += 1;
      if (analysis.snapshot.occupiedCells.rate !== undefined) {
        aggregate.coverageRates.push(analysis.snapshot.occupiedCells.rate);
      }
      for (const agent of state.agents) {
        aggregate.visitedZones.add(cellIndexOf(agent.x, agent.y, GRID_COLS, GRID_ROWS));
      }
      for (const agentSnapshot of analysis.agents) {
        aggregate.roamingSpeedSum += agentSnapshot.instantRoamingSpeed ?? 0;
      }
      if (analysis.snapshot.clusterNearestNeighborDistance.median !== undefined) {
        aggregate.nearestNeighborMedians.push(analysis.snapshot.clusterNearestNeighborDistance.median);
      }
      if (analysis.snapshot.localDensity.p90 !== undefined) {
        aggregate.localDensityP90s.push(analysis.snapshot.localDensity.p90);
      }
      if (analysis.snapshot.clusterOverlapRate.rate !== undefined) {
        aggregate.overlapRates.push(analysis.snapshot.clusterOverlapRate.rate);
      }
      if (analysis.snapshot.activeClusterCount > 0) aggregate.activeClusterTicks += 1;
      const joinedCount = state.agents.filter((a) => a.state === "joined").length;
      aggregate.joinedRatios.push(joinedCount / state.agents.length);
    }

    const network = buildStandingPartyContactNetwork(state);
    aggregate.nonTrivialContactEdges = network.edges.length > 0;
    return aggregate;
  }

  const mean = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);

  it("空間分散: 有効化preset(spatial-roaming)は基準preset(spatial-fixed-baseline)より、同一seed集合でaggregateしたspatial coverage/訪問zone数/roaming速度がpaired比較で実質的に増加する", () => {
    const enabledRuns = SEEDS.map((seed) => runAndAggregate("standing-party-spatial-roaming", seed));
    const baselineRuns = SEEDS.map((seed) => runAndAggregate("standing-party-spatial-fixed-baseline", seed));

    const enabledCoverage = mean(enabledRuns.flatMap((r) => r.coverageRates));
    const baselineCoverage = mean(baselineRuns.flatMap((r) => r.coverageRates));
    expect(enabledCoverage, "有効化presetのspatial coverageは基準より観察可能な差で高い").toBeGreaterThan(baselineCoverage);

    const enabledZones = mean(enabledRuns.map((r) => r.visitedZones.size));
    const baselineZones = mean(baselineRuns.map((r) => r.visitedZones.size));
    expect(enabledZones, "有効化presetは基準より多くの計測grid zoneを訪問する").toBeGreaterThanOrEqual(baselineZones);

    const enabledRoamingSpeedSum = mean(enabledRuns.map((r) => r.roamingSpeedSum));
    const baselineRoamingSpeedSum = mean(baselineRuns.map((r) => r.roamingSpeedSum));
    expect(
      enabledRoamingSpeedSum,
      "有効化presetは基準(roaming無効)よりroaming移動量の合計(累積距離の代替指標)が大きい",
    ).toBeGreaterThan(baselineRoamingSpeedSum);

    const enabledNearestNeighbor = mean(enabledRuns.flatMap((r) => r.nearestNeighborMedians));
    const baselineNearestNeighbor = mean(baselineRuns.flatMap((r) => r.nearestNeighborMedians));
    // cluster間最近接距離が縮む(過密化する)方向には動いていないことを確認する(要求は「増加または過密時間率減少」)
    expect(enabledNearestNeighbor >= baselineNearestNeighbor * 0.9, "cluster間最近接距離が基準より大きく縮小していない").toBe(true);
  }, 180_000);

  it("凝集維持: 空間分散が働いても、cluster形成・joined比率・完了episode・接触networkが崩壊しない(paired baseline比較)", () => {
    let anyCompletedEpisode = false;
    let anyContactEdges = false;
    for (const seed of SEEDS) {
      const enabled = runAndAggregate("standing-party-spatial-roaming", seed);
      // active cluster形成・joined比率は基本的な凝集の前提であり、全seedで一貫して成立する必要がある。
      expect(enabled.activeClusterTicks, `seed=${seed}: active clusterが継続的に0件のままにならない`).toBeGreaterThan(0);
      expect(mean(enabled.joinedRatios), `seed=${seed}: joined比率がほぼ0へ崩壊しない`).toBeGreaterThan(0.1);
      if (enabled.completedEpisode) anyCompletedEpisode = true;
      if (enabled.nonTrivialContactEdges) anyContactEdges = true;
    }
    // 完了episode・接触edgeの発生tickは確率的(いつ・誰が離脱するか)なので、CLAUDE.mdのpreset 5検証と
    // 同じ方針で「複数seedのうち少なくとも1つ」で発生することを確認する(全seedへの単調要求はしない)。
    expect(anyCompletedEpisode, "少なくとも1seedで完了した会話episodeが発生する").toBe(true);
    expect(anyContactEdges, "少なくとも1seedで接触networkに非自明なedgeが形成される").toBe(true);
  }, 120_000);

  it("壁/角への集中: 有効化presetは基準presetと比べて壁際・角セルへの集中が悪化しない", () => {
    const isCornerCell = (row: number, col: number): boolean =>
      (row === 0 || row === GRID_ROWS - 1) && (col === 0 || col === GRID_COLS - 1);
    const isWallCell = (row: number, col: number): boolean =>
      row === 0 || row === GRID_ROWS - 1 || col === 0 || col === GRID_COLS - 1;

    function wallAndCornerRatios(presetId: string): { wallRatio: number; cornerRatio: number } {
      const preset = getPresetById(presetId);
      const formation = formationOptionsFor(presetId);
      const rng = new SeededRandom(201);
      let state = createInitialState(201, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
      let wallCount = 0;
      let cornerCount = 0;
      let total = 0;
      for (let i = 0; i < TICKS; i++) {
        state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
        if (state.tick % SAMPLE_EVERY !== 0) continue;
        for (const agent of state.agents) {
          const cell = cellIndexOf(agent.x, agent.y, GRID_COLS, GRID_ROWS);
          const [row, col] = cell.split(":").map(Number);
          total += 1;
          if (isWallCell(row, col)) wallCount += 1;
          if (isCornerCell(row, col)) cornerCount += 1;
        }
      }
      return { wallRatio: total === 0 ? 0 : wallCount / total, cornerRatio: total === 0 ? 0 : cornerCount / total };
    }

    const enabled = wallAndCornerRatios("standing-party-spatial-roaming");
    const baseline = wallAndCornerRatios("standing-party-spatial-fixed-baseline");
    expect(enabled.wallRatio, "有効化presetの壁際滞在率が基準より大幅に高くない").toBeLessThanOrEqual(baseline.wallRatio + 0.35);
    expect(enabled.cornerRatio, "有効化presetの角滞在率が基準より大幅に高くない").toBeLessThanOrEqual(baseline.cornerRatio + 0.2);
  }, 60_000);
});

// ================================================================================================
// 8. oscillation/limit cycle検証
// ================================================================================================

describe("Issue #252: oscillation/limit cycle検証", () => {
  it("roaming headingは設定した最小hold tick未満の頻度では切り替わらない(震え続けない)", () => {
    const formation: FormationRuntimeOptions = {
      scenarioId: "standingParty",
      standingPartyConfig: SPATIAL_ROAMING_STANDING_PARTY_CONFIG,
    };
    const config = SPATIAL_ROAMING_STANDING_PARTY_CONFIG.spatialDynamics;
    const preset = getPresetById("standing-party-spatial-roaming");
    const seed = 303;
    const rng = new SeededRandom(seed);
    let state = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);

    const headingChangeCounts = new Map<string, number>();
    const lastHeading = new Map<string, number>();
    const ticks = 500;
    for (let i = 0; i < ticks; i++) {
      state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
      const roaming = state.spatialRuntimeState?.roaming ?? {};
      for (const [agentId, roam] of Object.entries(roaming)) {
        const prev = lastHeading.get(agentId);
        if (prev !== undefined && prev !== roam.headingRadians) {
          headingChangeCounts.set(agentId, (headingChangeCounts.get(agentId) ?? 0) + 1);
        }
        lastHeading.set(agentId, roam.headingRadians);
      }
    }

    const maxPlausibleChanges = Math.ceil(ticks / config.roamingHeadingHoldTicksMin) + 1;
    for (const [agentId, changes] of headingChangeCounts) {
      expect(
        changes,
        `agent=${agentId}のheading切替回数(${changes})がroamingHeadingHoldTicksMin(${config.roamingHeadingHoldTicksMin})から見て高頻度すぎる`,
      ).toBeLessThanOrEqual(maxPlausibleChanges);
    }
  }, 30_000);

  it("confirmed cluster中心のvelocity符号は毎tick反転しない(高周波振動が起きていない)", () => {
    const config = { ...DEFAULT_SPATIAL_DYNAMICS_CONFIG, enabled: true };
    const clusterA = makeCandidate({ id: "a", x: 380, y: 260, memberIds: [], status: "confirmed" });
    const clusterB = makeCandidate({ id: "b", x: 420, y: 260, memberIds: [], status: "confirmed" });
    const candidates = [clusterA, clusterB];

    let previousVelocity: Record<string, { vx: number; vy: number }> = {};
    let signFlips = 0;
    let lastSign: number | undefined;
    const ticks = 100;
    for (let i = 0; i < ticks; i++) {
      const result = applyClusterSpatialDynamics(candidates, [], config, previousVelocity);
      previousVelocity = result.clusterVelocity;
      const vx = previousVelocity["a"]?.vx ?? 0;
      const sign = Math.sign(vx);
      if (sign !== 0 && lastSign !== undefined && sign !== lastSign) signFlips += 1;
      if (sign !== 0) lastSign = sign;
    }
    expect(signFlips / ticks, "cluster velocityのx成分符号が毎tick反転していない").toBeLessThan(0.5);
  });
});

// ================================================================================================
// 6. Phase 5情報伝播とのcross-feature検証
// ================================================================================================

describe("Issue #252: Phase 5情報伝播とのcross-feature検証", () => {
  const SPATIAL_AND_INFO_CONFIG: StandingPartyScenarioConfig = {
    ...SPATIAL_ROAMING_STANDING_PARTY_CONFIG,
    informationPropagation: INFO_RICH_STANDING_PARTY_CONFIG.informationPropagation,
  };
  validateStandingPartyScenarioConfig(SPATIAL_AND_INFO_CONFIG);

  it("spatialDynamicsとinformationPropagationを同時に有効化しても、content utterance/heard/adoptedが0へ退化しない(複数seedのうち少なくとも1つ)", () => {
    const formation: FormationRuntimeOptions = { scenarioId: "standingParty", standingPartyConfig: SPATIAL_AND_INFO_CONFIG };
    const preset = getPresetById("standing-party-spatial-roaming");
    const ticks = 500;
    const seeds = [7, 29];

    let anyUtterance = false;
    let anyReception = false;
    let anyAdoption = false;
    for (const seed of seeds) {
      const rng = new SeededRandom(seed);
      let state = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
      for (let i = 0; i < ticks; i++) {
        state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
        assertStandingPartyInvariants(state, { maxEmptyFormingAge: POLICY.defaultMaxAge, label: `cross-feature seed=${seed} tick=${state.tick}` });
        assertStandingPartySpatialInvariants(state, SPATIAL_AND_INFO_CONFIG.spatialDynamics, `cross-feature seed=${seed} tick=${state.tick}`);
      }
      if ((state.contentUtteranceLog?.length ?? 0) > 0) anyUtterance = true;
      if ((state.informationReceptionLog?.length ?? 0) > 0) anyReception = true;
      if ((state.informationAdoptionLog?.length ?? 0) > 0) anyAdoption = true;
    }

    expect(anyUtterance, "少なくとも1seedでcontent utteranceが発生する").toBe(true);
    expect(anyReception, "少なくとも1seedでheard(reception)が発生する").toBe(true);
    expect(anyAdoption, "少なくとも1seedでadoptedが発生する").toBe(true);
  }, 180_000);
});

// ================================================================================================
// 10. feature disabled互換
// ================================================================================================

describe("Issue #252: Spatial Dynamics disabled時の互換性(disabled parityは特定の数値に依存しない)", () => {
  it("enabled: falseの間は、spatialDynamicsの他フィールドの値に関わらず同一の軌跡になる(no-op不変条件)", () => {
    const preset = getPresetById("standing-party-spatial-fixed-baseline");
    const seed = 909;
    const ticks = 300;

    const configA: StandingPartyScenarioConfig = {
      ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
      spatialDynamics: { ...DEFAULT_SPATIAL_DYNAMICS_CONFIG, enabled: false },
    };
    const configB: StandingPartyScenarioConfig = {
      ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
      spatialDynamics: {
        ...DEFAULT_SPATIAL_DYNAMICS_CONFIG,
        enabled: false,
        // 数値field自体は大きく変えておく。enabled:falseならこれらは一切読まれないはず。
        repulsionStrength: 99,
        roamingSpeed: 99,
        crowdRepulsionStrength: 99,
        candidateSelectionEnabled: true,
        candidateSelectionMinScore: 0,
      },
    };
    validateStandingPartyScenarioConfig(configA);
    validateStandingPartyScenarioConfig(configB);

    function run(config: StandingPartyScenarioConfig): SimulationState {
      const formation: FormationRuntimeOptions = { scenarioId: "standingParty", standingPartyConfig: config };
      const rng = new SeededRandom(seed);
      let state = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
      for (let i = 0; i < ticks; i++) {
        state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
      }
      return state;
    }

    const resultA = run(configA);
    const resultB = run(configB);
    expect(resultB.agents).toEqual(resultA.agents);
    expect(resultB.groupCandidates).toEqual(resultA.groupCandidates);
    expect(resultB.spatialRuntimeState).toEqual(resultA.spatialRuntimeState);
    expect(resultB.log).toEqual(resultA.log);
  }, 60_000);
});

// ================================================================================================
// 11. Spatial analysis/export cross-check
// ================================================================================================

describe("Issue #252: Spatial analysis/exportのcross-check", () => {
  it("buildStandingPartyAnalysisExportのspatialDynamics fieldはbuildStandingPartySpatialAnalysisと一致し、CSVは非介入(state/PRNG非変更)", () => {
    const presetId = "standing-party-spatial-roaming";
    const preset = getPresetById(presetId);
    const formation = formationOptionsFor(presetId);
    const config = formation.standingPartyConfig!.spatialDynamics;
    const seed = 55;
    const rng = new SeededRandom(seed);
    let state = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
    for (let i = 0; i < 150; i++) {
      state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
    }

    const beforeLog = JSON.stringify(state);
    const analysis = buildStandingPartySpatialAnalysis(state, config);
    const bundle = buildStandingPartyAnalysisExport(state, { presetId, standingPartyConfig: formation.standingPartyConfig });
    const csvFiles = buildStandingPartyAnalysisCsvFiles(bundle);
    expect(JSON.stringify(state), "analysis/export呼び出しはstateをmutationしない").toBe(beforeLog);

    expect(bundle.spatialDynamics.snapshot).toEqual(analysis.snapshot);
    expect(bundle.spatialDynamics.agents).toEqual(analysis.agents);
    expect(bundle.spatialDynamics.clusters).toEqual(analysis.clusters);
    expect(bundle.spatialDynamics.enabled).toBe(true);

    expect(csvFiles.some((f) => f.filename === "standing-party-spatial-agent-stats.csv")).toBe(true);
    expect(csvFiles.some((f) => f.filename === "standing-party-spatial-cluster-stats.csv")).toBe(true);

    // occupiedCellsはraw agent座標からの再計算と一致する(手計算による相互検証)
    const presentAgents = state.agents.filter(isPresentForOccupancy);
    const occupied = new Set<string>();
    for (const agent of presentAgents) {
      occupied.add(cellIndexOf(agent.x, agent.y, 8, 5));
    }
    expect(analysis.snapshot.occupiedCells.numerator).toBe(occupied.size);
    expect(analysis.snapshot.occupiedCells.denominator).toBe(8 * 5);
  });
});
