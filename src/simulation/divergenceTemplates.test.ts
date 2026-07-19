import { describe, expect, it } from "vitest";
import {
  classifyTemplateArchetype,
  resolveDivergentExpression,
} from "./divergenceTemplates";
import type { DivergenceTemplateContext } from "./divergenceTemplates";
import { classifyDivergenceScene, DIVERGENCE_SCENE_FACTOR } from "./socialExpression";
import { resolveSpeechEventText, resolveSpeechText } from "./speechTemplates";
import { createInitialState, stepSimulation } from "./engine";
import { createSpeechEvent } from "./speech";
import type { SpeechExpressionLink, SpeechEvent } from "./speech";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS, PRESETS } from "./presets";
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

function makeLink(overrides: Partial<SpeechExpressionLink>): SpeechExpressionLink {
  return {
    publicExpressionId: "public-5-agent-x",
    privateEvaluationId: "private-5-agent-x",
    divergent: true,
    privateStance: "positive",
    expressedStance: "none",
    baseIntent: "decline",
    ...overrides,
  };
}

function ctx(overrides: Partial<DivergenceTemplateContext>): DivergenceTemplateContext {
  return {
    link: makeLink({}),
    intent: "decline",
    agent: makeAgent({}),
    presetId: "natural",
    seed: 7,
    tick: 12,
    ...overrides,
  };
}

describe("classifyDivergenceScene: 乖離場面の判定", () => {
  it("非乖離(divergent: false)は常にundefined", () => {
    expect(classifyDivergenceScene(makeLink({ divergent: false }), "decline")).toBeUndefined();
  });

  it("invite→greetは遠慮(reservedSoftening)", () => {
    const scene = classifyDivergenceScene(makeLink({ baseIntent: "invite" }), "greet");
    expect(scene).toBe("reservedSoftening");
    expect(DIVERGENCE_SCENE_FACTOR[scene!]).toBe("reserve");
  });

  it("welcome + 本心negativeは同調(obligatoryWelcome)", () => {
    const scene = classifyDivergenceScene(makeLink({ baseIntent: "welcome", privateStance: "negative" }), "welcome");
    expect(scene).toBe("obligatoryWelcome");
    expect(DIVERGENCE_SCENE_FACTOR[scene!]).toBe("conformity");
  });

  it("decline + 本心positiveは社交辞令(politeDecline)", () => {
    const scene = classifyDivergenceScene(makeLink({ baseIntent: "decline", privateStance: "positive" }), "decline");
    expect(scene).toBe("politeDecline");
    expect(DIVERGENCE_SCENE_FACTOR[scene!]).toBe("impression");
  });

  it("3場面に該当しない乖離発言はundefined(呼び出し側は非乖離テンプレへフォールバック)", () => {
    // greet(baseもgreet)で乖離フラグだけ立つケース
    expect(classifyDivergenceScene(makeLink({ baseIntent: "greet", privateStance: "none" }), "greet")).toBeUndefined();
  });
});

describe("classifyTemplateArchetype", () => {
  it("observerJoiner優先、次にinitiative>=0.5でdesignatedLeader、cliqueId有でcliqueMember、他はgeneral", () => {
    expect(classifyTemplateArchetype(makeAgent({ isObserverJoiner: true, initiative: 0.9 }))).toBe("observerJoiner");
    expect(classifyTemplateArchetype(makeAgent({ initiative: 0.8 }))).toBe("designatedLeader");
    expect(classifyTemplateArchetype(makeAgent({ initiative: 0.3, cliqueId: 2 }))).toBe("cliqueMember");
    expect(classifyTemplateArchetype(makeAgent({ initiative: 0.3 }))).toBe("general");
  });
});

