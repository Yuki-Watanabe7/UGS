import { describe, expect, it } from "vitest";
import {
  classifyTrustObservation,
  createSpeechTrustResolver,
  deriveSpeechTrustUpdates,
  deriveSpeechTruthfulness,
  registerSpeechTrustCommitments,
  resolveSpeechTrustConfig,
  SPEECH_TRUST_OBSERVATION_RANGE,
  speechTrustPairKey,
  TRUST_CONSISTENT_DELTA,
  TRUST_INCONSISTENT_DELTA,
  truthfulnessOf,
} from "./speechTrust";
import type { SpeechTrustCommitment, SpeechTrustState } from "./speechTrust";
import { deriveSpeechInterpretations, deriveSpeechReceptions, relationshipTrust } from "./speechEffects";
import { createSpeechEvent } from "./speech";
import type { SpeechExpressionLink } from "./speech";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS, PRESETS } from "./presets";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./model";
import type { Agent, SimulationState } from "./types";

const TRUST_ON = resolveSpeechTrustConfig({ enabled: true });
const TRUST_OFF = resolveSpeechTrustConfig();
const EFFECTS_ON = { enabled: true };

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
    tick: 10,
    agents: [],
    groupCandidates: [],
    log: [],
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    finished: false,
    ...overrides,
  };
}

function makeLink(overrides: Partial<SpeechExpressionLink>): SpeechExpressionLink {
  return {
    publicExpressionId: "public-5-s1",
    privateEvaluationId: "private-5-s1",
    divergent: true,
    privateStance: "positive",
    expressedStance: "none",
    baseIntent: "decline",
    ...overrides,
  };
}

describe("truthfulnessOf: 発話時点の乖離スナップショットからの一致度導出", () => {
  it("乖離なし(divergent: false)は常に1(完全一致)", () => {
    const link = makeLink({ divergent: false, privateStance: "positive", expressedStance: "positive" });
    expect(truthfulnessOf("invite", link)).toBe(1);
  });

  it("社交辞令の辞退(本心positive・表現none・declineのまま)は0.5", () => {
    const link = makeLink({ privateStance: "positive", expressedStance: "none", baseIntent: "decline" });
    expect(truthfulnessOf("decline", link)).toBe(0.5);
  });

  it("遠慮による軟化(本心positive・表現none・invite→greet)はintent置換ぶんも減って0.25", () => {
    const link = makeLink({ privateStance: "positive", expressedStance: "none", baseIntent: "invite" });
    expect(truthfulnessOf("greet", link)).toBe(0.25);
  });

  it("スタンスが正反対(positive対negative)なら0", () => {
    const link = makeLink({ privateStance: "positive", expressedStance: "negative", baseIntent: "welcome" });
    expect(truthfulnessOf("welcome", link)).toBe(0);
  });

  it("スタンス・intentが一致していても乖離あり(leaveInclination次元のみ等)なら上限0.75で頭打ち", () => {
    const link = makeLink({ privateStance: "positive", expressedStance: "positive", baseIntent: "decline" });
    expect(truthfulnessOf("decline", link)).toBe(0.75);
  });
});

describe("deriveSpeechTruthfulness: 話者側の真実性記録", () => {
  const speechWithLink = () => {
    const base = createSpeechEvent({
      tick: 5,
      speakerId: "s1",
      intent: "decline",
      reason: "leaveDeclaration",
      audience: "nearby",
      originX: 100,
      originY: 100,
    });
    return { ...base, expression: makeLink({}) };
  };

  it("config無効時(デフォルト)は常に空配列を返す", () => {
    expect(deriveSpeechTruthfulness([speechWithLink()], TRUST_OFF)).toEqual([]);
  });

  it("乖離スナップショットを持たない発言(socialExpression無効・介入発言)は評価対象にしない", () => {
    const noLink = createSpeechEvent({
      tick: 5,
      speakerId: "s2",
      intent: "invite",
      reason: "lightObserverInvitation",
      target: "obs",
    });
    const records = deriveSpeechTruthfulness([noLink, speechWithLink()], TRUST_ON);
    expect(records).toHaveLength(1);
    expect(records[0].speakerId).toBe("s1");
  });

  it("発話時点の値の複製と一致度が構造化して記録される", () => {
    const speech = speechWithLink();
    const [record] = deriveSpeechTruthfulness([speech], TRUST_ON);
    expect(record).toEqual({
      id: `truthfulness-${speech.id}`,
      speechEventId: speech.id,
      tick: 5,
      speakerId: "s1",
      intent: "decline",
      baseIntent: "decline",
      privateStance: "positive",
      expressedStance: "none",
      divergent: true,
      truthfulness: 0.5,
    });
  });
});

