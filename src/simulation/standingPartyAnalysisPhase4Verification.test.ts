/**
 * Issue #218 (standing-party Phase 4 統合検証): 決定的fixture・event cross-check・
 * 長時間安定性・分析非介入・export整合・性能スモークをまとめて固定する。
 *
 * #212〜#217のモジュール単位テストが既に満たす部分は再実装せず、横断検証だけを追加する。
 * 詳細な棚卸しは`docs/standing-party-phase4-verification.md`。
 */
import { describe, expect, it } from "vitest";
import {
  buildStandingPartyAnalysisCsvFiles,
  buildStandingPartyAnalysisExport,
  serializeStandingPartyAnalysisExport,
} from "./analysisExport";
import { createInitialState, stepSimulation } from "./engine";
import { getFormationPolicyById, type FormationRuntimeOptions } from "./formationPolicy";
import { SeededRandom } from "./random";
import { getPresetById } from "./presets";
import {
  assertHistoryDoesNotMutateState,
  buildStandingPartyContactNetwork,
  buildStandingPartyConversationHistory,
  buildStandingPartyRunStatistics,
  createClusterTransitionId,
} from "./standingPartyAnalysis";
import { assertStandingPartyAnalysisInvariants } from "./standingPartyAnalysisInvariants";
import { assertStandingPartyInvariants } from "./standingPartyInvariants";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG } from "./standingPartyScenarioConfig";
import type { Agent, GroupCandidate, LogEntry, SimulationState } from "./types";

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

function entry(
  tick: number,
  eventType: LogEntry["eventType"],
  metadata: NonNullable<LogEntry["metadata"]>,
): LogEntry {
  return { tick, message: `t=${tick}`, tags: [], eventType, metadata };
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
    seed: 42,
    ...overrides,
  };
}

/**
 * Issue #218 1節: 決定的履歴fixture。
 *
 * cluster A形成 → 1・2 join(contact開始) → 3参加(3pair) → 1自発離脱+target選択
 * → Bへjoin(新episode) → A最小人数割れで強制release → horizon打切りでBがactive。
 */
function buildDeterministicPhase4Fixture(): SimulationState {
  return makeState({
    tick: 50,
    finished: true,
    agents: [
      makeAgent({
        id: "1",
        label: "1",
        state: "joined",
        joinedGroupId: "B",
        currentEpisode: {
          episodeId: "1:B:30",
          clusterId: "B",
          joinedAtTick: 30,
          lastUpdatedTick: 50,
          memberCountAtJoin: 2,
          lastObservedMemberCount: 2,
        },
      }),
      makeAgent({ id: "2", label: "2", state: "undecided" }),
      makeAgent({ id: "3", label: "3", state: "undecided" }),
      makeAgent({
        id: "4",
        label: "4",
        state: "joined",
        joinedGroupId: "B",
        currentEpisode: {
          episodeId: "4:B:22",
          clusterId: "B",
          joinedAtTick: 22,
          lastUpdatedTick: 50,
          memberCountAtJoin: 1,
          lastObservedMemberCount: 2,
        },
      }),
    ],
    groupCandidates: [
      makeCandidate({
        id: "A",
        status: "dissolved",
        memberIds: [],
      }),
      makeCandidate({
        id: "B",
        status: "confirmed",
        memberIds: ["4", "1"],
      }),
    ],
    log: [
      // cluster A: Gap Bでfounder(1)のepisodeがconfirm時に開始
      entry(1, "nucleusCreated", { agentId: "1", groupId: "A" }),
      entry(2, "groupConfirmed", { groupId: "A", memberCount: 1 }),
      // agent 2 join → contact 1-2開始
      entry(5, "agentJoined", {
        agentId: "2",
        groupId: "A",
        episodeId: "2:A:5",
        joinedGroupStatus: "confirmed",
        memberCount: 2,
      }),
      // agent 3途中参加 → 3 pair
      entry(10, "agentJoined", {
        agentId: "3",
        groupId: "A",
        episodeId: "3:A:10",
        joinedGroupStatus: "confirmed",
        memberCount: 3,
      }),
      // agent 1自発離脱 + targeted transition (episode 1:A:2, dwell=18)
      entry(20, "clusterDepartureCompleted", {
        agentId: "1",
        groupId: "A",
        episodeId: "1:A:2",
        episodeEndReason: "voluntaryDeparture",
        transitionAction: "switchToTargetCluster",
        targetClusterId: "B",
        ticksInCluster: 18,
      }),
      entry(20, "clusterTransitionTargetSelected", {
        agentId: "1",
        groupId: "A",
        targetClusterId: "B",
        focusAgentId: "4",
      }),
      // cluster B: Gap Bでfounder(4)のepisodeがconfirm時に開始
      entry(20, "nucleusCreated", { agentId: "4", groupId: "B" }),
      entry(22, "groupConfirmed", { groupId: "B", memberCount: 1 }),
      // agent 1がBへjoin・transition完了 → contact 1-4開始
      entry(30, "agentJoined", {
        agentId: "1",
        groupId: "B",
        episodeId: "1:B:30",
        joinedGroupStatus: "confirmed",
        memberCount: 2,
      }),
      entry(30, "clusterTransitionCompleted", {
        agentId: "1",
        groupId: "B",
        targetClusterId: "B",
        episodeId: "1:B:30",
        focusAgentId: "4",
      }),
      // Aが最小人数割れ → 残存member強制release
      entry(35, "clusterMemberReleased", {
        agentId: "2",
        groupId: "A",
        episodeId: "2:A:5",
        episodeEndReason: "memberReleased",
        ticksInCluster: 30,
      }),
      entry(35, "clusterMemberReleased", {
        agentId: "3",
        groupId: "A",
        episodeId: "3:A:10",
        episodeEndReason: "memberReleased",
        ticksInCluster: 25,
      }),
      entry(35, "activeClusterDissolved", {
        groupId: "A",
        memberCount: 0,
      }),
      entry(50, "simulationFinished", { finishReason: "observationHorizonReached" }),
    ],
  });
}

