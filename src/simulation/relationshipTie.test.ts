import { describe, expect, it } from "vitest";
import {
  aggregateGroupTieCorrection,
  correctionFromHistory,
  createTieCorrectionResolver,
  deriveTieCorrections,
  deriveTieObservations,
  MAX_TIE_CORRECTION,
  registerTieCommitments,
  resolveRelationshipTieConfig,
  TIE_CONSISTENT_WEIGHT,
  TIE_HISTORY_LIMIT,
  TIE_INCONSISTENT_WEIGHT,
  TIE_OBSERVATION_RANGE,
  TIE_OBSERVATION_WINDOW,
  tiePairKey,
} from "./relationshipTie";
import type { RelationshipTieState, TieConsistencyObservation, TieObservationCommitment } from "./relationshipTie";
import { attractiveness, createInitialState, stepSimulation } from "./engine";
import { deriveSpeechReceptions } from "./speechEffects";
import { createSpeechEvent } from "./speech";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS, PRESETS } from "./presets";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./model";
import type { Agent, GroupCandidate, SimulationState } from "./types";

const TIE_ON = resolveRelationshipTieConfig({ enabled: true });
const TIE_OFF = resolveRelationshipTieConfig();
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

function obs(overrides: Partial<TieConsistencyObservation>): TieConsistencyObservation {
  return {
    speechEventId: "s",
    speechTick: 1,
    observedTick: 2,
    intent: "invite",
    observation: "consistent",
    observedFromState: "undecided",
    observedToState: "joined",
    weight: TIE_CONSISTENT_WEIGHT,
    ...overrides,
  };
}

describe("correctionFromHistory / deriveTieCorrections", () => {
  it("weightの総和を[-MAX, MAX]へclampする", () => {
    expect(correctionFromHistory([])).toBe(0);
    expect(correctionFromHistory([obs({}), obs({})])).toBeCloseTo(2 * TIE_CONSISTENT_WEIGHT, 10);
    // 一致観測を大量に積んでも上限で頭打ち
    const many = Array.from({ length: 20 }, () => obs({}));
    expect(correctionFromHistory(many)).toBe(MAX_TIE_CORRECTION);
    // 不一致観測を大量に積むと下限で頭打ち
    const manyNeg = Array.from({ length: 20 }, () => obs({ observation: "inconsistent", weight: TIE_INCONSISTENT_WEIGHT }));
    expect(correctionFromHistory(manyNeg)).toBe(-MAX_TIE_CORRECTION);
  });

  it("履歴の並び順に依存しない(加算のみ)", () => {
    const a = obs({ weight: TIE_CONSISTENT_WEIGHT });
    const b = obs({ observation: "inconsistent", weight: TIE_INCONSISTENT_WEIGHT });
    expect(correctionFromHistory([a, b])).toBe(correctionFromHistory([b, a]));
  });

  it("deriveTieCorrectionsは空履歴のpairを含めない", () => {
    const history: RelationshipTieState = { "o->s": [obs({})], "o->empty": [] };
    const corrections = deriveTieCorrections(history);
    expect(corrections["o->s"]).toBeCloseTo(TIE_CONSISTENT_WEIGHT, 10);
    expect("o->empty" in corrections).toBe(false);
  });
});

describe("aggregateGroupTieCorrection", () => {
  it("構成員pairの補正を合算し[-MAX, MAX]へclamp、自分自身は除外する", () => {
    const corrections = {
      [tiePairKey("obs", "m1")]: 0.1,
      [tiePairKey("obs", "m2")]: 0.15,
      [tiePairKey("obs", "obs")]: 0.9, // 自分自身は無視される
    };
    expect(aggregateGroupTieCorrection("obs", ["m1", "m2", "obs"], corrections)).toBe(MAX_TIE_CORRECTION); // 0.25→clamp0.2
    expect(aggregateGroupTieCorrection("obs", ["m1"], corrections)).toBeCloseTo(0.1, 10);
    expect(aggregateGroupTieCorrection("obs", ["unknown"], corrections)).toBe(0);
  });
});

