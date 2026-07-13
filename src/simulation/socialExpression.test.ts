import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOCIAL_EXPRESSION_CONFIG,
  derivePrivateEvaluations,
  derivePublicExpressions,
  resolveSocialExpressionConfig,
} from "./socialExpression";
import { attractiveness, createInitialState, stepSimulation } from "./engine";
import { sumActiveEffectValue } from "./speechEffects";
import type { SpeechActiveEffect } from "./speechEffects";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS, PRESETS } from "./presets";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./model";
import type { Agent, GroupCandidate, SimulationState } from "./types";

const ENABLED = resolveSocialExpressionConfig({ enabled: true });

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
    x: 500,
    y: 300,
    memberIds: [],
    status: "forming",
    age: 0,
    ...overrides,
  };
}

function makeState(overrides: Partial<SimulationState>): SimulationState {
  return {
    tick: 5,
    agents: [],
    groupCandidates: [],
    log: [],
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    finished: false,
    ...overrides,
  };
}

function runSimulationStates(seed: number, params = DEFAULT_PARAMS, maxTicks = 120): SimulationState[] {
  const rng = new SeededRandom(seed);
  let state = createInitialState(seed, params);
  const states: SimulationState[] = [state];
  let ticks = 0;
  while (!state.finished && ticks < maxTicks) {
    state = stepSimulation(state, params, rng);
    states.push(state);
    ticks += 1;
  }
  return states;
}

describe("SocialExpressionConfig", () => {
  it("デフォルトは無効(enabled: false)である", () => {
    expect(DEFAULT_SOCIAL_EXPRESSION_CONFIG.enabled).toBe(false);
    expect(resolveSocialExpressionConfig().enabled).toBe(false);
    expect(resolveSocialExpressionConfig({}).enabled).toBe(false);
  });

  it("部分指定をデフォルトで補完する", () => {
    expect(resolveSocialExpressionConfig({ enabled: true })).toEqual({ enabled: true });
  });
});

describe("config無効時(デフォルト)の後方互換", () => {
  it("derivePrivateEvaluations / derivePublicExpressions はいずれも空配列を返す", () => {
    const state = makeState({
      agents: [makeAgent({ id: "a1" }), makeAgent({ id: "a2" })],
      groupCandidates: [makeCandidate({})],
    });
    const disabled = resolveSocialExpressionConfig();
    const privates = derivePrivateEvaluations(state, DEFAULT_PARAMS, disabled);
    expect(privates).toEqual([]);
    expect(derivePublicExpressions(privates, disabled)).toEqual([]);
  });
});

describe("PrivateEvaluationの導出(既存判断式との対応)", () => {
  it("全エージェントについて1件ずつ、agents配列順に導出される", () => {
    const state = makeState({
      agents: [
        makeAgent({ id: "a1", state: "undecided" }),
        makeAgent({ id: "a2", state: "joined" }),
        makeAgent({ id: "a3", state: "left" }),
      ],
    });
    const privates = derivePrivateEvaluations(state, DEFAULT_PARAMS, ENABLED);
    expect(privates.map((p) => p.agentId)).toEqual(["a1", "a2", "a3"]);
    expect(privates.map((p) => p.agentState)).toEqual(["undecided", "joined", "left"]);
    expect(privates.map((p) => p.id)).toEqual(["private-5-a1", "private-5-a2", "private-5-a3"]);
  });

  it("candidateEvaluationsはjoinable(forming/confirmed)な候補のみを含み、engineのattractiveness()と同値になる", () => {
    const agent = makeAgent({ id: "a1", cliqueId: 1 });
    const member = makeAgent({ id: "a2", cliqueId: 2, state: "joined" });
    const forming = makeCandidate({ id: "g-forming", status: "forming", memberIds: ["a2"] });
    const confirmed = makeCandidate({ id: "g-confirmed", status: "confirmed", memberIds: ["a2"], x: 200, y: 100 });
    const dissolved = makeCandidate({ id: "g-dissolved", status: "dissolved" });
    const state = makeState({
      agents: [agent, member],
      groupCandidates: [forming, confirmed, dissolved],
    });

    const [evaluation] = derivePrivateEvaluations(state, DEFAULT_PARAMS, ENABLED);
    expect(evaluation.candidateEvaluations.map((c) => c.groupId)).toEqual(["g-forming", "g-confirmed"]);
    expect(evaluation.candidateEvaluations.map((c) => c.groupStatus)).toEqual(["forming", "confirmed"]);

    for (const candidateEvaluation of evaluation.candidateEvaluations) {
      const candidate = state.groupCandidates.find((c) => c.id === candidateEvaluation.groupId)!;
      expect(candidateEvaluation.attractiveness).toBe(
        attractiveness(agent, candidate, state.agents, DEFAULT_PARAMS, "none", state.tick, []),
      );
    }

    // 最寄り判定: agent(400, 260)からはg-forming(500, 300)がg-confirmed(200, 100)より近い
    expect(evaluation.candidateEvaluations.find((c) => c.groupId === "g-forming")?.isNearest).toBe(true);
    expect(evaluation.candidateEvaluations.find((c) => c.groupId === "g-confirmed")?.isNearest).toBe(false);
  });

  it("joinDesireはwillingness、leaveInclinationはstress/leaveThresholdの比率になる", () => {
    const state = makeState({
      agents: [makeAgent({ id: "a1", willingness: 0.7, stress: 0.3, leaveThreshold: 0.6 })],
    });
    const [evaluation] = derivePrivateEvaluations(state, DEFAULT_PARAMS, ENABLED);
    expect(evaluation.joinDesire).toBe(0.7);
    expect(evaluation.leaveInclination).toBeCloseTo(0.3 / 0.6, 10);
  });

  it("leaveInclinationの分母には'decline'由来のSpeechActiveEffect補正(engineの実効しきい値と同じ計算)を含む", () => {
    const effect: SpeechActiveEffect = {
      id: "ae-1",
      speechEffectEventId: "see-1",
      speechEventId: "sp-1",
      speakerId: "a2",
      intent: "decline",
      receiverId: "a1",
      dimension: "leaveThreshold",
      startedAtTick: 5,
      expiresAtTick: 15,
      initialStrength: -0.05,
      currentStrength: -0.05,
      decay: "linear",
    };
    const agent = makeAgent({ id: "a1", stress: 0.3, leaveThreshold: 0.6 });
    const state = makeState({
      agents: [agent],
      speechEffectsEnabled: true,
      activeSpeechEffects: [effect],
    });

    const [evaluation] = derivePrivateEvaluations(state, DEFAULT_PARAMS, ENABLED);
    const expectedThreshold = 0.6 + sumActiveEffectValue([effect], "a1", "leaveThreshold", state.tick);
    expect(expectedThreshold).not.toBe(0.6); // 補正が実際に効いていることの前提確認
    expect(evaluation.leaveInclination).toBeCloseTo(0.3 / expectedThreshold, 10);
  });

  it("speechEffectsEnabledがfalse(またはundefined)なら、activeSpeechEffectsが残っていても効果を参照しない", () => {
    const effect: SpeechActiveEffect = {
      id: "ae-1",
      speechEffectEventId: "see-1",
      speechEventId: "sp-1",
      speakerId: "a2",
      intent: "decline",
      receiverId: "a1",
      dimension: "leaveThreshold",
      startedAtTick: 5,
      expiresAtTick: 15,
      initialStrength: -0.05,
      currentStrength: -0.05,
      decay: "linear",
    };
    const agent = makeAgent({ id: "a1", stress: 0.3, leaveThreshold: 0.6 });
    const state = makeState({
      agents: [agent],
      speechEffectsEnabled: false,
      activeSpeechEffects: [effect],
    });

    const [evaluation] = derivePrivateEvaluations(state, DEFAULT_PARAMS, ENABLED);
    expect(evaluation.leaveInclination).toBeCloseTo(0.3 / 0.6, 10);
  });
});

