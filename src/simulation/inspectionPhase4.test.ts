import { describe, expect, it } from "vitest";
import { buildObserverJoinerInspection } from "./inspection";
import { DEFAULT_PARAMS } from "./presets";
import { speechTrustPairKey } from "./speechTrust";
import type { SpeechTrustUpdateEvent } from "./speechTrust";
import { correctionFromHistory, tiePairKey, TIE_CONSISTENT_WEIGHT, TIE_INCONSISTENT_WEIGHT } from "./relationshipTie";
import type { RelationshipTieUpdateEvent, TieConsistencyObservation } from "./relationshipTie";
import type { Agent, SimulationState } from "./types";

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

function makeState(overrides: Partial<SimulationState>): SimulationState {
  return {
    tick: 12,
    agents: [],
    groupCandidates: [],
    log: [],
    width: 800,
    height: 520,
    finished: false,
    ...overrides,
  };
}

const trustUpdate = (over: Partial<SpeechTrustUpdateEvent>): SpeechTrustUpdateEvent => ({
  id: "trust-1",
  tick: 10,
  observerId: "obs",
  speakerId: "spk",
  speechEventId: "speech-1",
  intent: "invite",
  observedFromState: "undecided",
  observedToState: "leaving",
  observation: "inconsistent",
  distance: 30,
  previousTrust: 0.5,
  newTrust: 0.3,
  delta: -0.2,
  ...over,
});

const tieUpdate = (over: Partial<RelationshipTieUpdateEvent>): RelationshipTieUpdateEvent => ({
  id: "tie-1",
  tick: 10,
  observerId: "obs",
  speakerId: "spk",
  speechEventId: "speech-1",
  intent: "invite",
  observedFromState: "undecided",
  observedToState: "leaving",
  observation: "inconsistent",
  distance: 30,
  previousCorrection: 0,
  newCorrection: TIE_INCONSISTENT_WEIGHT,
  delta: TIE_INCONSISTENT_WEIGHT,
  historySize: 1,
  ...over,
});

const tieObservation = (over: Partial<TieConsistencyObservation>): TieConsistencyObservation => ({
  speechEventId: "speech-1",
  speechTick: 5,
  observedTick: 8,
  intent: "invite",
  observation: "consistent",
  observedFromState: "undecided",
  observedToState: "joined",
  weight: TIE_CONSISTENT_WEIGHT,
  ...over,
});

describe("buildObserverJoinerInspection: 本心/建前/乖離スナップショット(Issue #119)", () => {
  it("socialExpression無効時はsnapshotがundefined", () => {
    const observer = makeAgent({ id: "obs", isObserverJoiner: true, willingness: 0.8, influenceAvoidance: 0.9 });
    const state = makeState({ agents: [observer], socialExpressionEnabled: false });
    const [inspection] = buildObserverJoinerInspection(state, DEFAULT_PARAMS);
    expect(inspection.socialExpression).toBeUndefined();
  });

  it("socialExpression有効時、本心positive・建前noneの乖離が要因内訳付きで得られる", () => {
    // willingness 0.8(本心positive) + influenceAvoidance 1(遠慮)で対外表現がnoneへ抑制される
    const observer = makeAgent({
      id: "obs",
      isObserverJoiner: true,
      willingness: 0.8,
      influenceAvoidance: 1,
      conformity: 0,
    });
    const state = makeState({ agents: [observer], socialExpressionEnabled: true });
    const [inspection] = buildObserverJoinerInspection(state, DEFAULT_PARAMS);

    const snapshot = inspection.socialExpression;
    expect(snapshot).toBeDefined();
    expect(snapshot!.privateStance).toBe("positive");
    expect(snapshot!.expressedStance).toBe("none");
    expect(snapshot!.divergent).toBe(true);
    expect(snapshot!.privateJoinDesire).toBe(0.8);
    expect(snapshot!.expressedJoinDesire).toBeLessThan(0.8);
    // joinDesire次元にreserve要因の負の寄与が含まれる
    const joinDivergence = snapshot!.divergences.find((d) => d.dimension === "joinDesire");
    const reserve = joinDivergence?.factors.find((f) => f.key === "reserve");
    expect(reserve && reserve.contribution).toBeLessThan(0);
  });
});