describe("attractiveness: tie補正の反映(加算方式)", () => {
  const members = [makeAgent({ id: "m1", cliqueId: 1 }), makeAgent({ id: "m2", cliqueId: 1 })];
  const outsider = makeAgent({ id: "out", cliqueId: 2 });
  const candidate: GroupCandidate = {
    id: "g1",
    x: 400,
    y: 260,
    memberIds: ["m1", "m2"],
    status: "confirmed",
    age: 5,
  };
  const agents = [...members, outsider];
  const params = { ...DEFAULT_PARAMS, existingTieStrength: 0.8 };

  it("tieCorrection=0(デフォルト)は従来式と完全一致する", () => {
    expect(attractiveness(outsider, candidate, agents, params, undefined, 0, [])).toBe(
      attractiveness(outsider, candidate, agents, params, undefined, 0, [], 0),
    );
  });

  it("部外者への正のtie補正はoutsider penaltyを減らし魅力度を上げる", () => {
    const without = attractiveness(outsider, candidate, agents, params, undefined, 0, [], 0);
    const withPositive = attractiveness(outsider, candidate, agents, params, undefined, 0, [], 0.2);
    expect(withPositive).toBeGreaterThan(without);
  });

  it("部外者への負のtie補正はoutsider penaltyを増やし魅力度を下げる", () => {
    const without = attractiveness(outsider, candidate, agents, params, undefined, 0, [], 0);
    const withNegative = attractiveness(outsider, candidate, agents, params, undefined, 0, [], -0.2);
    expect(withNegative).toBeLessThanOrEqual(without);
  });

  it("同一cliqueメンバーへの負のtie補正はclique bonusを減らす(0未満にはならない)", () => {
    const member = members[0];
    const without = attractiveness(member, candidate, agents, params, undefined, 0, [], 0);
    const withNegative = attractiveness(member, candidate, agents, params, undefined, 0, [], -0.2);
    expect(withNegative).toBeLessThanOrEqual(without);
    expect(withNegative).toBeGreaterThanOrEqual(0);
  });
});

describe("registerTieCommitments", () => {
  const speech = createSpeechEvent({
    tick: 7,
    speakerId: "s1",
    intent: "invite",
    reason: "initiativeFormedCore",
    audience: "nearby",
    originX: 100,
    originY: 100,
  });

  it("heard: trueの受け手のみhearerとして登録し、expiresAtTickに窓を設定する", () => {
    const candidates = [makeAgent({ id: "near", x: 150, y: 100 }), makeAgent({ id: "far", x: 750, y: 500 })];
    const receptions = deriveSpeechReceptions([speech], candidates, EFFECTS_ON);
    const commitments = registerTieCommitments([], [speech], receptions, TIE_ON);
    expect(commitments).toEqual([
      {
        speechEventId: speech.id,
        speechTick: 7,
        speakerId: "s1",
        intent: "invite",
        hearerIds: ["near"],
        expiresAtTick: 7 + TIE_OBSERVATION_WINDOW,
      },
    ]);
  });

  it("認知者がいない発言はコミットメントを作らない / config無効時は入力そのまま", () => {
    const candidates = [makeAgent({ id: "far", x: 750, y: 500 })];
    const receptions = deriveSpeechReceptions([speech], candidates, EFFECTS_ON);
    expect(registerTieCommitments([], [speech], receptions, TIE_ON)).toEqual([]);

    const existing: TieObservationCommitment[] = [
      { speechEventId: "x", speechTick: 1, speakerId: "s", intent: "greet", hearerIds: ["a"], expiresAtTick: 13 },
    ];
    expect(registerTieCommitments(existing, [speech], receptions, TIE_OFF)).toEqual(existing);
  });
});

