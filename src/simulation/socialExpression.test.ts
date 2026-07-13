import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOCIAL_EXPRESSION_CONFIG,
  derivePrivateEvaluations,
  derivePublicExpressions,
  EXPRESSION_AUDIBLE_RANGE,
  MAX_DIVERGENCE_PER_DIMENSION,
  resolveSocialExpressionConfig,
  stanceOfJoinDesire,
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
    expect(derivePublicExpressions(privates, state, DEFAULT_PARAMS, disabled)).toEqual([]);
  });

  it("config無効時は、有効時なら乖離が判定される入力に対しても空配列を返す", () => {
    const state = makeState({
      agents: [makeAgent({ id: "a1", willingness: 0.9, influenceAvoidance: 0.9 })],
    });
    const privates = derivePrivateEvaluations(state, DEFAULT_PARAMS, ENABLED);
    expect(derivePublicExpressions(privates, state, DEFAULT_PARAMS, resolveSocialExpressionConfig())).toEqual([]);
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

describe("PublicExpressionの導出: 乖離条件がなければ本心と一致する", () => {
  it("乖離要因がすべて不成立なら本心と同値になり、divergentはfalse、全要因のcontributionは0", () => {
    // influenceAvoidance 0(遠慮なし)・conformity 0(同調なし)・cliqueなし(印象管理なし)
    const state = makeState({
      agents: [
        makeAgent({ id: "a1", willingness: 0.7, stress: 0.3, leaveThreshold: 0.6, influenceAvoidance: 0, conformity: 0 }),
        makeAgent({ id: "a2", willingness: 0.2, stress: 0.1, leaveThreshold: 0.4, influenceAvoidance: 0, conformity: 0 }),
      ],
    });
    const privates = derivePrivateEvaluations(state, DEFAULT_PARAMS, ENABLED);
    const publics = derivePublicExpressions(privates, state, DEFAULT_PARAMS, ENABLED);

    expect(publics).toHaveLength(privates.length);
    for (let i = 0; i < privates.length; i++) {
      expect(publics[i].privateEvaluationId).toBe(privates[i].id);
      expect(publics[i].tick).toBe(privates[i].tick);
      expect(publics[i].agentId).toBe(privates[i].agentId);
      expect(publics[i].expressedJoinDesire).toBe(privates[i].joinDesire);
      expect(publics[i].expressedLeaveInclination).toBe(privates[i].leaveInclination);
      expect(publics[i].divergent).toBe(false);
      for (const divergence of publics[i].divergences) {
        expect(divergence.delta).toBe(0);
        for (const factor of divergence.factors) {
          expect(factor.contribution).toBe(0);
        }
      }
    }
  });

  it("joinDesireが中立値(0.5)以下なら、influenceAvoidanceが高くても遠慮による抑制は働かない", () => {
    const state = makeState({
      agents: [makeAgent({ id: "a1", willingness: 0.5, influenceAvoidance: 1, conformity: 0 })],
    });
    const privates = derivePrivateEvaluations(state, DEFAULT_PARAMS, ENABLED);
    const [expression] = derivePublicExpressions(privates, state, DEFAULT_PARAMS, ENABLED);
    expect(expression.expressedJoinDesire).toBe(0.5);
    expect(expression.divergent).toBe(false);
  });
});

describe("乖離要因1: 遠慮・拒否回避(influenceAvoidance)", () => {
  it("influenceAvoidanceが高いほど、本心の積極さ(中立値超過分)が抑制される", () => {
    const deriveFor = (influenceAvoidance: number) => {
      const state = makeState({
        agents: [makeAgent({ id: "a1", willingness: 0.9, influenceAvoidance, conformity: 0 })],
      });
      const privates = derivePrivateEvaluations(state, DEFAULT_PARAMS, ENABLED);
      return derivePublicExpressions(privates, state, DEFAULT_PARAMS, ENABLED)[0];
    };

    const weak = deriveFor(0.3);
    const strong = deriveFor(0.9);
    // 抑制量 = influenceAvoidance * (joinDesire - 0.5)
    expect(weak.expressedJoinDesire).toBeCloseTo(0.9 - 0.3 * 0.4, 10);
    expect(strong.expressedJoinDesire).toBeCloseTo(0.9 - 0.9 * 0.4, 10);
    expect(strong.expressedJoinDesire).toBeLessThan(weak.expressedJoinDesire);
    // 抑制方向のみ(積極→消極への反転はしない): 最大でも中立値まで
    expect(strong.expressedJoinDesire).toBeGreaterThanOrEqual(0.5);

    const reserve = strong.divergences[0].factors.find((f) => f.key === "reserve")!;
    expect(reserve.dimension).toBe("joinDesire");
    expect(reserve.rawValue).toBe(0.9);
    expect(reserve.contribution).toBeCloseTo(-0.9 * 0.4, 10);
    expect(strong.divergent).toBe(true);
  });
});

describe("乖離要因2: 同調圧力(conformity × 可聴範囲内の多数派)", () => {
  const makeNeighbors = (states: Agent["state"][], x = 400, y = 260): Agent[] =>
    states.map((state, i) => makeAgent({ id: `n${i}`, state, x: x + 10 * (i + 1), y }));

  const deriveFor = (agent: Agent, neighbors: Agent[]) => {
    const state = makeState({ agents: [agent, ...neighbors] });
    const privates = derivePrivateEvaluations(state, DEFAULT_PARAMS, ENABLED);
    return derivePublicExpressions(privates, state, DEFAULT_PARAMS, ENABLED).find((e) => e.agentId === agent.id)!;
  };

  it("可聴範囲内でforming/approaching/joinedが優勢なら、conformityに応じて表明が積極側へ寄る", () => {
    const agent = makeAgent({ id: "a1", willingness: 0.4, influenceAvoidance: 0, conformity: 0.8 });
    const expression = deriveFor(agent, makeNeighbors(["joined", "forming", "approaching", "undecided"]));
    // シグナル = (3 - 1) / 4 = 0.5、寄与 = 0.8 * 0.3 * 0.5
    expect(expression.expressedJoinDesire).toBeCloseTo(0.4 + 0.8 * 0.3 * 0.5, 10);
    const factor = expression.divergences[0].factors.find((f) => f.key === "conformityPressure")!;
    expect(factor.rawValue).toBeCloseTo(0.5, 10);
    expect(factor.contribution).toBeGreaterThan(0);
    expect(expression.divergent).toBe(true);
  });

  it("undecided/leavingが優勢なら表明が消極側へ寄り、conformityが0なら寄らない", () => {
    const conforming = makeAgent({ id: "a1", willingness: 0.4, influenceAvoidance: 0, conformity: 1 });
    const pulled = deriveFor(conforming, makeNeighbors(["undecided", "leaving"]));
    // シグナル = (0 - 2) / 2 = -1、寄与 = 1 * 0.3 * -1
    expect(pulled.expressedJoinDesire).toBeCloseTo(0.4 - 0.3, 10);

    const independent = makeAgent({ id: "a1", willingness: 0.4, influenceAvoidance: 0, conformity: 0 });
    const unmoved = deriveFor(independent, makeNeighbors(["undecided", "leaving"]));
    expect(unmoved.expressedJoinDesire).toBe(0.4);
    expect(unmoved.divergent).toBe(false);
  });

  it("可聴範囲外のエージェントとleft状態のエージェントは多数派の集計に入らない", () => {
    const agent = makeAgent({ id: "a1", willingness: 0.4, influenceAvoidance: 0, conformity: 1 });
    const outOfRange = makeAgent({ id: "far", state: "joined", x: 400 + EXPRESSION_AUDIBLE_RANGE + 1, y: 260 });
    const gone = makeAgent({ id: "gone", state: "left", x: 410, y: 260 });
    const expression = deriveFor(agent, [outOfRange, gone]);
    // 集計対象の近傍が0人 → シグナル0 → 同調圧力なし
    expect(expression.expressedJoinDesire).toBe(0.4);
    expect(expression.divergent).toBe(false);
  });
});

describe("乖離要因3: 印象管理・社交辞令(関係の近さ × 離脱傾向の緩和)", () => {
  it("可聴範囲内に同一cliqueの相手がいるとき、existingTieStrengthが強いほど離脱傾向の表明が和らぐ", () => {
    // 本心のleaveInclination = 0.54 / 0.6 = 0.9
    const agent = makeAgent({ id: "a1", cliqueId: 1, stress: 0.54, leaveThreshold: 0.6, willingness: 0.3, influenceAvoidance: 0, conformity: 0 });
    const cliqueMate = makeAgent({ id: "a2", cliqueId: 1, x: 420, y: 260 });
    const state = makeState({ agents: [agent, cliqueMate] });
    const params = { ...DEFAULT_PARAMS, existingTieStrength: 0.8 };

    const privates = derivePrivateEvaluations(state, params, ENABLED);
    const [expression] = derivePublicExpressions(privates, state, params, ENABLED);
    // 緩和量 = tie(0.8) * 0.6 * min(leaveInclination, 1)
    expect(privates[0].leaveInclination).toBeCloseTo(0.9, 10);
    expect(expression.expressedLeaveInclination).toBeCloseTo(0.9 - 0.8 * 0.6 * 0.9, 10);

    const factor = expression.divergences[1].factors.find((f) => f.key === "impressionManagement")!;
    expect(factor.dimension).toBe("leaveInclination");
    expect(factor.rawValue).toBe(0.8);
    expect(factor.normalizedValue).toBe(0.8);
    expect(factor.contribution).toBeLessThan(0);
    expect(expression.divergent).toBe(true);
    // 緩和は本心の離脱傾向に比例するため、表明が負(0未満)へ反転することはない
    expect(expression.expressedLeaveInclination).toBeGreaterThan(0);
  });

  it("可聴範囲内に同一cliqueの相手がいなければ、existingTieStrengthが強くても緩和されない", () => {
    const agent = makeAgent({ id: "a1", cliqueId: 1, stress: 0.54, leaveThreshold: 0.6, influenceAvoidance: 0, conformity: 0 });
    const stranger = makeAgent({ id: "a2", cliqueId: 2, x: 420, y: 260 });
    const farMate = makeAgent({ id: "a3", cliqueId: 1, x: 400 + EXPRESSION_AUDIBLE_RANGE + 1, y: 260 });
    const state = makeState({ agents: [agent, stranger, farMate] });
    const params = { ...DEFAULT_PARAMS, existingTieStrength: 0.8 };

    const privates = derivePrivateEvaluations(state, params, ENABLED);
    const [expression] = derivePublicExpressions(privates, state, params, ENABLED);
    expect(expression.expressedLeaveInclination).toBe(privates[0].leaveInclination);
    const factor = expression.divergences[1].factors.find((f) => f.key === "impressionManagement")!;
    expect(factor.normalizedValue).toBe(0);
    expect(factor.contribution).toBe(0);
  });
});

describe("乖離量のclamp規則", () => {
  it("要因の合計(rawDelta)が上限を超えるとMAX_DIVERGENCE_PER_DIMENSIONで頭打ちになり、rawDeltaには合計が残る", () => {
    // 遠慮 -1*0.5 + 同調 -1*0.3 = rawDelta -0.8 → deltaは-0.5へclamp
    const agent = makeAgent({ id: "a1", willingness: 1, influenceAvoidance: 1, conformity: 1 });
    const leaver = makeAgent({ id: "a2", state: "leaving", x: 420, y: 260 });
    const state = makeState({ agents: [agent, leaver] });
    const privates = derivePrivateEvaluations(state, DEFAULT_PARAMS, ENABLED);
    const [expression] = derivePublicExpressions(privates, state, DEFAULT_PARAMS, ENABLED);

    const joinDivergence = expression.divergences[0];
    expect(joinDivergence.rawDelta).toBeCloseTo(-0.8, 10);
    expect(joinDivergence.delta).toBeCloseTo(-MAX_DIVERGENCE_PER_DIMENSION, 10);
    expect(expression.expressedJoinDesire).toBeCloseTo(1 - MAX_DIVERGENCE_PER_DIMENSION, 10);
  });

  it("expressedJoinDesireは0〜1、expressedLeaveInclinationは0以上に収まる", () => {
    const agent = makeAgent({ id: "a1", willingness: 0.55, influenceAvoidance: 0, conformity: 1 });
    const leavers = [0, 1, 2].map((i) => makeAgent({ id: `l${i}`, state: "leaving", x: 410 + 10 * i, y: 260 }));
    const state = makeState({ agents: [agent, ...leavers] });
    const privates = derivePrivateEvaluations(state, DEFAULT_PARAMS, ENABLED);
    const [expression] = derivePublicExpressions(privates, state, DEFAULT_PARAMS, ENABLED);
    expect(expression.expressedJoinDesire).toBeGreaterThanOrEqual(0);
    expect(expression.expressedJoinDesire).toBeLessThanOrEqual(1);
    expect(expression.expressedLeaveInclination).toBeGreaterThanOrEqual(0);
    // deltaは常にclamp後の実際の乖離量(expressed - private)と一致する
    expect(expression.divergences[0].delta).toBeCloseTo(expression.expressedJoinDesire - privates[0].joinDesire, 10);
  });
});

describe("observerJoinerの乖離: 本心=参加希望・対外表現=無表明", () => {
  it("参加したいが影響を与えたくないobserverJoinerは、本心positive・表現noneの乖離が判定される", () => {
    // model.tsのobserverJoiner生成値と同じ設定(willingness 0.8・observerInfluenceAvoidance既定0.9)
    const observer = makeAgent({
      id: "obs-1",
      isObserverJoiner: true,
      willingness: 0.8,
      influenceAvoidance: DEFAULT_PARAMS.observerInfluenceAvoidance,
      conformity: 0.5,
    });
    const state = makeState({ agents: [observer] });
    const privates = derivePrivateEvaluations(state, DEFAULT_PARAMS, ENABLED);
    const [expression] = derivePublicExpressions(privates, state, DEFAULT_PARAMS, ENABLED);

    expect(expression.privateStance).toBe("positive"); // 本心は参加希望
    expect(expression.expressedStance).toBe("none"); // 対外表現は無表明
    expect(expression.divergent).toBe(true);
    // 乖離の主要因が遠慮(reserve)であることが寄与から読み取れる
    const reserve = expression.divergences[0].factors.find((f) => f.key === "reserve")!;
    expect(reserve.contribution).toBeLessThan(0);
    expect(expression.expressedJoinDesire).toBeLessThan(privates[0].joinDesire);
  });

  it("createInitialStateで生成された実際のobserverJoinerでも同じ乖離が判定される", () => {
    const state = createInitialState(42, DEFAULT_PARAMS);
    const privates = derivePrivateEvaluations(state, DEFAULT_PARAMS, ENABLED);
    const publics = derivePublicExpressions(privates, state, DEFAULT_PARAMS, ENABLED);
    const observers = state.agents.filter((agent) => agent.isObserverJoiner);
    expect(observers.length).toBeGreaterThan(0);

    for (const observer of observers) {
      const expression = publics.find((e) => e.agentId === observer.id)!;
      expect(expression.privateStance).toBe("positive");
      expect(expression.expressedStance).toBe("none");
      expect(expression.divergent).toBe(true);
    }
  });

  it("personality基礎値(willingness/conformity/influenceAvoidance/leaveThreshold)は導出後も変化しない", () => {
    const state = createInitialState(42, DEFAULT_PARAMS);
    const snapshot = state.agents.map((agent) => ({
      willingness: agent.willingness,
      conformity: agent.conformity,
      influenceAvoidance: agent.influenceAvoidance,
      leaveThreshold: agent.leaveThreshold,
    }));
    const privates = derivePrivateEvaluations(state, DEFAULT_PARAMS, ENABLED);
    derivePublicExpressions(privates, state, DEFAULT_PARAMS, ENABLED);
    expect(
      state.agents.map((agent) => ({
        willingness: agent.willingness,
        conformity: agent.conformity,
        influenceAvoidance: agent.influenceAvoidance,
        leaveThreshold: agent.leaveThreshold,
      })),
    ).toEqual(snapshot);
  });
});

describe("表明スタンスのしきい値", () => {
  it("0.65以上でpositive、0.35以下でnegative、その間はnone", () => {
    expect(stanceOfJoinDesire(0.65)).toBe("positive");
    expect(stanceOfJoinDesire(0.64)).toBe("none");
    expect(stanceOfJoinDesire(0.36)).toBe("none");
    expect(stanceOfJoinDesire(0.35)).toBe("negative");
  });
});

describe("非干渉性: 導出はstateをmutationせず、本体rngを消費しない", () => {
  it("導出の前後でSimulationStateが変化しない", () => {
    const states = runSimulationStates(12345, DEFAULT_PARAMS, 30);
    const state = states[states.length - 1];
    const before = JSON.stringify(state);
    const privates = derivePrivateEvaluations(state, DEFAULT_PARAMS, ENABLED);
    derivePublicExpressions(privates, state, DEFAULT_PARAMS, ENABLED);
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
            derivePublicExpressions(privates, state, preset.params, ENABLED);
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
        return JSON.stringify({ privates, publics: derivePublicExpressions(privates, state, DEFAULT_PARAMS, ENABLED) });
      });
    };
    expect(derive()).toEqual(derive());
  });
});