describe("buildObserverJoinerInspection: 話者ごとのtrust(Issue #119)", () => {
  it("state.speechTrustとspeechTrustUpdateLogから、この受け手→話者のtrust現在値と履歴を組み立てる", () => {
    const observer = makeAgent({ id: "obs", isObserverJoiner: true });
    const state = makeState({
      agents: [observer, makeAgent({ id: "spk", label: "S" })],
      speechTrust: {
        [speechTrustPairKey("obs", "spk")]: 0.3,
        [speechTrustPairKey("other", "spk")]: 0.9, // 別の受け手のpairは含めない
      },
      speechTrustUpdateLog: [
        trustUpdate({ id: "t1", tick: 10, observerId: "obs", speakerId: "spk" }),
        trustUpdate({ id: "t2", tick: 4, observerId: "other", speakerId: "spk" }), // 別受け手→除外
      ],
    });

    const [inspection] = buildObserverJoinerInspection(state, DEFAULT_PARAMS);
    expect(inspection.trustSummaries).toHaveLength(1);
    const summary = inspection.trustSummaries[0];
    expect(summary.speakerId).toBe("spk");
    expect(summary.trust).toBe(0.3);
    expect(summary.isDynamic).toBe(true);
    expect(summary.updates.map((u) => u.id)).toEqual(["t1"]);
  });

  it("trust更新も現在値も無ければtrustSummariesは空", () => {
    const observer = makeAgent({ id: "obs", isObserverJoiner: true });
    const state = makeState({ agents: [observer] });
    const [inspection] = buildObserverJoinerInspection(state, DEFAULT_PARAMS);
    expect(inspection.trustSummaries).toEqual([]);
  });
});

describe("buildObserverJoinerInspection: 話者ごとの関係性補正(Issue #119)", () => {
  it("tieHistoryから補正値と寄与観測を、relationshipTieUpdateLogから履歴を組み立てる", () => {
    const observer = makeAgent({ id: "obs", isObserverJoiner: true });
    const observations = [
      tieObservation({ speechEventId: "s1", observation: "consistent", weight: TIE_CONSISTENT_WEIGHT }),
      tieObservation({ speechEventId: "s2", observation: "inconsistent", weight: TIE_INCONSISTENT_WEIGHT }),
    ];
    const state = makeState({
      agents: [observer, makeAgent({ id: "spk", label: "S" })],
      tieHistory: {
        [tiePairKey("obs", "spk")]: observations,
        [tiePairKey("other", "spk")]: [tieObservation({})], // 別受け手→除外
      },
      relationshipTieUpdateLog: [
        tieUpdate({ id: "tie-a", observerId: "obs", speakerId: "spk" }),
        tieUpdate({ id: "tie-b", observerId: "other", speakerId: "spk" }), // 別受け手→除外
      ],
    });

    const [inspection] = buildObserverJoinerInspection(state, DEFAULT_PARAMS);
    expect(inspection.tieSummaries).toHaveLength(1);
    const summary = inspection.tieSummaries[0];
    expect(summary.speakerId).toBe("spk");
    expect(summary.correction).toBeCloseTo(correctionFromHistory(observations), 10);
    expect(summary.observations).toHaveLength(2);
    expect(summary.updates.map((u) => u.id)).toEqual(["tie-a"]);
  });

  it("整合性履歴も更新も無ければtieSummariesは空", () => {
    const observer = makeAgent({ id: "obs", isObserverJoiner: true });
    const state = makeState({ agents: [observer] });
    const [inspection] = buildObserverJoinerInspection(state, DEFAULT_PARAMS);
    expect(inspection.tieSummaries).toEqual([]);
  });
});

describe("buildObserverJoinerInspection: 非破壊・決定性(Issue #119)", () => {
  it("Phase 4データを導出してもSimulationStateをmutationしない", () => {
    const observer = makeAgent({ id: "obs", isObserverJoiner: true, willingness: 0.8, influenceAvoidance: 0.9 });
    const state = makeState({
      agents: [observer],
      socialExpressionEnabled: true,
      speechTrust: { [speechTrustPairKey("obs", "spk")]: 0.3 },
      speechTrustUpdateLog: [trustUpdate({ observerId: "obs", speakerId: "spk" })],
      tieHistory: { [tiePairKey("obs", "spk")]: [tieObservation({})] },
      relationshipTieUpdateLog: [tieUpdate({ observerId: "obs", speakerId: "spk" })],
    });
    const snapshot = JSON.stringify(state);
    buildObserverJoinerInspection(state, DEFAULT_PARAMS);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it("同一stateに対して常に同一のPhase 4導出結果を返す", () => {
    const observer = makeAgent({ id: "obs", isObserverJoiner: true, willingness: 0.8, influenceAvoidance: 0.9 });
    const state = makeState({
      agents: [observer],
      socialExpressionEnabled: true,
      speechTrust: { [speechTrustPairKey("obs", "spk")]: 0.3 },
      tieHistory: { [tiePairKey("obs", "spk")]: [tieObservation({})] },
    });
    const first = buildObserverJoinerInspection(state, DEFAULT_PARAMS);
    const second = buildObserverJoinerInspection(state, DEFAULT_PARAMS);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