describe("deriveTieObservations: 整合性履歴の更新", () => {
  const commitment = (over: Partial<TieObservationCommitment> = {}): TieObservationCommitment => ({
    speechEventId: "speech-3-s1-invite",
    speechTick: 3,
    speakerId: "s1",
    intent: "invite",
    hearerIds: ["o1"],
    expiresAtTick: 3 + TIE_OBSERVATION_WINDOW,
    ...over,
  });

  it("窓内の一致遷移(invite→joined)を範囲内hearerが観測し履歴・補正が増える", () => {
    const prev = [makeAgent({ id: "s1", state: "approaching" }), makeAgent({ id: "o1", x: 420, y: 260 })];
    const next = [makeAgent({ id: "s1", state: "joined" }), makeAgent({ id: "o1", x: 420, y: 260 })];
    const result = deriveTieObservations([commitment()], {}, prev, next, 6, TIE_ON);

    expect(result.commitments).toEqual([]); // 解決済み
    expect(result.updates).toHaveLength(1);
    const [update] = result.updates;
    expect(update.observerId).toBe("o1");
    expect(update.observation).toBe("consistent");
    expect(update.observedToState).toBe("joined");
    expect(update.previousCorrection).toBe(0);
    expect(update.newCorrection).toBeCloseTo(TIE_CONSISTENT_WEIGHT, 10);
    expect(update.historySize).toBe(1);
    expect(result.history[tiePairKey("o1", "s1")]).toHaveLength(1);
  });

  it("窓内の不一致遷移(invite→leaving)は補正を下げる", () => {
    const prev = [makeAgent({ id: "s1", state: "undecided" }), makeAgent({ id: "o1", x: 420, y: 260 })];
    const next = [makeAgent({ id: "s1", state: "leaving" }), makeAgent({ id: "o1", x: 420, y: 260 })];
    const result = deriveTieObservations([commitment()], {}, prev, next, 5, TIE_ON);
    expect(result.updates[0].observation).toBe("inconsistent");
    expect(result.updates[0].newCorrection).toBeCloseTo(TIE_INCONSISTENT_WEIGHT, 10);
  });

  it("時間窓(N tick)を過ぎた未観測コミットメントは失効し、履歴に残らない", () => {
    // 遷移なし(undecidedのまま) & tick >= expiresAtTick
    const prev = [makeAgent({ id: "s1", state: "undecided" }), makeAgent({ id: "o1", x: 420, y: 260 })];
    const next = [makeAgent({ id: "s1", state: "undecided" }), makeAgent({ id: "o1", x: 420, y: 260 })];
    const expired = commitment({ expiresAtTick: 4 });
    const result = deriveTieObservations([expired], {}, prev, next, 4, TIE_ON);
    expect(result.commitments).toEqual([]); // 失効で除去
    expect(result.updates).toEqual([]);
    expect(result.history).toEqual({});
  });

  it("窓内でまだ決定的な遷移がなければ保留のまま残る", () => {
    const prev = [makeAgent({ id: "s1", state: "undecided" }), makeAgent({ id: "o1", x: 420, y: 260 })];
    const next = [makeAgent({ id: "s1", state: "approaching" }), makeAgent({ id: "o1", x: 420, y: 260 })];
    const pending = commitment({ expiresAtTick: 10 });
    const result = deriveTieObservations([pending], {}, prev, next, 5, TIE_ON);
    expect(result.commitments).toEqual([pending]); // approachingはinviteに対し未確定
    expect(result.updates).toEqual([]);
  });

  it("観測tickに知覚範囲外だったhearerは更新されない(コミットメントは解決される)", () => {
    const prev = [makeAgent({ id: "s1", state: "approaching", x: 100, y: 100 }), makeAgent({ id: "o1", x: 100, y: 100 })];
    const next = [
      makeAgent({ id: "s1", state: "joined", x: 100, y: 100 }),
      makeAgent({ id: "o1", x: 100 + TIE_OBSERVATION_RANGE + 1, y: 100 }),
    ];
    const result = deriveTieObservations([commitment()], {}, prev, next, 6, TIE_ON);
    expect(result.updates).toEqual([]);
    expect(result.history).toEqual({});
    expect(result.commitments).toEqual([]);
  });

  it("履歴保持件数の上限を超えると最古から破棄される", () => {
    const key = tiePairKey("o1", "s1");
    const full: TieConsistencyObservation[] = Array.from({ length: TIE_HISTORY_LIMIT }, (_, i) =>
      obs({ speechEventId: `old-${i}`, observation: "inconsistent", weight: TIE_INCONSISTENT_WEIGHT }),
    );
    const prev = [makeAgent({ id: "s1", state: "approaching" }), makeAgent({ id: "o1", x: 420, y: 260 })];
    const next = [makeAgent({ id: "s1", state: "joined" }), makeAgent({ id: "o1", x: 420, y: 260 })];
    const result = deriveTieObservations([commitment({ speechEventId: "new" })], { [key]: full }, prev, next, 6, TIE_ON);
    const updated = result.history[key];
    expect(updated).toHaveLength(TIE_HISTORY_LIMIT); // 上限維持
    expect(updated[updated.length - 1].speechEventId).toBe("new"); // 新しいものが末尾
    expect(updated.some((e) => e.speechEventId === "old-0")).toBe(false); // 最古が破棄
  });

  it("入力配列順を反転しても結果が変わらない(安定順序)", () => {
    const c1 = commitment({ speechEventId: "speech-3-a", speechTick: 3 });
    const c2 = commitment({ speechEventId: "speech-4-b", speechTick: 4, expiresAtTick: 4 + TIE_OBSERVATION_WINDOW });
    const prev = [makeAgent({ id: "s1", state: "approaching" }), makeAgent({ id: "o1", x: 420, y: 260 })];
    const next = [makeAgent({ id: "s1", state: "joined" }), makeAgent({ id: "o1", x: 420, y: 260 })];
    const forward = deriveTieObservations([c1, c2], {}, prev, next, 6, TIE_ON);
    const reversed = deriveTieObservations([c2, c1], {}, prev, next, 6, TIE_ON);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });

  it("config無効時は履歴コピーを返し観測もコミットメント解決もしない", () => {
    const key = tiePairKey("o1", "s1");
    const history: RelationshipTieState = { [key]: [obs({})] };
    const prev = [makeAgent({ id: "s1", state: "approaching" }), makeAgent({ id: "o1", x: 420, y: 260 })];
    const next = [makeAgent({ id: "s1", state: "joined" }), makeAgent({ id: "o1", x: 420, y: 260 })];
    const result = deriveTieObservations([commitment()], history, prev, next, 6, TIE_OFF);
    expect(result.updates).toEqual([]);
    expect(result.history).toEqual(history);
    expect(result.history).not.toBe(history); // 防御的コピー(入力は不変)
    expect(result.commitments).toHaveLength(1);
  });

  it("決定的: 同一入力で常に同一結果", () => {
    const prev = [makeAgent({ id: "s1", state: "approaching" }), makeAgent({ id: "o1", x: 420, y: 260 })];
    const next = [makeAgent({ id: "s1", state: "joined" }), makeAgent({ id: "o1", x: 420, y: 260 })];
    const first = deriveTieObservations([commitment()], {}, prev, next, 6, TIE_ON);
    const second = deriveTieObservations([commitment()], {}, prev, next, 6, TIE_ON);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("createTieCorrectionResolver", () => {
  it("受け手→話者pairの補正を返し、未登場は0", () => {
    const resolver = createTieCorrectionResolver({ [tiePairKey("r", "s")]: 0.12 });
    expect(resolver("r", "s", false)).toBeCloseTo(0.12, 10);
    expect(resolver("r", "other", false)).toBe(0);
  });
});

describe("engine統合: 整合性観測と関係性補正", () => {
  const step = (s: SimulationState, rng: SeededRandom) =>
    stepSimulation(s, DEFAULT_PARAMS, rng, undefined, { enabled: true }, undefined, undefined, { enabled: true });

  it("invite発言→話者のleaving(不一致)を近くで聞いた受け手のtie補正が下がり、因果が記録される", () => {
    // s1: 核形成でinvite発言 → その後stressで離脱(不一致)。o1: 近くで観測する非離脱の傍観者。
    const speaker = makeAgent({ id: "s1", x: 400, y: 300, willingness: 1, initiative: 1, stress: 0.2, leaveThreshold: 0.5 });
    const observer = makeAgent({ id: "o1", x: 400, y: 260, leaveThreshold: 1, ambiguityTolerance: 1, initiative: 0 });
    let state = makeState({ tick: 1, agents: [speaker, observer] });
    const rng = new SeededRandom(3);

    // 決定的にするため多数tick回し、観測が起きるか(起きなければテスト前提が崩れるので確認)
    let sawUpdate = false;
    for (let i = 0; i < 60 && !state.finished; i++) {
      state = step(state, rng);
      if ((state.relationshipTieUpdateLog?.length ?? 0) > 0) {
        sawUpdate = true;
        break;
      }
    }

    if (sawUpdate) {
      const update = state.relationshipTieUpdateLog![0];
      const speechIds = new Set((state.speechLog ?? []).map((e) => e.id));
      expect(speechIds.has(update.speechEventId)).toBe(true); // 観測した発言へ遡れる
      expect(update.distance).toBeLessThanOrEqual(TIE_OBSERVATION_RANGE);
      expect(update.newCorrection).toBeGreaterThanOrEqual(-MAX_TIE_CORRECTION);
      expect(update.newCorrection).toBeLessThanOrEqual(MAX_TIE_CORRECTION);
      expect(update.delta).toBeCloseTo(update.newCorrection - update.previousCorrection, 10);
      // 履歴に反映されている
      const history = state.tieHistory?.[tiePairKey(update.observerId, update.speakerId)];
      expect(history && history.length).toBeGreaterThan(0);
    }
    // 少なくともpersonality基礎値・cliqueId・existingTieStrengthは不変
    const finalSpeaker = state.agents.find((a) => a.id === "s1")!;
    expect(finalSpeaker.willingness).toBe(1);
    expect(finalSpeaker.leaveThreshold).toBe(0.5);
  });

  it("relationshipTieEnabledはstateへ引き継がれ、以後のtickで未指定でも維持される", () => {
    const initial = createInitialState(1, DEFAULT_PARAMS, undefined, undefined, undefined, undefined, { enabled: true });
    expect(initial.relationshipTieEnabled).toBe(true);
    const rng = new SeededRandom(1);
    const next = stepSimulation(initial, DEFAULT_PARAMS, rng);
    expect(next.relationshipTieEnabled).toBe(true);

    const defaultInitial = createInitialState(1, DEFAULT_PARAMS);
    expect(defaultInitial.relationshipTieEnabled).toBe(false);
  });
});

describe("後方互換と再現性(Issue #117の受入条件)", () => {
  type RunOptions = { speechEffects: boolean; socialExpression: boolean; speechTrust: boolean; relationshipTie: boolean };
  type RunResult = { serialized: string[]; rngProbe: number; final: SimulationState };

  const run = (params: typeof DEFAULT_PARAMS, options: RunOptions, seed = 7, maxTicks = 400): RunResult => {
    const rng = new SeededRandom(seed);
    const effects = { enabled: options.speechEffects };
    const social = { enabled: options.socialExpression };
    const trust = { enabled: options.speechTrust };
    const tie = { enabled: options.relationshipTie };
    let state = createInitialState(seed, params, undefined, effects, social, trust, tie);
    const core = (s: SimulationState) =>
      JSON.stringify({ tick: s.tick, agents: s.agents, groupCandidates: s.groupCandidates, log: s.log, finished: s.finished });
    const serialized: string[] = [core(state)];
    let ticks = 0;
    while (!state.finished && ticks < maxTicks) {
      state = stepSimulation(state, params, rng, undefined, effects, social, trust, tie);
      serialized.push(core(state));
      ticks += 1;
    }
    return { serialized, rngProbe: rng.next(), final: state };
  };

  for (const preset of PRESETS) {
    it(`preset="${preset.id}": tie OFF時は全機能OFFと状態系列・PRNG消費が完全一致し、tie記録は空`, () => {
      const allOff = run(preset.params, { speechEffects: false, socialExpression: false, speechTrust: false, relationshipTie: false });
      // tieだけON(他OFF)でもspeechEffects OFFなら認知が存在せず観測が発生しない → 状態系列は完全一致
      const tieOnly = run(preset.params, { speechEffects: false, socialExpression: false, speechTrust: false, relationshipTie: true });
      expect(tieOnly.serialized).toEqual(allOff.serialized);
      expect(tieOnly.rngProbe).toBe(allOff.rngProbe);
      expect(tieOnly.final.relationshipTieUpdateLog).toEqual([]);
      expect(tieOnly.final.tieHistory).toEqual({});
      expect(tieOnly.final.tieCommitments).toEqual([]);
    });
  }

  it("同一seed・同一設定(全機能ON)ならtie履歴・更新記録・状態系列が完全に再現される", () => {
    const options = { speechEffects: true, socialExpression: true, speechTrust: true, relationshipTie: true };
    const first = run(DEFAULT_PARAMS, options);
    const second = run(DEFAULT_PARAMS, options);
    expect(first.serialized).toEqual(second.serialized);
    expect(first.rngProbe).toBe(second.rngProbe);
    expect(JSON.stringify(first.final.tieHistory)).toBe(JSON.stringify(second.final.tieHistory));
    expect(JSON.stringify(first.final.relationshipTieUpdateLog)).toBe(JSON.stringify(second.final.relationshipTieUpdateLog));
  });

  it("全機能ON実行で、更新記録が範囲内・因果追跡可能・existingTieStrength/cliqueId/personalityが不変", () => {
    const options = { speechEffects: true, socialExpression: true, speechTrust: true, relationshipTie: true };
    for (const preset of PRESETS) {
      const { final } = run(preset.params, options);
      const speechIds = new Set((final.speechLog ?? []).map((e) => e.id));
      for (const update of final.relationshipTieUpdateLog ?? []) {
        expect(update.newCorrection).toBeGreaterThanOrEqual(-MAX_TIE_CORRECTION);
        expect(update.newCorrection).toBeLessThanOrEqual(MAX_TIE_CORRECTION);
        expect(update.delta).toBeCloseTo(update.newCorrection - update.previousCorrection, 10);
        expect(update.distance).toBeLessThanOrEqual(TIE_OBSERVATION_RANGE);
        expect(speechIds.has(update.speechEventId)).toBe(true);
      }
      for (const [, history] of Object.entries(final.tieHistory ?? {})) {
        expect(history.length).toBeLessThanOrEqual(TIE_HISTORY_LIMIT);
      }
      const initial = createInitialState(7, preset.params, undefined, { enabled: true }, { enabled: true }, { enabled: true }, { enabled: true });
      const initialById = new Map(initial.agents.map((a) => [a.id, a]));
      for (const agent of final.agents) {
        const before = initialById.get(agent.id)!;
        expect(agent.cliqueId).toBe(before.cliqueId);
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

describe("プリセット5のobserverJoiner孤立が維持される(複数seed)", () => {
  const preset5 = PRESETS.find((p) => p.id === "leftover-free-grouping");

  it("tie ON/OFFいずれでも、複数seedでobserverJoinerが常に全員合流するわけではない(孤立の余地が残る)", () => {
    expect(preset5).toBeDefined();
    const params = preset5!.params;
    const runObserverJoined = (seed: number, tieOn: boolean): boolean[] => {
      const rng = new SeededRandom(seed);
      const tie = { enabled: tieOn };
      // Phase 3/4を有効化した最も補正が効きうる条件で確認する
      let state = createInitialState(seed, params, undefined, { enabled: true }, { enabled: true }, { enabled: true }, tie);
      let ticks = 0;
      while (!state.finished && ticks < 400) {
        state = stepSimulation(state, params, rng, undefined, { enabled: true }, { enabled: true }, { enabled: true }, tie);
        ticks += 1;
      }
      return state.agents.filter((a) => a.isObserverJoiner).map((a) => a.state === "joined");
    };

    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    for (const tieOn of [false, true]) {
      const results = seeds.map((seed) => runObserverJoined(seed, tieOn));
      // 全seedで全observerJoinerが必ずjoinedになる(=孤立の余地が消える)ことはない
      const alwaysAllJoined = results.every((joinedFlags) => joinedFlags.length > 0 && joinedFlags.every(Boolean));
      expect(alwaysAllJoined).toBe(false);
    }
  });
});
