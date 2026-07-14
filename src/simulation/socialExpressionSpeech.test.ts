import { describe, expect, it } from "vitest";
import {
  applyPublicExpressionsToSpeech,
  derivePrivateEvaluations,
  derivePublicExpressions,
  resolveSocialExpressionConfig,
  selectExpressedIntent,
} from "./socialExpression";
import type { PublicExpression } from "./socialExpression";
import { createInitialState, stepSimulation } from "./engine";
import { createSpeechEvent } from "./speech";
import type { SpeechEvent } from "./speech";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS, PRESETS } from "./presets";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./model";
import type { Agent, SimulationState } from "./types";

const ENABLED = resolveSocialExpressionConfig({ enabled: true });
const DISABLED = resolveSocialExpressionConfig();

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

/** `state`内の指定agentの対外表現を導出するテストヘルパー(engineと同じ導出経路) */
function expressionFor(state: SimulationState, agentId: string): PublicExpression {
  const privates = derivePrivateEvaluations(state, DEFAULT_PARAMS, ENABLED);
  const expression = derivePublicExpressions(privates, state, DEFAULT_PARAMS, ENABLED).find(
    (e) => e.agentId === agentId,
  );
  if (!expression) throw new Error(`expression not found for ${agentId}`);
  return expression;
}

describe("selectExpressedIntent: 基礎intentと表現スタンスの固定置換表", () => {
  it("inviteはpositiveで維持、noneでgreetへ軟化、negativeで抑制される", () => {
    expect(selectExpressedIntent("invite", "positive")).toBe("invite");
    expect(selectExpressedIntent("invite", "none")).toBe("greet");
    expect(selectExpressedIntent("invite", "negative")).toBeUndefined();
  });

  it("welcomeはnegativeでのみ抑制される(none=建前の歓迎は維持)", () => {
    expect(selectExpressedIntent("welcome", "positive")).toBe("welcome");
    expect(selectExpressedIntent("welcome", "none")).toBe("welcome");
    expect(selectExpressedIntent("welcome", "negative")).toBeUndefined();
  });

  it("greet/declineはスタンスによらず不変", () => {
    for (const stance of ["positive", "none", "negative"] as const) {
      expect(selectExpressedIntent("greet", stance)).toBe("greet");
      expect(selectExpressedIntent("decline", stance)).toBe("decline");
    }
  });
});