describe("PublicExpressionの導出(#113では本心と常に一致)", () => {
  it("PrivateEvaluationと同値になり、divergentは常にfalse、privateEvaluationIdでリンクされる", () => {
    const state = makeState({
      agents: [
        makeAgent({ id: "a1", willingness: 0.7, stress: 0.3, leaveThreshold: 0.6 }),
        makeAgent({ id: "a2", willingness: 0.2, stress: 0.1, leaveThreshold: 0.4 }),
      ],
    });
    const privates = derivePrivateEvaluations(state, DEFAULT_PARAMS, ENABLED);
    const publics = derivePublicExpressions(privates, ENABLED);

    expect(publics).toHaveLength(privates.length);
    for (let i = 0; i < privates.length; i++) {
      expect(publics[i].privateEvaluationId).toBe(privates[i].id);
      expect(publics[i].tick).toBe(privates[i].tick);
      expect(publics[i].agentId).toBe(privates[i].agentId);
      expect(publics[i].expressedJoinDesire).toBe(privates[i].joinDesire);
      expect(publics[i].expressedLeaveInclination).toBe(privates[i].leaveInclination);
      expect(publics[i].divergent).toBe(false);
    }
  });
});

describe("非干渉性: 導出はstateをmutationせず、本体rngを消費しない", () => {
  it("導出の前後でSimulationStateが変化しない", () => {
    const states = runSimulationStates(12345, DEFAULT_PARAMS, 30);
    const state = states[states.length - 1];
    const before = JSON.stringify(state);
    const privates = derivePrivateEvaluations(state, DEFAULT_PARAMS, ENABLED);
    derivePublicExpressions(privates, ENABLED);
    expect(JSON.stringify(state)).toBe(before);
  });

  for (const preset of PRESETS) {
    it(`preset="${preset.id}": 毎tick導出しながら進めても、導出しない場合と状態系列・PRNG消費が完全一致する`, () => {
      const seed = 1;
      const maxTicks = 400;

      const run = (deriveEachTick: boolean) => {
        const rng = new SeededRandom(seed);
        let state = createInitialState(seed, preset.params);
        const serialized: string[] = [JSON.stringify(state)];
        let ticks = 0;
        while (!state.finished && ticks < maxTicks) {
          state = stepSimulation(state, preset.params, rng);
          if (deriveEachTick) {
            const privates = derivePrivateEvaluations(state, preset.params, ENABLED);
            derivePublicExpressions(privates, ENABLED);
          }
          serialized.push(JSON.stringify(state));
          ticks += 1;
        }
        // 導出関数はrngを受け取らないため、後続乱数が一致すれば消費回数が変わっていない証拠になる
        return { serialized, rngProbe: rng.next() };
      };

      const baseline = run(false);
      const withDerivation = run(true);
      expect(withDerivation.serialized).toEqual(baseline.serialized);
      expect(withDerivation.rngProbe).toBe(baseline.rngProbe);
    });
  }
});

describe("再現性: 同一seed・同一設定で導出結果が一致する", () => {
  it("同じseedの2回のシミュレーション実行に対する全tickの導出結果が完全一致する", () => {
    const derive = () => {
      const states = runSimulationStates(999999, DEFAULT_PARAMS, 120);
      return states.map((state) => {
        const privates = derivePrivateEvaluations(state, DEFAULT_PARAMS, ENABLED);
        return JSON.stringify({ privates, publics: derivePublicExpressions(privates, ENABLED) });
      });
    };
    expect(derive()).toEqual(derive());
  });
});