describe("classifyTrustObservation: intentと行動の一致/不一致の固定判定表", () => {
  it("参加方向の発言(invite/welcome/greet)はjoined遷移=一致、leaving遷移=不一致", () => {
    for (const intent of ["invite", "welcome", "greet"] as const) {
      expect(classifyTrustObservation(intent, "joined")).toBe("consistent");
      expect(classifyTrustObservation(intent, "leaving")).toBe("inconsistent");
      expect(classifyTrustObservation(intent, "undecided")).toBeUndefined();
      expect(classifyTrustObservation(intent, "approaching")).toBeUndefined();
    }
  });

  it("decline(離脱表明)はleft遷移=一致、approaching/joined遷移=不一致", () => {
    expect(classifyTrustObservation("decline", "left")).toBe("consistent");
    expect(classifyTrustObservation("decline", "approaching")).toBe("inconsistent");
    expect(classifyTrustObservation("decline", "joined")).toBe("inconsistent");
    expect(classifyTrustObservation("decline", "leaving")).toBeUndefined();
  });
});

describe("registerSpeechTrustCommitments: 観測コミットメントの登録", () => {
  const speech = createSpeechEvent({
    tick: 7,
    speakerId: "s1",
    intent: "decline",
    reason: "leaveDeclaration",
    audience: "nearby",
    originX: 100,
    originY: 100,
  });

  it("発話時点でheard: trueだった受け手のみがhearerとして登録される", () => {
    const candidates = [
      makeAgent({ id: "near", x: 150, y: 100 }),
      makeAgent({ id: "far", x: 700, y: 100 }),
    ];
    const receptions = deriveSpeechReceptions([speech], candidates, EFFECTS_ON);
    const commitments = registerSpeechTrustCommitments([], [speech], receptions, TRUST_ON);
    expect(commitments).toEqual([
      { speechEventId: speech.id, tick: 7, speakerId: "s1", intent: "decline", hearerIds: ["near"] },
    ]);
  });

  it("認知した受け手が1人もいない発言はコミットメントを作らない", () => {
    const candidates = [makeAgent({ id: "far", x: 700, y: 500 })];
    const receptions = deriveSpeechReceptions([speech], candidates, EFFECTS_ON);
    expect(receptions.every((r) => !r.heard)).toBe(true);
    expect(registerSpeechTrustCommitments([], [speech], receptions, TRUST_ON)).toEqual([]);
  });

  it("config無効時は既存の配列内容をそのまま返す", () => {
    const existing: SpeechTrustCommitment[] = [
      { speechEventId: "x", tick: 1, speakerId: "s9", intent: "greet", hearerIds: ["a"] },
    ];
    expect(registerSpeechTrustCommitments(existing, [speech], [], TRUST_OFF)).toEqual(existing);
  });
});