describe("applyPublicExpressionsToSpeech: 乖離調整の適用規則", () => {
  it("config無効時(デフォルト)は入力配列をそのまま返し、expressionフィールドも付与しない", () => {
    const speaker = makeAgent({ id: "s1", willingness: 0.9, influenceAvoidance: 0.9 });
    const state = makeState({ agents: [speaker] });
    const events = [
      createSpeechEvent({ tick: 5, speakerId: "s1", intent: "invite", reason: "initiativeFormedCore", audience: "nearby" }),
    ];
    const result = applyPublicExpressionsToSpeech(events, [], DISABLED);
    expect(result).toBe(events);
    expect(result[0].expression).toBeUndefined();
    expect(expressionFor(state, "s1").expressedStance).toBe("none"); // 有効なら調整対象になる入力であることの前提確認
  });

  it("遠慮により無表明になった話者のinviteはgreetへ軟化され、乖離スナップショットが付与される", () => {
    // willingness 0.9・influenceAvoidance 1 → expressed 0.9 - 0.4 = 0.5 → stance "none"
    const speaker = makeAgent({ id: "s1", willingness: 0.9, influenceAvoidance: 1, conformity: 0 });
    const state = makeState({ agents: [speaker] });
    const expression = expressionFor(state, "s1");
    expect(expression.privateStance).toBe("positive");
    expect(expression.expressedStance).toBe("none");

    const event = createSpeechEvent({
      tick: 5,
      speakerId: "s1",
      intent: "invite",
      reason: "initiativeFormedCore",
      audience: "nearby",
      originX: 400,
      originY: 260,
    });
    const [adjusted] = applyPublicExpressionsToSpeech([event], [expression], ENABLED);

    expect(adjusted.intent).toBe("greet");
    expect(adjusted.id).toBe(event.id); // idは基礎生成時のまま(二重生成なしの検証をid一意性のまま行える)
    expect(adjusted.expression).toEqual({
      publicExpressionId: expression.id,
      privateEvaluationId: expression.privateEvaluationId,
      divergent: true,
      privateStance: "positive",
      expressedStance: "none",
      baseIntent: "invite",
    });
  });

  it("表現が消極的(negative)な話者のinvite/welcomeは抑制され、SpeechEventが生成されない", () => {
    // willingness 0.2(本心も消極的)・乖離要因なし → expressed 0.2 → stance "negative"
    const speaker = makeAgent({ id: "s1", willingness: 0.2, influenceAvoidance: 0, conformity: 0 });
    const state = makeState({ agents: [speaker] });
    const expression = expressionFor(state, "s1");
    expect(expression.expressedStance).toBe("negative");

    const events = [
      createSpeechEvent({ tick: 5, speakerId: "s1", intent: "invite", reason: "formingGroupRecruitment", audience: "nearby", idSuffix: "a" }),
      createSpeechEvent({ tick: 5, speakerId: "s1", intent: "welcome", reason: "approachWelcome", target: "a2" }),
    ];
    expect(applyPublicExpressionsToSpeech(events, [expression], ENABLED)).toEqual([]);
  });

  it("建前の歓迎: 本心が消極的でも印象管理・同調で表現がnegativeでなければwelcomeが維持され、乖離として追跡できる", () => {
    // 本心negative(willingness 0.3)だが、周囲が参加ムード一色 → 同調圧力で表現が0.6(none)へ寄る
    const speaker = makeAgent({ id: "s1", willingness: 0.3, influenceAvoidance: 0, conformity: 1, state: "joined" });
    const joinedNeighbors = [0, 1].map((i) => makeAgent({ id: `j${i}`, state: "joined", x: 410 + 10 * i, y: 260 }));
    const state = makeState({ agents: [speaker, ...joinedNeighbors] });
    const expression = expressionFor(state, "s1");
    expect(expression.privateStance).toBe("negative");
    expect(expression.expressedStance).toBe("none");

    const event = createSpeechEvent({ tick: 5, speakerId: "s1", intent: "welcome", reason: "approachWelcome", target: "a2" });
    const [adjusted] = applyPublicExpressionsToSpeech([event], [expression], ENABLED);
    expect(adjusted.intent).toBe("welcome");
    expect(adjusted.expression?.divergent).toBe(true);
    expect(adjusted.expression?.privateStance).toBe("negative");
    expect(adjusted.expression?.baseIntent).toBe("welcome");
  });

  it("社交辞令の辞退: 本心が参加希望のままのdeclineはintentを維持し、乖離スナップショットでずれを追跡できる", () => {
    const speaker = makeAgent({ id: "s1", willingness: 0.8, influenceAvoidance: 0.9, conformity: 0, state: "leaving" });
    const state = makeState({ agents: [speaker] });
    const expression = expressionFor(state, "s1");
    expect(expression.privateStance).toBe("positive");

    const event = createSpeechEvent({ tick: 5, speakerId: "s1", intent: "decline", reason: "leaveDeclaration", audience: "nearby" });
    const [adjusted] = applyPublicExpressionsToSpeech([event], [expression], ENABLED);
    expect(adjusted.intent).toBe("decline");
    expect(adjusted.expression?.divergent).toBe(true);
    expect(adjusted.expression?.privateStance).toBe("positive");
    expect(adjusted.expression?.expressedStance).toBe("none");
  });

  it("lightObserverInvitation(介入由来)は話者の表現によらず調整対象外としてそのまま通る", () => {
    const speaker = makeAgent({ id: "s1", willingness: 0.2, influenceAvoidance: 0, conformity: 0 });
    const state = makeState({ agents: [speaker] });
    const expression = expressionFor(state, "s1");
    expect(expression.expressedStance).toBe("negative"); // inviteなら本来は抑制されるスタンス

    const event = createSpeechEvent({ tick: 5, speakerId: "s1", intent: "invite", reason: "lightObserverInvitation", target: "obs" });
    const [adjusted] = applyPublicExpressionsToSpeech([event], [expression], ENABLED);
    expect(adjusted).toBe(event);
    expect(adjusted.intent).toBe("invite");
    expect(adjusted.expression).toBeUndefined();
  });

  it("話者のPublicExpressionが見つからない発言(防御的ケース)は調整せずそのまま通る", () => {
    const event = createSpeechEvent({ tick: 5, speakerId: "unknown", intent: "invite", reason: "initiativeFormedCore", audience: "nearby" });
    const [adjusted] = applyPublicExpressionsToSpeech([event], [], ENABLED);
    expect(adjusted).toBe(event);
  });
});