describe("Issue #218: 決定的履歴fixture", () => {
  it("join〜contact〜離脱〜target移動〜強制release〜active打切りを再現する", () => {
    const state = buildDeterministicPhase4Fixture();
    const history = buildStandingPartyConversationHistory(state);
    const network = buildStandingPartyContactNetwork(state, { history });
    const statistics = buildStandingPartyRunStatistics(state, { history, network });

    assertStandingPartyAnalysisInvariants(history, network, statistics, {
      label: "deterministic-fixture",
      state,
    });

    // episodes: 1@A(Gap B, completed targeted), 2@A, 3@A, 4@B(Gap B, censored), 1@B(censored)
    expect(history.episodes).toHaveLength(5);
    const byId = Object.fromEntries(history.episodes.map((e) => [e.episodeId, e]));
    expect(byId["1:A:2"]).toMatchObject({
      endReason: "targetedTransition",
      status: "completed",
      dwellTicks: 18,
    });
    expect(byId["2:A:5"]).toMatchObject({ endReason: "memberReleased", status: "completed", dwellTicks: 30 });
    expect(byId["3:A:10"]).toMatchObject({ endReason: "memberReleased", status: "completed", dwellTicks: 25 });
    expect(byId["1:B:30"].status).toBe("censored");
    expect(byId["4:B:22"].status).toBe("censored");
    expect(byId["1:B:30"].endedAtTick).toBeUndefined();
    expect(byId["4:B:22"].endedAtTick).toBeUndefined();

    // A上で3人同時所属時は3 pair contact
    const contactsOnA = network.contactIntervals.filter((c) => c.clusterId === "A");
    expect(contactsOnA).toHaveLength(3);
    // 1-2: [5,20), 1-3: [10,20), 2-3: [10,35)
    expect(contactsOnA.find((c) => c.agentIdA === "1" && c.agentIdB === "2")?.dwellTicks).toBe(15);
    expect(contactsOnA.find((c) => c.agentIdA === "1" && c.agentIdB === "3")?.dwellTicks).toBe(10);
    expect(contactsOnA.find((c) => c.agentIdA === "2" && c.agentIdB === "3")?.dwellTicks).toBe(25);

    // B上の1-4 contactはactive/censoredのまま (1 joins at 30, 4 was in since 22)
    const contactsOnB = network.contactIntervals.filter((c) => c.clusterId === "B");
    expect(contactsOnB).toHaveLength(1);
    expect(contactsOnB[0]).toMatchObject({
      agentIdA: "1",
      agentIdB: "4",
      status: "censored",
      startedAtTick: 30,
    });
    expect(contactsOnB[0].endedAtTick).toBeUndefined();
    expect(contactsOnB[0].dwellTicks).toBe(20); // 50 - 30

    // transition完了
    expect(history.transitions).toHaveLength(1);
    expect(history.transitions[0]).toMatchObject({
      transitionId: createClusterTransitionId("1", "A", 20),
      result: "completed",
      sourceEpisodeId: "1:A:2",
      targetEpisodeId: "1:B:30",
    });

    // A lifetime完了、Bはcensored/active
    const lifeA = history.clusterLifetimes.find((l) => l.clusterId === "A")!;
    const lifeB = history.clusterLifetimes.find((l) => l.clusterId === "B")!;
    expect(lifeA.status).toBe("completed");
    expect(lifeA.forcedReleaseCount).toBe(2);
    expect(lifeA.voluntaryLeaveCount).toBe(1);
    expect(lifeB.status).toBe("censored");
    expect(lifeB.endedAtTick).toBeUndefined();

    // 統計: targetedはvoluntaryDepartureCountに混ぜず、強制releaseは別集計。完了分布にcensoredを混ぜない
    expect(statistics.run.voluntaryDepartureCount).toBe(0);
    expect(statistics.run.forcedReleaseCount).toBe(2);
    expect(statistics.run.targetedTransitionSuccessCount).toBe(1);
    expect(statistics.run.completedEpisodeCount).toBe(3);
    expect(statistics.run.activeEpisodeCount).toBe(2);
    expect(statistics.run.completedEpisodeDwellTicks.count).toBe(3);

    // cleanup後もcompleted historyは残る(Aはdissolvedだがlifetime/episodesあり)
    expect(state.groupCandidates.find((c) => c.id === "A")?.status).toBe("dissolved");
    expect(history.episodes.filter((e) => e.clusterId === "A")).toHaveLength(3);
  });
});