describe("resolveDivergentExpression: 本心/建前ペアの決定的解決", () => {
  it("非乖離場面はundefinedを返す", () => {
    expect(resolveDivergentExpression(ctx({ link: makeLink({ divergent: false }) }))).toBeUndefined();
  });

  it("社交辞令の辞退で、本心(thought)と建前(speech)が異なる文言として返る", () => {
    const resolution = resolveDivergentExpression(ctx({}))!;
    expect(resolution.scene).toBe("politeDecline");
    expect(resolution.factor).toBe("impression");
    expect(resolution.thought.length).toBeGreaterThan(0);
    expect(resolution.speech.length).toBeGreaterThan(0);
    expect(resolution.thought).not.toBe(resolution.speech); // 本心と建前の文言差が存在する
  });

  it("同一seed・同一設定なら常に同じ文言が選ばれる(再現性)", () => {
    const first = resolveDivergentExpression(ctx({}));
    const second = resolveDivergentExpression(ctx({}));
    expect(first).toEqual(second);
  });

  it("thoughtとspeechは同一variantIndexの対から取り出される", () => {
    const resolution = resolveDivergentExpression(ctx({}))!;
    expect(resolution.variantIndex).toBeGreaterThanOrEqual(0);
    // 同じインデックスから再導出しても同じ対
    const again = resolveDivergentExpression(ctx({}))!;
    expect(again.variantIndex).toBe(resolution.variantIndex);
    expect(again.thought).toBe(resolution.thought);
    expect(again.speech).toBe(resolution.speech);
  });

  it("アーキタイプが変わると語調(文言)が変わりうる(observerJoiner専用文言が選ばれる)", () => {
    const observer = makeAgent({ id: "obs", isObserverJoiner: true });
    const resolution = resolveDivergentExpression(ctx({ agent: observer }))!;
    // observerJoiner専用プールの1件("本当は行きたかったのに、言い出せなかった…")が選ばれる
    expect(resolution.archetype).toBe("observerJoiner");
    expect(resolution.thought).toContain("言い出せなかった");
  });

  it("プリセットが変わると選択が変わりうる(ambiguous-dissolve固有の建前が候補に入る)", () => {
    // observerでない一般エージェントで、プリセットごとに選ばれる文言集合が変わることを確認
    const natural = resolveDivergentExpression(ctx({ presetId: "natural" }))!;
    const dissolve = resolveDivergentExpression(ctx({ presetId: "ambiguous-dissolve" }))!;
    // 少なくとも一方の次元(scene/factorは同じでも)で文言またはindexが変わりうる。
    // ここではプリセット固有プールが存在することを、全variantを走査して確認する。
    const seenTexts = new Set<string>();
    for (let tick = 0; tick < 40; tick++) {
      const r = resolveDivergentExpression(ctx({ presetId: "ambiguous-dissolve", tick }));
      if (r) seenTexts.add(r.speech);
    }
    expect(seenTexts.has("うーん、今日はもう解散かな。おつかれさま")).toBe(true);
    // 型・場面は保たれる
    expect(natural.scene).toBe("politeDecline");
    expect(dissolve.scene).toBe("politeDecline");
  });

  it("純粋: agentを変更しない", () => {
    const agent = makeAgent({});
    const snapshot = JSON.stringify(agent);
    resolveDivergentExpression(ctx({ agent }));
    expect(JSON.stringify(agent)).toBe(snapshot);
  });

  it("全乖離場面 × 全プリセット × 全アーキタイプで有効な対が解決される", () => {
    const scenes: Array<{ link: Partial<SpeechExpressionLink>; intent: SpeechEvent["intent"] }> = [
      { link: { baseIntent: "invite", privateStance: "positive", expressedStance: "none" }, intent: "greet" },
      { link: { baseIntent: "welcome", privateStance: "negative", expressedStance: "none" }, intent: "welcome" },
      { link: { baseIntent: "decline", privateStance: "positive", expressedStance: "none" }, intent: "decline" },
    ];
    const archetypes = [
      makeAgent({ id: "a", isObserverJoiner: true }),
      makeAgent({ id: "b", initiative: 0.8 }),
      makeAgent({ id: "c", initiative: 0.3, cliqueId: 1 }),
      makeAgent({ id: "d", initiative: 0.3 }),
    ];
    for (const preset of PRESETS) {
      for (const s of scenes) {
        for (const agent of archetypes) {
          const r = resolveDivergentExpression(ctx({ link: makeLink(s.link), intent: s.intent, agent, presetId: preset.id }));
          expect(r).toBeDefined();
          expect(r!.thought.length).toBeGreaterThan(0);
          expect(r!.speech.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("学校シナリオでは本心と建前の対を保ったまま学校語彙へ解決する", () => {
    const forbidden = ["二次会", "もう一軒", "店", "会場", "帰宅", "途中参加"];
    const school = resolveDivergentExpression(
      ctx({
        scenarioId: "classroomPair",
        presetId: "classroom-pair",
        agent: makeAgent({ id: "school-observer", isObserverJoiner: true }),
      }),
    )!;

    expect(school.thought).not.toBe(school.speech);
    expect(school.thought).toContain("一緒に組みたい");
    for (const term of forbidden) {
      expect(school.thought).not.toContain(term);
      expect(school.speech).not.toContain(term);
    }
  });
});

describe("resolveSpeechEventText: 乖離場面での建前文言の解決(後方互換)", () => {
  const divergentDecline = (): SpeechEvent => ({
    ...createSpeechEvent({
      tick: 12,
      speakerId: "agent-x",
      intent: "decline",
      reason: "leaveDeclaration",
      audience: "nearby",
      originX: 100,
      originY: 100,
    }),
    expression: makeLink({}),
  });

  it("コンテキストなしでは従来どおりreasonごとの1文言を返す(既存挙動)", () => {
    const event = divergentDecline();
    expect(resolveSpeechEventText(event)).toBe(resolveSpeechText("leaveDeclaration"));
  });

  it("コンテキストありかつ乖離発言なら乖離専用の建前文言を返す", () => {
    const event = divergentDecline();
    // observerJoiner専用プールは建前が基底テンプレと異なるため、コンテキスト経路の効果が明示される
    const agent = makeAgent({ id: "agent-x", isObserverJoiner: true });
    const text = resolveSpeechEventText(event, { agent, presetId: "natural", seed: 7 });
    const resolution = resolveDivergentExpression({
      link: event.expression!,
      intent: event.intent,
      agent,
      presetId: "natural",
      seed: 7,
      tick: event.tick,
    })!;
    expect(text).toBe(resolution.speech);
    expect(text).not.toBe(resolveSpeechText("leaveDeclaration"));
  });

  it("非乖離発言(expressionなし)はコンテキストがあっても従来文言を返す", () => {
    const event = createSpeechEvent({
      tick: 3,
      speakerId: "agent-x",
      intent: "invite",
      reason: "initiativeFormedCore",
      audience: "nearby",
    });
    const text = resolveSpeechEventText(event, { agent: makeAgent({ id: "agent-x" }), presetId: "natural", seed: 7 });
    expect(text).toBe(resolveSpeechText("initiativeFormedCore"));
  });

  it("話者IDが一致しないコンテキストは無視して従来文言を返す(防御的)", () => {
    const event = divergentDecline();
    const text = resolveSpeechEventText(event, { agent: makeAgent({ id: "someone-else" }), presetId: "natural", seed: 7 });
    expect(text).toBe(resolveSpeechText("leaveDeclaration"));
  });
});

describe("非干渉: テンプレート解決はシミュレーション状態系列・PRNG消費を変えない", () => {
  const run = (resolveTexts: boolean) => {
    const seed = 7;
    const rng = new SeededRandom(seed);
    let state = createInitialState(seed, DEFAULT_PARAMS, undefined, { enabled: true }, { enabled: true });
    const core = (s: SimulationState) =>
      JSON.stringify({ tick: s.tick, agents: s.agents, groupCandidates: s.groupCandidates, log: s.log, finished: s.finished, speechLog: s.speechLog });
    const serialized: string[] = [core(state)];
    let ticks = 0;
    while (!state.finished && ticks < 400) {
      state = stepSimulation(state, DEFAULT_PARAMS, rng, undefined, { enabled: true }, { enabled: true });
      // 表示層(テンプレート解決)を毎tick挟んでも、以降の状態遷移・PRNG消費に影響しないことを確認する
      if (resolveTexts) {
        const agentById = new Map(state.agents.map((a) => [a.id, a]));
        for (const event of state.speechLog ?? []) {
          const agent = agentById.get(event.speakerId);
          if (agent) resolveSpeechEventText(event, { agent, presetId: "natural", seed });
        }
      }
      serialized.push(core(state));
      ticks += 1;
    }
    return { serialized, rngProbe: rng.next() };
  };

  it("テンプレート解決の有無で状態系列・PRNG消費が完全一致する", () => {
    const without = run(false);
    const withResolve = run(true);
    expect(withResolve.serialized).toEqual(without.serialized);
    expect(withResolve.rngProbe).toBe(without.rngProbe);
  });
});