describe("engine統合: stepSimulationでの乖離反映発言", () => {
  it("observerJoinerの離脱時、本心=参加希望のままのdecline(社交辞令の辞退)がspeechLogに記録される", () => {
    // stressが既にしきい値超え → このtickで確定的にleavingへ遷移し、leaveDeclarationが導出される
    const observer = makeAgent({
      id: "obs-1",
      isObserverJoiner: true,
      willingness: 0.8,
      influenceAvoidance: DEFAULT_PARAMS.observerInfluenceAvoidance,
      conformity: 0,
      stress: 0.99,
      leaveThreshold: 0.5,
    });
    const state = makeState({ tick: 10, agents: [observer] });
    const rng = new SeededRandom(1);
    const next = stepSimulation(state, DEFAULT_PARAMS, rng, undefined, undefined, { enabled: true });

    const decline = next.speechLog?.find((e) => e.reason === "leaveDeclaration" && e.speakerId === "obs-1");
    expect(decline).toBeDefined();
    expect(decline?.intent).toBe("decline");
    expect(decline?.expression).toBeDefined();
    expect(decline?.expression?.divergent).toBe(true);
    expect(decline?.expression?.privateStance).toBe("positive"); // 本心は参加希望のまま
    expect(decline?.expression?.expressedStance).toBe("none");
    expect(decline?.expression?.baseIntent).toBe("decline");
    // 発話時点(このtick)の対外表現へ決定的なidでリンクされる
    expect(decline?.expression?.publicExpressionId).toBe(`public-${next.tick}-obs-1`);
    expect(decline?.expression?.privateEvaluationId).toBe(`private-${next.tick}-obs-1`);
    // personality基礎値は変更されない
    const nextObserver = next.agents.find((a) => a.id === "obs-1")!;
    expect(nextObserver.willingness).toBe(0.8);
    expect(nextObserver.state).toBe("leaving");
  });

  it("socialExpressionEnabledはstateへ引き継がれ、以後のtickで未指定でも維持される", () => {
    const initial = createInitialState(1, DEFAULT_PARAMS, undefined, undefined, { enabled: true });
    expect(initial.socialExpressionEnabled).toBe(true);
    const rng = new SeededRandom(1);
    const next = stepSimulation(initial, DEFAULT_PARAMS, rng);
    expect(next.socialExpressionEnabled).toBe(true);

    const defaultInitial = createInitialState(1, DEFAULT_PARAMS);
    expect(defaultInitial.socialExpressionEnabled).toBe(false);
  });
});

describe("rng消費と後方互換: 乖離反映発言はPRNG消費列を変えない", () => {
  type RunResult = { serialized: string[]; rngProbe: number; speechLog: SpeechEvent[] };

  const run = (presetParams: typeof DEFAULT_PARAMS, socialExpressionOn: boolean, maxTicks = 400): RunResult => {
    const seed = 7;
    const rng = new SeededRandom(seed);
    const config = { enabled: socialExpressionOn };
    let state = createInitialState(seed, presetParams, undefined, undefined, config);
    // speechLog等の発言記録・設定フラグを除いた、状態遷移の本体部分のみを比較対象にする
    const core = (s: SimulationState) =>
      JSON.stringify({ tick: s.tick, agents: s.agents, groupCandidates: s.groupCandidates, log: s.log, finished: s.finished });
    const serialized: string[] = [core(state)];
    let ticks = 0;
    while (!state.finished && ticks < maxTicks) {
      state = stepSimulation(state, presetParams, rng, undefined, undefined, config);
      serialized.push(core(state));
      ticks += 1;
    }
    return { serialized, rngProbe: rng.next(), speechLog: state.speechLog ?? [] };
  };

  for (const preset of PRESETS) {
    it(`preset="${preset.id}": speechEffects無効下ではON/OFFで状態系列・PRNG消費が完全一致する(変わるのはspeechLogのみ)`, () => {
      const off = run(preset.params, false);
      const on = run(preset.params, true);
      expect(on.serialized).toEqual(off.serialized);
      expect(on.rngProbe).toBe(off.rngProbe);
      // OFF時は従来どおり乖離リンクを持たない
      expect(off.speechLog.every((e) => e.expression === undefined)).toBe(true);
      // ON時は(調整対象外の介入発言を除き)全発言が発話時点の対外表現へリンクされる
      expect(on.speechLog.every((e) => e.expression !== undefined || e.reason === "lightObserverInvitation")).toBe(true);
    });
  }

  it("同一seed・同一設定ならON時のspeechLog(乖離調整後)が完全に再現される", () => {
    const first = run(DEFAULT_PARAMS, true);
    const second = run(DEFAULT_PARAMS, true);
    expect(JSON.stringify(first.speechLog)).toBe(JSON.stringify(second.speechLog));
  });

  it("ON時もspeechLogのSpeechEvent idは全件一意(同一イベントの二重生成が発生しない)", () => {
    for (const preset of PRESETS) {
      const { speechLog } = run(preset.params, true);
      const ids = speechLog.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