describe("Issue #218: event cross-check", () => {
  it("構造化event件数・IDと履歴レコードを照合し二重計上・欠落を検出できる", () => {
    const state = buildDeterministicPhase4Fixture();
    const history = buildStandingPartyConversationHistory(state);

    // join系イベント由来のepisodeId(Gap B founderはgroupConfirmedから別途開始)
    const joinEpisodeIds = new Set<string>();
    for (const e of state.log) {
      if (
        e.eventType === "agentJoined" ||
        e.eventType === "observerJoinedForming" ||
        e.eventType === "observerJoinedConfirmed" ||
        e.eventType === "clusterRejoined" ||
        e.eventType === "clusterTransitionCompleted"
      ) {
        const id = e.metadata?.episodeId;
        if (typeof id === "string") joinEpisodeIds.add(id);
      }
    }
    const gapBFounders = ["1:A:2", "4:B:22"];
    for (const id of gapBFounders) {
      expect(history.episodes.some((e) => e.episodeId === id), `Gap B episode欠落 ${id}`).toBe(true);
    }
    for (const id of joinEpisodeIds) {
      expect(history.episodes.some((e) => e.episodeId === id), `join episode欠落 ${id}`).toBe(true);
    }
    expect(history.episodes).toHaveLength(joinEpisodeIds.size + gapBFounders.length);

    const voluntaryEvents = state.log.filter((e) => e.eventType === "clusterDepartureCompleted");
    const releasedEvents = state.log.filter((e) => e.eventType === "clusterMemberReleased");
    expect(
      history.episodes.filter(
        (e) => e.endReason === "targetedTransition" || e.endReason === "voluntaryDeparture",
      ),
    ).toHaveLength(voluntaryEvents.length);
    expect(history.episodes.filter((e) => e.endReason === "memberReleased")).toHaveLength(releasedEvents.length);

    const selected = state.log.filter((e) => e.eventType === "clusterTransitionTargetSelected");
    const completed = state.log.filter((e) => e.eventType === "clusterTransitionCompleted");
    expect(selected).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(history.transitions.filter((t) => t.result === "completed")).toHaveLength(1);

    // message文字列は参照せずeventType/metadataだけで突合できていること(ここではmessageを使っていない)
    for (const e of state.log) {
      expect(e.eventType).toBeTruthy();
    }
  });
  it("同一episodeIdのjoin系二重イベントは履歴1件に畳み、duplicate診断を残す", () => {
    const state = makeState({
      tick: 5,
      agents: [makeAgent({ id: "a", state: "joined", joinedGroupId: "g1" })],
      log: [
        entry(1, "nucleusCreated", { agentId: "a", groupId: "g1" }),
        entry(2, "agentJoined", {
          agentId: "a",
          groupId: "g1",
          episodeId: "a:g1:2",
          joinedGroupStatus: "confirmed",
        }),
        // ObserverJoiner専用joinが同じepisodeIdで続いても二重計上しない
        entry(2, "observerJoinedConfirmed", {
          agentId: "a",
          groupId: "g1",
          episodeId: "a:g1:2",
          joinedGroupStatus: "confirmed",
        }),
      ],
    });
    const history = buildStandingPartyConversationHistory(state);
    expect(history.episodes).toHaveLength(1);
    expect(history.diagnostics.some((d) => d.code === "duplicateEpisodeStart")).toBe(true);
  });
});