describe("deriveSpeechTrustUpdates: 観測条件と決定的なtrust更新", () => {
  const TIE = 0.3;
  const staticTrust = relationshipTrust(false, TIE); // 非同一cliqueの初期値

  const declineCommitment = (hearerIds: string[]): SpeechTrustCommitment => ({
    speechEventId: "speech-7-s1-leaveDeclaration",
    tick: 7,
    speakerId: "s1",
    intent: "decline",
    hearerIds,
  });

  it("decline後にleftへ遷移(一致)を範囲内のhearerが観測するとtrustが上がる", () => {
    const prev = [makeAgent({ id: "s1", state: "leaving", x: 400, y: 500 }), makeAgent({ id: "o1", x: 400, y: 440 })];
    const next = [makeAgent({ id: "s1", state: "left", x: 400, y: 515 }), makeAgent({ id: "o1", x: 400, y: 440 })];
    const result = deriveSpeechTrustUpdates([declineCommitment(["o1"])], prev, next, {}, TIE, 9, TRUST_ON);

    expect(result.commitments).toEqual([]); // 観測完了で解決
    expect(result.updates).toHaveLength(1);
    const [update] = result.updates;
    expect(update).toEqual({
      id: "trust-9-o1-speech-7-s1-leaveDeclaration",
      tick: 9,
      observerId: "o1",
      speakerId: "s1",
      speechEventId: "speech-7-s1-leaveDeclaration",
      intent: "decline",
      observedFromState: "leaving",
      observedToState: "left",
      observation: "consistent",
      distance: 75,
      previousTrust: staticTrust,
      newTrust: staticTrust + TRUST_CONSISTENT_DELTA,
      // deltaはclamp適用後の実際の変化量(newTrust - previousTrust)のため浮動小数点の丸めを許容する
      delta: expect.closeTo(TRUST_CONSISTENT_DELTA, 10),
    });
    expect(result.trust[speechTrustPairKey("o1", "s1")]).toBeCloseTo(staticTrust + TRUST_CONSISTENT_DELTA, 10);
  });

  it("invite後にleavingへ遷移(不一致)を観測するとtrustが大きく下がり、0未満へはclampされる", () => {
    const commitment: SpeechTrustCommitment = {
      speechEventId: "speech-3-s1-initiativeFormedCore",
      tick: 3,
      speakerId: "s1",
      intent: "invite",
      hearerIds: ["o1"],
    };
    const prev = [makeAgent({ id: "s1", state: "undecided" }), makeAgent({ id: "o1", x: 420, y: 260 })];
    const next = [makeAgent({ id: "s1", state: "leaving" }), makeAgent({ id: "o1", x: 420, y: 260 })];

    const first = deriveSpeechTrustUpdates([commitment], prev, next, {}, TIE, 4, TRUST_ON);
    expect(first.updates[0].observation).toBe("inconsistent");
    expect(first.updates[0].newTrust).toBeCloseTo(staticTrust + TRUST_INCONSISTENT_DELTA, 10);

    // 既に低いtrustからの不一致観測では0でclampされ、deltaは実際の変化量になる
    const low: SpeechTrustState = { [speechTrustPairKey("o1", "s1")]: 0.1 };
    const second = deriveSpeechTrustUpdates([commitment], prev, next, low, TIE, 4, TRUST_ON);
    expect(second.updates[0].newTrust).toBe(0);
    expect(second.updates[0].delta).toBeCloseTo(-0.1, 10);
  });

  it("観測tickに知覚範囲外にいたhearerは更新されない(コミットメント自体は解決される)", () => {
    const prev = [makeAgent({ id: "s1", state: "leaving", x: 100, y: 500 }), makeAgent({ id: "o1", x: 100, y: 100 })];
    const next = [
      makeAgent({ id: "s1", state: "left", x: 100, y: 515 }),
      makeAgent({ id: "o1", x: 100, y: 515 - SPEECH_TRUST_OBSERVATION_RANGE - 1 }),
    ];
    const result = deriveSpeechTrustUpdates([declineCommitment(["o1"])], prev, next, {}, TIE, 9, TRUST_ON);
    expect(result.updates).toEqual([]);
    expect(result.trust).toEqual({});
    expect(result.commitments).toEqual([]);
  });

  it("hearerでないagent・leftのhearerは更新対象にならない", () => {
    const prev = [
      makeAgent({ id: "s1", state: "leaving", x: 400, y: 500 }),
      makeAgent({ id: "gone", state: "left", x: 400, y: 510 }),
      makeAgent({ id: "bystander", x: 400, y: 480 }),
    ];
    const next = [
      makeAgent({ id: "s1", state: "left", x: 400, y: 515 }),
      makeAgent({ id: "gone", state: "left", x: 400, y: 515 }),
      makeAgent({ id: "bystander", x: 400, y: 480 }),
    ];
    // bystanderはhearerに含まれない(発話時点で聞いていない)、goneはhearerだが既にleft
    const result = deriveSpeechTrustUpdates([declineCommitment(["gone"])], prev, next, {}, TIE, 9, TRUST_ON);
    expect(result.updates).toEqual([]);
    expect(result.trust).toEqual({});
  });

  it("話者の状態が変わらない・決定的でない遷移では保留のまま残る", () => {
    const commitment = declineCommitment(["o1"]);
    const observer = makeAgent({ id: "o1", x: 400, y: 440 });

    const stay = deriveSpeechTrustUpdates(
      [commitment],
      [makeAgent({ id: "s1", state: "leaving" }), observer],
      [makeAgent({ id: "s1", state: "leaving" }), observer],
      {},
      TIE,
      9,
      TRUST_ON,
    );
    expect(stay.commitments).toEqual([commitment]);
    expect(stay.updates).toEqual([]);

    const indecisive = deriveSpeechTrustUpdates(
      [{ ...commitment, intent: "invite" }],
      [makeAgent({ id: "s1", state: "forming" }), observer],
      [makeAgent({ id: "s1", state: "undecided" }), observer],
      {},
      TIE,
      9,
      TRUST_ON,
    );
    expect(indecisive.commitments).toHaveLength(1);
    expect(indecisive.updates).toEqual([]);
  });

  it("同一observerへの複数コミットメントは登録順に逐次適用される(2件目のpreviousTrustは1件目のnewTrust)", () => {
    const commitments: SpeechTrustCommitment[] = [
      { speechEventId: "speech-a", tick: 3, speakerId: "s1", intent: "invite", hearerIds: ["o1"] },
      { speechEventId: "speech-b", tick: 5, speakerId: "s1", intent: "greet", hearerIds: ["o1"] },
    ];
    const prev = [makeAgent({ id: "s1", state: "undecided" }), makeAgent({ id: "o1", x: 420, y: 260 })];
    const next = [makeAgent({ id: "s1", state: "leaving" }), makeAgent({ id: "o1", x: 420, y: 260 })];
    const result = deriveSpeechTrustUpdates(commitments, prev, next, {}, TIE, 6, TRUST_ON);

    expect(result.updates).toHaveLength(2);
    expect(result.updates[0].previousTrust).toBe(staticTrust);
    expect(result.updates[1].previousTrust).toBe(result.updates[0].newTrust);
    expect(result.trust[speechTrustPairKey("o1", "s1")]).toBe(result.updates[1].newTrust);
  });

  it("同一cliqueのpairの初期値はsameClique側の静的relationshipTrustになる", () => {
    const prev = [
      makeAgent({ id: "s1", state: "leaving", x: 400, y: 500, cliqueId: 1 }),
      makeAgent({ id: "o1", x: 400, y: 440, cliqueId: 1 }),
    ];
    const next = [
      makeAgent({ id: "s1", state: "left", x: 400, y: 515, cliqueId: 1 }),
      makeAgent({ id: "o1", x: 400, y: 440, cliqueId: 1 }),
    ];
    const result = deriveSpeechTrustUpdates([declineCommitment(["o1"])], prev, next, {}, TIE, 9, TRUST_ON);
    expect(result.updates[0].previousTrust).toBe(relationshipTrust(true, TIE));
  });

  it("決定的: 同一入力に対して常に同一の結果を返す(rng不使用)", () => {
    const prev = [makeAgent({ id: "s1", state: "leaving", x: 400, y: 500 }), makeAgent({ id: "o1", x: 400, y: 440 })];
    const next = [makeAgent({ id: "s1", state: "left", x: 400, y: 515 }), makeAgent({ id: "o1", x: 400, y: 440 })];
    const first = deriveSpeechTrustUpdates([declineCommitment(["o1"])], prev, next, {}, TIE, 9, TRUST_ON);
    const second = deriveSpeechTrustUpdates([declineCommitment(["o1"])], prev, next, {}, TIE, 9, TRUST_ON);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("config無効時は更新もコミットメント解決も行わず、入力と同内容を返す", () => {
    const commitment = declineCommitment(["o1"]);
    const trust: SpeechTrustState = { existing: 0.9 };
    const prev = [makeAgent({ id: "s1", state: "leaving", x: 400, y: 500 }), makeAgent({ id: "o1", x: 400, y: 440 })];
    const next = [makeAgent({ id: "s1", state: "left", x: 400, y: 515 }), makeAgent({ id: "o1", x: 400, y: 440 })];
    const result = deriveSpeechTrustUpdates([commitment], prev, next, trust, TIE, 9, TRUST_OFF);
    expect(result.updates).toEqual([]);
    expect(result.trust).toEqual(trust);
    expect(result.commitments).toEqual([commitment]);
  });
});

describe("deriveSpeechInterpretations: 動的trust係数の参照(Issue #116)", () => {
  const speech = createSpeechEvent({
    tick: 5,
    speakerId: "s1",
    intent: "invite",
    reason: "initiativeFormedCore",
    audience: "nearby",
    originX: 100,
    originY: 100,
  });
  const receiver = makeAgent({ id: "r1", x: 130, y: 100, conformity: 0.6, influenceAvoidance: 0.2 });
  const speaker = makeAgent({ id: "s1", x: 100, y: 100 });
  const participants = [speaker, receiver];
  const receptions = deriveSpeechReceptions([speech], participants, EFFECTS_ON);
  const TIE = 0.3;

  it("resolver未指定なら従来の静的relationshipTrust式と完全一致する", () => {
    const withoutResolver = deriveSpeechInterpretations(receptions, [speech], participants, TIE, EFFECTS_ON);
    const staticResolver = createSpeechTrustResolver({}, TIE); // 未更新の動的trust=静的初期値
    const withResolver = deriveSpeechInterpretations(receptions, [speech], participants, TIE, EFFECTS_ON, staticResolver);
    expect(withResolver).toEqual(withoutResolver);
  });

  it("動的trustが更新済みのpairでは、trust係数として動的値が使われintensityが変わる", () => {
    const base = deriveSpeechInterpretations(receptions, [speech], participants, TIE, EFFECTS_ON);
    const boosted: SpeechTrustState = { [speechTrustPairKey("r1", "s1")]: 1 };
    const [interpretation] = deriveSpeechInterpretations(
      receptions,
      [speech],
      participants,
      TIE,
      EFFECTS_ON,
      createSpeechTrustResolver(boosted, TIE),
    );
    const trustFactor = interpretation.factors.find((f) => f.key === "relationshipTrust");
    expect(trustFactor?.contribution).toBe(1);
    expect(interpretation.intensity).toBeGreaterThan(base[0].intensity);

    const zeroed: SpeechTrustState = { [speechTrustPairKey("r1", "s1")]: 0 };
    const [neutral] = deriveSpeechInterpretations(
      receptions,
      [speech],
      participants,
      TIE,
      EFFECTS_ON,
      createSpeechTrustResolver(zeroed, TIE),
    );
    expect(neutral.intensity).toBe(0);
    expect(neutral.valence).toBe("neutral");
  });

  it("resolverの戻り値は防御的に0〜1へclampされる", () => {
    const [interpretation] = deriveSpeechInterpretations(
      receptions,
      [speech],
      participants,
      TIE,
      EFFECTS_ON,
      () => 5,
    );
    const trustFactor = interpretation.factors.find((f) => f.key === "relationshipTrust");
    expect(trustFactor?.contribution).toBe(1);
  });
});

describe("engine統合: trust更新の観測とstateへの記録", () => {
  it("decline発言→退出(一致)を近くで聞いていた受け手のtrustが上がり、因果が記録される", () => {
    // speaker: stressしきい値超え → tick+1で確定的にleaving遷移しdecline発言。
    // 画面下端まで数tickかかる位置に置き、発言tickと退出(left)tickを分離する。
    const speaker = makeAgent({ id: "spk", x: 400, y: 480, stress: 0.99, leaveThreshold: 0.5 });
    // observer: 離脱・核形成・接近のいずれも起こさない(leaveThreshold 1・ambiguityTolerance 1・候補なし)
    const observer = makeAgent({ id: "obs", x: 400, y: 440, leaveThreshold: 1, ambiguityTolerance: 1 });
    let state = makeState({ agents: [speaker, observer] });
    const rng = new SeededRandom(1);
    const step = (s: SimulationState) =>
      stepSimulation(s, DEFAULT_PARAMS, rng, undefined, { enabled: true }, undefined, { enabled: true });

    state = step(state); // tick 11: leaving遷移+decline発言、コミットメント登録
    const decline = state.speechLog?.find((e) => e.intent === "decline");
    expect(decline).toBeDefined();
    expect(state.speechTrustCommitments).toEqual([
      { speechEventId: decline!.id, tick: 11, speakerId: "spk", intent: "decline", hearerIds: ["obs"] },
    ]);
    expect(state.speechTrustUpdateLog).toEqual([]);

    while (!state.agents.some((a) => a.id === "spk" && a.state === "left")) {
      state = step(state);
    }

    const staticTrust = 0.5 - 0.4 * DEFAULT_PARAMS.existingTieStrength;
    expect(state.speechTrustUpdateLog).toHaveLength(1);
    const [update] = state.speechTrustUpdateLog!;
    expect(update.observerId).toBe("obs");
    expect(update.speakerId).toBe("spk");
    expect(update.speechEventId).toBe(decline!.id);
    expect(update.observation).toBe("consistent");
    expect(update.observedFromState).toBe("leaving");
    expect(update.observedToState).toBe("left");
    expect(update.previousTrust).toBeCloseTo(staticTrust, 10);
    expect(update.delta).toBeCloseTo(TRUST_CONSISTENT_DELTA, 10);
    expect(state.speechTrust).toEqual({ "obs->spk": update.newTrust });
    expect(state.speechTrustCommitments).toEqual([]); // 観測完了で解決済み

    // personality基礎値・leaveThreshold本体は一切変更されない
    const finalObserver = state.agents.find((a) => a.id === "obs")!;
    expect(finalObserver.leaveThreshold).toBe(1);
    expect(finalObserver.willingness).toBe(0.5);
    expect(finalObserver.conformity).toBe(0.5);
    expect(finalObserver.influenceAvoidance).toBe(0.3);
  });

  it("socialExpression有効時、真実性が発話時点の乖離スナップショットから導出・記録される", () => {
    // socialExpressionSpeech.test.tsの「社交辞令の辞退」と同じ状況: 本心positiveのままのdecline
    const observerJoiner = makeAgent({
      id: "obs-1",
      isObserverJoiner: true,
      willingness: 0.8,
      influenceAvoidance: DEFAULT_PARAMS.observerInfluenceAvoidance,
      conformity: 0,
      stress: 0.99,
      leaveThreshold: 0.5,
    });
    const state = makeState({ agents: [observerJoiner] });
    const rng = new SeededRandom(1);
    const next = stepSimulation(state, DEFAULT_PARAMS, rng, undefined, undefined, { enabled: true }, { enabled: true });

    expect(next.speechTruthfulnessLog).toHaveLength(1);
    const [record] = next.speechTruthfulnessLog!;
    expect(record.speakerId).toBe("obs-1");
    expect(record.intent).toBe("decline");
    expect(record.divergent).toBe(true);
    expect(record.privateStance).toBe("positive");
    expect(record.expressedStance).toBe("none");
    expect(record.truthfulness).toBe(0.5); // 社交辞令の辞退(スタンスずれ・intent維持)
  });

  it("speechTrustEnabledはstateへ引き継がれ、以後のtickで未指定でも維持される", () => {
    const initial = createInitialState(1, DEFAULT_PARAMS, undefined, undefined, undefined, { enabled: true });
    expect(initial.speechTrustEnabled).toBe(true);
    const rng = new SeededRandom(1);
    const next = stepSimulation(initial, DEFAULT_PARAMS, rng);
    expect(next.speechTrustEnabled).toBe(true);

    const defaultInitial = createInitialState(1, DEFAULT_PARAMS);
    expect(defaultInitial.speechTrustEnabled).toBe(false);
  });
});

describe("後方互換と再現性(Issue #116の受入条件)", () => {
  type RunOptions = { speechEffects: boolean; socialExpression: boolean; speechTrust: boolean };
  type RunResult = { serialized: string[]; rngProbe: number; final: SimulationState };

  const run = (params: typeof DEFAULT_PARAMS, options: RunOptions, seed = 7, maxTicks = 400): RunResult => {
    const rng = new SeededRandom(seed);
    const effects = { enabled: options.speechEffects };
    const social = { enabled: options.socialExpression };
    const trust = { enabled: options.speechTrust };
    let state = createInitialState(seed, params, undefined, effects, social, trust);
    // 発言・trust記録や設定フラグを除いた、状態遷移の本体部分のみを系列比較の対象にする
    const core = (s: SimulationState) =>
      JSON.stringify({ tick: s.tick, agents: s.agents, groupCandidates: s.groupCandidates, log: s.log, finished: s.finished });
    const serialized: string[] = [core(state)];
    let ticks = 0;
    while (!state.finished && ticks < maxTicks) {
      state = stepSimulation(state, params, rng, undefined, effects, social, trust);
      serialized.push(core(state));
      ticks += 1;
    }
    return { serialized, rngProbe: rng.next(), final: state };
  };

  for (const preset of PRESETS) {
    it(`preset="${preset.id}": trust OFF時は状態系列・PRNG消費がON引数なしと完全一致し、trust記録は空のまま`, () => {
      const off = run(preset.params, { speechEffects: true, socialExpression: true, speechTrust: false });
      // trust ONでもspeechEffects OFFなら認知(reception)が存在せず観測が発生しない → 状態系列は不変
      const offEffects = run(preset.params, { speechEffects: false, socialExpression: false, speechTrust: false });
      const trustWithoutEffects = run(preset.params, { speechEffects: false, socialExpression: false, speechTrust: true });
      expect(trustWithoutEffects.serialized).toEqual(offEffects.serialized);
      expect(trustWithoutEffects.rngProbe).toBe(offEffects.rngProbe);
      expect(trustWithoutEffects.final.speechTrustUpdateLog).toEqual([]);
      expect(trustWithoutEffects.final.speechTrust).toEqual({});
      expect(trustWithoutEffects.final.speechTrustCommitments).toEqual([]);

      // trust OFF(既定)ではtrust関連の記録が一切生成されない
      expect(off.final.speechTrustUpdateLog).toEqual([]);
      expect(off.final.speechTruthfulnessLog).toEqual([]);
      expect(off.final.speechTrust).toEqual({});
    });
  }

  it("同一seed・同一設定(全機能ON)ならtrustの時系列・真実性記録・状態系列が完全に再現される", () => {
    const options = { speechEffects: true, socialExpression: true, speechTrust: true };
    const first = run(DEFAULT_PARAMS, options);
    const second = run(DEFAULT_PARAMS, options);
    expect(first.serialized).toEqual(second.serialized);
    expect(first.rngProbe).toBe(second.rngProbe);
    expect(JSON.stringify(first.final.speechTrustUpdateLog)).toBe(JSON.stringify(second.final.speechTrustUpdateLog));
    expect(JSON.stringify(first.final.speechTruthfulnessLog)).toBe(JSON.stringify(second.final.speechTruthfulnessLog));
    expect(JSON.stringify(first.final.speechTrust)).toBe(JSON.stringify(second.final.speechTrust));
  });

  it("全機能ONの実行で、更新記録の値が範囲内・因果が追跡可能・personality基礎値が不変", () => {
    const options = { speechEffects: true, socialExpression: true, speechTrust: true };
    for (const preset of PRESETS) {
      const { final } = run(preset.params, options);
      const speechIds = new Set((final.speechLog ?? []).map((e) => e.id));
      for (const update of final.speechTrustUpdateLog ?? []) {
        expect(update.newTrust).toBeGreaterThanOrEqual(0);
        expect(update.newTrust).toBeLessThanOrEqual(1);
        expect(update.previousTrust).toBeGreaterThanOrEqual(0);
        expect(update.previousTrust).toBeLessThanOrEqual(1);
        expect(update.delta).toBeCloseTo(update.newTrust - update.previousTrust, 10);
        expect(update.distance).toBeLessThanOrEqual(SPEECH_TRUST_OBSERVATION_RANGE);
        expect(speechIds.has(update.speechEventId)).toBe(true); // 観測した発言へ遡れる
      }
      for (const record of final.speechTruthfulnessLog ?? []) {
        expect(record.truthfulness).toBeGreaterThanOrEqual(0);
        expect(record.truthfulness).toBeLessThanOrEqual(1);
        expect(speechIds.has(record.speechEventId)).toBe(true);
      }
      // personality基礎値はON実行でも初期状態から一切変化しない
      const initial = createInitialState(7, preset.params, undefined, { enabled: true }, { enabled: true }, { enabled: true });
      const initialById = new Map(initial.agents.map((a) => [a.id, a]));
      for (const agent of final.agents) {
        const before = initialById.get(agent.id)!;
        expect(agent.willingness).toBe(before.willingness);
        expect(agent.initiative).toBe(before.initiative);
        expect(agent.ambiguityTolerance).toBe(before.ambiguityTolerance);
        expect(agent.influenceAvoidance).toBe(before.influenceAvoidance);
        expect(agent.conformity).toBe(before.conformity);
        expect(agent.leaveThreshold).toBe(before.leaveThreshold);
      }
    }
  });
});
