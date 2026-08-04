/**
 * Issue #217: analysisExport の schema / CSV / escaping / determinism / 非mutation テスト。
 */
import { describe, expect, it } from "vitest";
import {
  assertExportDoesNotMutateState,
  buildStandingPartyAnalysisCsvFiles,
  buildStandingPartyAnalysisExport,
  escapeCsvCell,
  rowsToCsv,
  serializeStandingPartyAnalysisExport,
  STANDING_PARTY_ANALYSIS_EXPORT_SCHEMA_VERSION,
} from "./analysisExport";
import { buildStandingPartyConversationHistory } from "./standingPartyAnalysis";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG } from "./standingPartyScenarioConfig";
import type { Agent, GroupCandidate, LogEntry, SimulationState } from "./types";
import { STANDING_PARTY_ANALYSIS_SCHEMA_VERSION } from "./types";

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
      makeAgent({ id: "a", label: "A", state: "joined", joinedGroupId: "g1" }),
      makeAgent({ id: "b", label: "B", state: "joined", joinedGroupId: "g1" }),
      makeAgent({ id: "oj", label: "OJ", isObserverJoiner: true }),
    ],
    groupCandidates: [makeCandidate({ id: "g1", memberIds: ["a", "b"] })],
    log: [
      entry(1, "nucleusCreated", { agentId: "a", groupId: "g1" }),
      entry(2, "agentJoined", {
        agentId: "a",
        groupId: "g1",
        episodeId: "a:g1:2",
      }),
      entry(2, "agentJoined", {
        agentId: "b",
        groupId: "g1",
        episodeId: "b:g1:2",
      }),
      entry(20, "clusterDepartureCompleted", {
        agentId: "a",
        groupId: "g1",
        episodeId: "a:g1:2",
        ticksInCluster: 18,
        episodeEndReason: "voluntaryDeparture",
        transitionAction: "departAndExplore",
      }),
    ],
    width: 800,
    height: 520,
    finished: false,
    formationScenarioId: "standingParty",
    ...overrides,
  };
}

describe("analysisExport (Issue #217)", () => {
  it("CSV formula injection対策で危険な先頭文字をquoteする", () => {
    expect(escapeCsvCell("=CMD()")).toBe("'=CMD()");
    expect(escapeCsvCell("+1+1")).toBe("'+1+1");
    expect(escapeCsvCell("-2")).toBe("'-2");
    expect(escapeCsvCell("@sum")).toBe("'@sum");
    expect(escapeCsvCell("safe")).toBe("safe");
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it("rowsToCsvは決定的なLF終端CSVを返す", () => {
    const csv = rowsToCsv(["id", "name"], [["1", "a"], ["2", "b"]]);
    expect(csv).toBe("id,name\n1,a\n2,b\n");
  });

  it("export bundleはversion付きでhistory/network/statisticsを含む", () => {
    const state = makeState();
    const bundle = buildStandingPartyAnalysisExport(state, {
      presetId: "standing-party-natural",
      standingPartyConfig: DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
      simParams: {
        populationSize: 3,
        groupConfirmSize: 3,
        numLeaders: 1,
        overallWillingness: 0.5,
        ambiguityDuration: 1,
        lateJoinEase: 0.5,
        existingTieStrength: 0.5,
        observerAmbiguityTolerance: 0.5,
        observerInfluenceAvoidance: 0.5,
        observerLeaveEase: 0.5,
      },
    });
    expect(bundle.schemaVersion).toBe(STANDING_PARTY_ANALYSIS_EXPORT_SCHEMA_VERSION);
    expect(bundle.analysisSchemaVersion).toBe(STANDING_PARTY_ANALYSIS_SCHEMA_VERSION);
    expect(bundle.generatedAtTick).toBe(40);
    expect(bundle.run.seed).toBe(7);
    expect(bundle.run.presetId).toBe("standing-party-natural");
    expect(bundle.run.config).toEqual(DEFAULT_STANDING_PARTY_SCENARIO_CONFIG);
    expect(bundle.history.schemaVersion).toBe(STANDING_PARTY_ANALYSIS_SCHEMA_VERSION);
    expect(bundle.contactNetwork.schemaVersion).toBe(STANDING_PARTY_ANALYSIS_SCHEMA_VERSION);
    expect(bundle.statistics.schemaVersion).toBe(STANDING_PARTY_ANALYSIS_SCHEMA_VERSION);
    expect(bundle.history.episodes.length).toBeGreaterThan(0);
  });

  it("同一stateからJSONが決定的", () => {
    const state = makeState();
    const a = serializeStandingPartyAnalysisExport(buildStandingPartyAnalysisExport(state));
    const b = serializeStandingPartyAnalysisExport(buildStandingPartyAnalysisExport(state));
    expect(a).toBe(b);
  });

  it("CSV一式は必須ファイルと列を含む", () => {
    const bundle = buildStandingPartyAnalysisExport(makeState());
    const files = buildStandingPartyAnalysisCsvFiles(bundle);
    const names = files.map((f) => f.filename);
    expect(names).toEqual([
      "standing-party-episodes.csv",
      "standing-party-contact-intervals.csv",
      "standing-party-contact-edges.csv",
      "standing-party-agent-statistics.csv",
      "standing-party-cluster-statistics.csv",
      "standing-party-transitions.csv",
    ]);
    expect(files[0]!.content).toContain("episodeId,agentId,clusterId");
    expect(files[0]!.content).toContain("activeOrCensored");
    expect(files[1]!.content).toContain("contactIntervalId");
    expect(files[3]!.content).toContain("isObserverJoiner");
    expect(files[4]!.content).toContain("lifetimeTicks");
  });

  it("exportはSimulationStateをmutationしない", () => {
    const state = makeState();
    assertExportDoesNotMutateState(state, () => {
      const bundle = buildStandingPartyAnalysisExport(state);
      serializeStandingPartyAnalysisExport(bundle);
      buildStandingPartyAnalysisCsvFiles(bundle);
      buildStandingPartyConversationHistory(state);
    });
  });

  it("UI selectionをbundleへ含めない", () => {
    const json = serializeStandingPartyAnalysisExport(buildStandingPartyAnalysisExport(makeState()));
    expect(json).not.toContain("selectedAgentId");
    expect(json).not.toContain("layout");
    expect(json).not.toContain("zoom");
  });
});