describe("Issue #218: export整合・決定性", () => {
  it("JSON/CSV exportの統計値が同一導出のUI統計と一致し、schema・決定性がある", () => {
    const state = buildDeterministicPhase4Fixture();
    const history = buildStandingPartyConversationHistory(state);
    const network = buildStandingPartyContactNetwork(state, { history });
    const statistics = buildStandingPartyRunStatistics(state, { history, network });
    const bundle = buildStandingPartyAnalysisExport(state, {
      history,
      network,
      statistics,
      presetId: "standing-party",
      standingPartyConfig: DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
    });

    expect(bundle.statistics.run.completedEpisodeCount).toBe(statistics.run.completedEpisodeCount);
    expect(bundle.statistics.run.voluntaryDepartureCount).toBe(statistics.run.voluntaryDepartureCount);
    expect(bundle.statistics.run.forcedReleaseCount).toBe(statistics.run.forcedReleaseCount);
    expect(bundle.statistics.run.network.edgeCount).toBe(network.metrics.edgeCount);
    expect(bundle.history.episodes).toEqual(history.episodes);
    expect(bundle.run.seed).toBe(42);
    expect(bundle.run.observationHorizon.asOfTick).toBe(50);
    expect(bundle.schemaVersion).toContain("standing-party-analysis-export/");

    const json1 = serializeStandingPartyAnalysisExport(bundle);
    const json2 = serializeStandingPartyAnalysisExport(
      buildStandingPartyAnalysisExport(state, {
        history,
        network,
        statistics,
        presetId: "standing-party",
        standingPartyConfig: DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
      }),
    );
    expect(json1).toBe(json2);

    const csvFiles = buildStandingPartyAnalysisCsvFiles(bundle);
    expect(csvFiles.map((f) => f.filename).sort()).toEqual(
      [
        "standing-party-agent-statistics.csv",
        "standing-party-cluster-statistics.csv",
        "standing-party-contact-edges.csv",
        "standing-party-contact-intervals.csv",
        "standing-party-episodes.csv",
        "standing-party-transitions.csv",
      ].sort(),
    );
    const episodeCsv = csvFiles.find((f) => f.filename.includes("episodes"))!;
    const episodeRows = episodeCsv.content.split("\n").filter((line) => line.trim().length > 0);
    expect(episodeRows.length - 1).toBe(history.episodes.length); // header除外
    // presentation情報(UI選択・DOM状態)を含めない
    expect(json1).not.toContain("selectedAgentId");
    expect(json1).not.toContain("historyTickWindow");
  });
});

const PHASE4_PRESET_IDS = ["standing-party-outward-interest", "standing-party-current-circle"] as const;
const SEEDS = [1, 2, 3];
const LONG_TICKS = 1000;

function formationOptionsFor(presetId: string): FormationRuntimeOptions {
  const preset = getPresetById(presetId);
  return {
    scenarioId: "standingParty",
    standingPartyConfig: preset.formationStandingPartyConfig ?? DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  };
}

function speechConfigsOn() {
  return {
    speechEffects: { enabled: true },
    socialExpression: { enabled: true },
    speechTrust: { enabled: true },
    relationshipTie: { enabled: true },
  } as const;
}

describe("Issue #218: 1000tick・複数seedでの分析層安定性", () => {
  it.each(PHASE4_PRESET_IDS)(
    "プリセット「%s」でhistory/network/statisticsに孤児・重複・NaN・負durationが無い",
    (presetId) => {
      const preset = getPresetById(presetId);
      const formation = formationOptionsFor(presetId);
      const formationPolicy = getFormationPolicyById("standingParty");
      const speech = speechConfigsOn();

      for (const seed of SEEDS) {
        const rng = new SeededRandom(seed);
        let state = createInitialState(
          seed,
          preset.params,
          undefined,
          speech.speechEffects,
          speech.socialExpression,
          speech.speechTrust,
          speech.relationshipTie,
          formation,
        );

        for (let i = 0; i < LONG_TICKS; i++) {
          state = stepSimulation(
            state,
            preset.params,
            rng,
            undefined,
            speech.speechEffects,
            speech.socialExpression,
            speech.speechTrust,
            speech.relationshipTie,
            formation,
          );
          assertStandingPartyInvariants(state, {
            maxEmptyFormingAge: formationPolicy.defaultMaxAge,
            label: `analysis-longrun preset=${presetId} seed=${seed} tick=${state.tick}`,
          });

          // 毎tick全再構築は重いので、50tickごとに分析不変条件を検証
          if (state.tick % 50 === 0 || i === LONG_TICKS - 1) {
            const history = buildStandingPartyConversationHistory(state);
            const network = buildStandingPartyContactNetwork(state, { history });
            const statistics = buildStandingPartyRunStatistics(state, { history, network });
            assertStandingPartyAnalysisInvariants(history, network, statistics, {
              label: `analysis-longrun preset=${presetId} seed=${seed} tick=${state.tick}`,
              state,
            });
          }
        }

        // 最終tickのexportも含めて再現可能な成果物であること
        const finalHistory = buildStandingPartyConversationHistory(state);
        const finalNetwork = buildStandingPartyContactNetwork(state, { history: finalHistory });
        const finalStats = buildStandingPartyRunStatistics(state, {
          history: finalHistory,
          network: finalNetwork,
        });
        const exportA = serializeStandingPartyAnalysisExport(
          buildStandingPartyAnalysisExport(state, {
            history: finalHistory,
            network: finalNetwork,
            statistics: finalStats,
          }),
        );
        const exportB = serializeStandingPartyAnalysisExport(
          buildStandingPartyAnalysisExport(state, {
            history: buildStandingPartyConversationHistory(state),
            network: buildStandingPartyContactNetwork(state),
            statistics: buildStandingPartyRunStatistics(state),
          }),
        );
        expect(exportA).toBe(exportB);
      }
    },
    120_000,
  );
});

describe("Issue #218: 分析導出の非介入(analysis ON/OFFでsim・PRNGが変わらない)", () => {
  it("毎tick analysis導出あり/なしで状態系列・event列・PRNG消費が完全一致する", () => {
    const presetId = "standing-party-outward-interest";
    const preset = getPresetById(presetId);
    const formation = formationOptionsFor(presetId);
    const speech = speechConfigsOn();
    const seed = 11;
    const ticks = 200;

    function run(withAnalysis: boolean): { states: SimulationState[]; rngProbe: number } {
      const rng = new SeededRandom(seed);
      let state = createInitialState(
        seed,
        preset.params,
        undefined,
        speech.speechEffects,
        speech.socialExpression,
        speech.speechTrust,
        speech.relationshipTie,
        formation,
      );
      const states: SimulationState[] = [structuredClone(state)];
      for (let i = 0; i < ticks; i++) {
        state = stepSimulation(
          state,
          preset.params,
          rng,
          undefined,
          speech.speechEffects,
          speech.socialExpression,
          speech.speechTrust,
          speech.relationshipTie,
          formation,
        );
        if (withAnalysis) {
          assertHistoryDoesNotMutateState(state);
          const history = buildStandingPartyConversationHistory(state);
          const network = buildStandingPartyContactNetwork(state, { history });
          buildStandingPartyRunStatistics(state, { history, network });
          buildStandingPartyAnalysisExport(state, { history, network });
        }
        states.push(structuredClone(state));
      }
      return { states, rngProbe: rng.next() };
    }

    const baseline = run(false);
    const analyzed = run(true);
    expect(analyzed.states).toEqual(baseline.states);
    expect(analyzed.rngProbe).toBe(baseline.rngProbe);
  }, 60_000);
});

describe("Issue #218: pause/resume後の分析結果再現", () => {
  it("連続実行とpause/resume再開で最終analysis/exportが一致する", () => {
    const presetId = "standing-party-outward-interest";
    const preset = getPresetById(presetId);
    const formation = formationOptionsFor(presetId);
    const speech = speechConfigsOn();
    const seed = 7;
    const HALF = 150;
    const FULL = 300;

    const continuousRng = new SeededRandom(seed);
    let continuous = createInitialState(
      seed,
      preset.params,
      undefined,
      speech.speechEffects,
      speech.socialExpression,
      speech.speechTrust,
      speech.relationshipTie,
      formation,
    );
    for (let i = 0; i < FULL; i++) {
      continuous = stepSimulation(
        continuous,
        preset.params,
        continuousRng,
        undefined,
        speech.speechEffects,
        speech.socialExpression,
        speech.speechTrust,
        speech.relationshipTie,
        formation,
      );
    }

    const pausedRng = new SeededRandom(seed);
    let paused = createInitialState(
      seed,
      preset.params,
      undefined,
      speech.speechEffects,
      speech.socialExpression,
      speech.speechTrust,
      speech.relationshipTie,
      formation,
    );
    for (let i = 0; i < HALF; i++) {
      paused = stepSimulation(
        paused,
        preset.params,
        pausedRng,
        undefined,
        speech.speechEffects,
        speech.socialExpression,
        speech.speechTrust,
        speech.relationshipTie,
        formation,
      );
    }
    // pause: 同じrng/stateから再開
    for (let i = 0; i < FULL - HALF; i++) {
      paused = stepSimulation(
        paused,
        preset.params,
        pausedRng,
        undefined,
        speech.speechEffects,
        speech.socialExpression,
        speech.speechTrust,
        speech.relationshipTie,
        formation,
      );
    }

    expect(paused).toEqual(continuous);
    const exportContinuous = serializeStandingPartyAnalysisExport(
      buildStandingPartyAnalysisExport(continuous),
    );
    const exportPaused = serializeStandingPartyAnalysisExport(buildStandingPartyAnalysisExport(paused));
    expect(exportPaused).toBe(exportContinuous);
  }, 60_000);
});

describe("Issue #218: 性能スモーク(著しい退化の検出)", () => {
  it("1000tick相当の履歴からanalysis+exportが一回で妥当な時間内に完了する", () => {
    const preset = getPresetById("standing-party-outward-interest");
    const formation = formationOptionsFor("standing-party-outward-interest");
    const speech = speechConfigsOn();
    const seed = 3;
    const rng = new SeededRandom(seed);
    let state = createInitialState(
      seed,
      preset.params,
      undefined,
      speech.speechEffects,
      speech.socialExpression,
      speech.speechTrust,
      speech.relationshipTie,
      formation,
    );
    for (let i = 0; i < 1000; i++) {
      state = stepSimulation(
        state,
        preset.params,
        rng,
        undefined,
        speech.speechEffects,
        speech.socialExpression,
        speech.speechTrust,
        speech.relationshipTie,
        formation,
      );
    }

    const started = performance.now();
    const history = buildStandingPartyConversationHistory(state);
    const network = buildStandingPartyContactNetwork(state, { history });
    const statistics = buildStandingPartyRunStatistics(state, { history, network });
    const bundle = buildStandingPartyAnalysisExport(state, { history, network, statistics });
    serializeStandingPartyAnalysisExport(bundle);
    buildStandingPartyAnalysisCsvFiles(bundle);
    const elapsedMs = performance.now() - started;

    // 絶対時間を脆く固定せず、通常desktop/CIで明らかに異常なO退化だけ落とす。
    // 手順の正本は docs/standing-party-phase4-verification.md のbenchmark節。
    expect(elapsedMs, `analysis+exportが遅すぎる: ${elapsedMs.toFixed(1)}ms`).toBeLessThan(5_000);
    assertStandingPartyAnalysisInvariants(history, network, statistics, {
      label: "perf-smoke",
      state,
    });
  }, 60_000);
});
