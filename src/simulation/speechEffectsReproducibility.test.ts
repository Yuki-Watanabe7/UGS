import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { PRESETS, DEFAULT_PARAMS } from "./presets";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./model";
import { buildObserverJoinerInspection } from "./inspection";
import { advanceActiveSpeechEffects, sumActiveEffectValue } from "./speechEffects";
import type { SpeechEffectsConfig } from "./speechEffects";
import type { Agent, SimParams, SimulationState } from "./types";
import type { InterventionRuntimeOptions, InterventionScenarioId } from "./interventions";

// Math.random等の非決定的APIに依存していないことを静的に検証するための生ソース一式
// (`expressionReproducibility.test.ts`/`speechBubbleSourceScan.test.ts`と同じ方針)。
// この2ファイルがまだスキャンしていない、Phase 3の因果チェーン本体を構成するファイルを対象にする。
import engineSource from "./engine.ts?raw";
import modelSource from "./model.ts?raw";
import randomSource from "./random.ts?raw";
import presetsSource from "./presets.ts?raw";
import interventionsSource from "./interventions.ts?raw";
import speechSource from "./speech.ts?raw";
import speechEffectsSource from "./speechEffects.ts?raw";
import speechTemplatesSource from "./speechTemplates.ts?raw";
import monteCarloSource from "./monteCarlo.ts?raw";
import speechEffectsMonteCarloSource from "./speechEffectsMonteCarlo.ts?raw";
import inspectionSource from "./inspection.ts?raw";
import summarySource from "./summary.ts?raw";
import timeSource from "./time.ts?raw";

/**
 * Issue #100: Phase 3(発言介入)の再現性・従来互換・因果追跡を保証する受入回帰テスト。
 *
 * 個別のユニットテスト(`speechEffects.test.ts`等)や単一preset/seedの結線契約テスト
 * (`speechEffectsWiring.test.ts`)を土台に、ここでは複数preset×seed×interventionを横断して、
 * 「従来互換・境界」「再現性」「因果整合性」「数値安全性」の4カテゴリをまとめて検証する。
 * 個別ルールの単体テストは対応するテストファイルが引き続き担う。
 */

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

function runToCompletion(
  seed: number,
  params: SimParams,
  speechEffects?: Partial<SpeechEffectsConfig>,
  intervention?: InterventionRuntimeOptions,
): SimulationState {
  const rng = new SeededRandom(seed);
  let state = createInitialState(seed, params, intervention, speechEffects);
  let ticks = 0;
  while (!state.finished && ticks < 400) {
    state = stepSimulation(state, params, rng, intervention, speechEffects);
    ticks += 1;
  }
  return state;
}

function runCollectingStates(
  seed: number,
  params: SimParams,
  speechEffects?: Partial<SpeechEffectsConfig>,
  intervention?: InterventionRuntimeOptions,
): SimulationState[] {
  const rng = new SeededRandom(seed);
  let state = createInitialState(seed, params, intervention, speechEffects);
  const states: SimulationState[] = [state];
  let ticks = 0;
  while (!state.finished && ticks < 400) {
    state = stepSimulation(state, params, rng, intervention, speechEffects);
    states.push(state);
    ticks += 1;
  }
  return states;
}

const REPRESENTATIVE_SEEDS = [1, 2024];
const REPRESENTATIVE_INTERVENTIONS: InterventionScenarioId[] = ["none", "light-observer-invitation"];

describe("Phase 3 受入回帰テスト: 従来互換・境界", () => {
  it("SpeechEventが0件のまま推移するtickでは、Phase3有効/無効でagents/groupCandidates/log/rng消費が完全一致する", () => {
    // 核形成・接近・離脱のいずれの条件も満たさない(=SpeechEventが一切生成されない)ように
    // 意図的に組んだ2人だけの孤立シナリオ: 主導性0.1未満(核を作れない)・cliqueId無し(既存グループにも
    // 頼れない)・ambiguityTolerance=1(stress増分が常に0で離脱しない)・接近対象の候補も存在しない。
    const buildIsolatedState = (): SimulationState => ({
      tick: 0,
      agents: [
        makeAgent({ id: "a", x: 40, y: 40, initiative: 0.1, ambiguityTolerance: 1, leaveThreshold: 1 }),
        makeAgent({
          id: "b",
          x: WORLD_WIDTH - 40,
          y: WORLD_HEIGHT - 40,
          initiative: 0.1,
          ambiguityTolerance: 1,
          leaveThreshold: 1,
        }),
      ],
      groupCandidates: [],
      log: [],
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT,
      finished: false,
      interventionId: "none",
      speechLog: [],
      speechReceptionLog: [],
      speechInterpretationLog: [],
      speechEffectLog: [],
      speechEffectsEnabled: false,
      activeSpeechEffects: [],
    });

    const seed = 4242;
    const rngDisabled = new SeededRandom(seed);
    const rngEnabled = new SeededRandom(seed);
    let disabled = buildIsolatedState();
    let enabled = buildIsolatedState();

    for (let tick = 0; tick < 20; tick++) {
      disabled = stepSimulation(disabled, DEFAULT_PARAMS, rngDisabled, undefined, { enabled: false });
      enabled = stepSimulation(enabled, DEFAULT_PARAMS, rngEnabled, undefined, { enabled: true });

      expect(disabled.speechLog, `tick ${tick}`).toEqual([]);
      expect(enabled.speechLog, `tick ${tick}`).toEqual([]);
      expect(enabled.agents, `tick ${tick}`).toEqual(disabled.agents);
      expect(enabled.groupCandidates, `tick ${tick}`).toEqual(disabled.groupCandidates);
      expect(enabled.log, `tick ${tick}`).toEqual(disabled.log);
    }

    // 本体PRNGの消費回数がPhase3有効/無効で変わっていないことを、追加の1回で確認する
    expect(rngEnabled.next()).toBe(rngDisabled.next());
  });

  it("発言効果OFF: 全preset×代表seedで「未指定」と「明示的にfalse」がagents/groupCandidates/log/speechLogについて完全一致する(従来互換)", () => {
    for (const preset of PRESETS) {
      for (const seed of REPRESENTATIVE_SEEDS) {
        const label = `preset=${preset.id} seed=${seed}`;
        const withoutPhase3 = runToCompletion(seed, preset.params, undefined);
        const explicitlyDisabled = runToCompletion(seed, preset.params, { enabled: false });

        expect(explicitlyDisabled.agents, label).toEqual(withoutPhase3.agents);
        expect(explicitlyDisabled.groupCandidates, label).toEqual(withoutPhase3.groupCandidates);
        expect(explicitlyDisabled.log, label).toEqual(withoutPhase3.log);
        expect(explicitlyDisabled.speechLog, label).toEqual(withoutPhase3.speechLog);
        expect(explicitlyDisabled.speechReceptionLog ?? [], label).toEqual([]);
        expect(explicitlyDisabled.speechInterpretationLog ?? [], label).toEqual([]);
        expect(explicitlyDisabled.speechEffectLog ?? [], label).toEqual([]);
      }
    }
  });

  it("Phase3フィールドを持たない旧形式stateでも、stepSimulation/buildObserverJoinerInspectionが例外なく安全に動作する", () => {
    const preset = PRESETS[0];
    const modern = createInitialState(1, preset.params, undefined, { enabled: true });
    // 「未指定(undefined)」ではなく、キー自体が存在しない旧形式のstateオブジェクトを再現する
    const legacy = { ...modern } as SimulationState;
    for (const key of [
      "speechReceptionLog",
      "speechInterpretationLog",
      "speechEffectLog",
      "speechEffectsEnabled",
      "activeSpeechEffects",
    ] as const) {
      delete (legacy as Record<string, unknown>)[key];
    }

    const rng = new SeededRandom(1);
    const next = stepSimulation(legacy, preset.params, rng, undefined, { enabled: true });
    expect(next.speechReceptionLog).toBeDefined();
    expect(next.speechInterpretationLog).toBeDefined();
    expect(next.speechEffectLog).toBeDefined();
    expect(next.activeSpeechEffects).toBeDefined();

    const inspections = buildObserverJoinerInspection(legacy, preset.params);
    for (const inspection of inspections) {
      expect(inspection.activeEffectSummaries).toEqual([]);
      for (const detail of inspection.speechEffectDetails) {
        expect(detail.reception).toBeUndefined();
        expect(detail.interpretation).toBeUndefined();
        expect(detail.effect).toBeUndefined();
        expect(detail.activeEffectStatus).toBeUndefined();
      }
    }
  });

  it("Inspector(buildObserverJoinerInspection)を毎tick呼んでも、シミュレーション本体・rng消費は変わらない", () => {
    const preset = PRESETS[0];
    const seed = 777;

    function run(withInspection: boolean): { finalState: SimulationState; rngProbe: number } {
      const rng = new SeededRandom(seed);
      let state = createInitialState(seed, preset.params, undefined, { enabled: true });
      let ticks = 0;
      while (!state.finished && ticks < 400) {
        state = stepSimulation(state, preset.params, rng, undefined, { enabled: true });
        if (withInspection) {
          buildObserverJoinerInspection(state, preset.params);
        }
        ticks += 1;
      }
      return { finalState: state, rngProbe: rng.next() };
    }

    const withoutInspection = run(false);
    const withInspection = run(true);

    expect(withInspection.finalState).toEqual(withoutInspection.finalState);
    expect(withInspection.rngProbe).toBe(withoutInspection.rngProbe);
  });
});

describe("Phase 3 受入回帰テスト: 再現性", () => {
  it("全preset×代表seed×代表interventionで、Phase3ログ一式・activeSpeechEffects・最終結果が2回の独立実行(Reset相当)で完全一致する", () => {
    for (const preset of PRESETS) {
      for (const seed of REPRESENTATIVE_SEEDS) {
        for (const interventionId of REPRESENTATIVE_INTERVENTIONS) {
          const intervention: InterventionRuntimeOptions = { interventionId };
          const label = `preset=${preset.id} seed=${seed} intervention=${interventionId}`;
          const first = runToCompletion(seed, preset.params, { enabled: true }, intervention);
          const second = runToCompletion(seed, preset.params, { enabled: true }, intervention);

          expect(second.agents, label).toEqual(first.agents);
          expect(second.groupCandidates, label).toEqual(first.groupCandidates);
          expect(second.log, label).toEqual(first.log);
          expect(second.speechLog, label).toEqual(first.speechLog);
          expect(second.speechReceptionLog, label).toEqual(first.speechReceptionLog);
          expect(second.speechInterpretationLog, label).toEqual(first.speechInterpretationLog);
          expect(second.speechEffectLog, label).toEqual(first.speechEffectLog);
          expect(second.activeSpeechEffects, label).toEqual(first.activeSpeechEffects);
        }
      }
    }
  });

  it("状態系列(tickごとのagents/activeSpeechEffects)も、代表preset×interventionで2回の独立実行で完全一致する", () => {
    const seed = 2024;
    for (const preset of [PRESETS[0], PRESETS[4]]) {
      for (const interventionId of REPRESENTATIVE_INTERVENTIONS) {
        const intervention: InterventionRuntimeOptions = { interventionId };
        const label = `preset=${preset.id} intervention=${interventionId}`;
        const firstStates = runCollectingStates(seed, preset.params, { enabled: true }, intervention);
        const secondStates = runCollectingStates(seed, preset.params, { enabled: true }, intervention);

        expect(secondStates.length, label).toBe(firstStates.length);
        expect(secondStates, label).toEqual(firstStates);
      }
    }
  });

  it("同一tick内に複数のSpeechEventが発生した場合でも、id・順序が2回の実行で安定する(グループ成立時の一斉joinGreetingで発生しうる)", () => {
    let sawMultiSpeechTick = false;

    for (const preset of PRESETS) {
      for (const seed of REPRESENTATIVE_SEEDS) {
        const label = `preset=${preset.id} seed=${seed}`;
        const first = runCollectingStates(seed, preset.params, { enabled: true });
        const second = runCollectingStates(seed, preset.params, { enabled: true });
        expect(second.length, label).toBe(first.length);

        for (let i = 1; i < first.length; i++) {
          const firstPrevCount = (first[i - 1].speechLog ?? []).length;
          const secondPrevCount = (second[i - 1].speechLog ?? []).length;
          const firstNewEvents = (first[i].speechLog ?? []).slice(firstPrevCount);
          const secondNewEvents = (second[i].speechLog ?? []).slice(secondPrevCount);
          expect(secondNewEvents, `${label} tick ${i}`).toEqual(firstNewEvents);
          if (firstNewEvents.length >= 2) sawMultiSpeechTick = true;

          const firstPrevReceptions = (first[i - 1].speechReceptionLog ?? []).length;
          const secondPrevReceptions = (second[i - 1].speechReceptionLog ?? []).length;
          const firstNewReceptions = (first[i].speechReceptionLog ?? []).slice(firstPrevReceptions);
          const secondNewReceptions = (second[i].speechReceptionLog ?? []).slice(secondPrevReceptions);
          expect(secondNewReceptions, `${label} tick ${i}`).toEqual(firstNewReceptions);
        }
      }
    }

    expect(sawMultiSpeechTick, "同一tickに複数SpeechEventが発生するケースが一度も観測されなかった").toBe(true);
  });

  const CAUSAL_CHAIN_SOURCES: [string, string][] = [
    ["simulation/engine.ts", engineSource],
    ["simulation/model.ts", modelSource],
    ["simulation/random.ts", randomSource],
    ["simulation/presets.ts", presetsSource],
    ["simulation/interventions.ts", interventionsSource],
    ["simulation/speech.ts", speechSource],
    ["simulation/speechEffects.ts", speechEffectsSource],
    ["simulation/speechTemplates.ts", speechTemplatesSource],
    ["simulation/monteCarlo.ts", monteCarloSource],
    ["simulation/speechEffectsMonteCarlo.ts", speechEffectsMonteCarloSource],
    ["simulation/inspection.ts", inspectionSource],
    ["simulation/summary.ts", summarySource],
    ["simulation/time.ts", timeSource],
  ];

  const FORBIDDEN: [RegExp, string][] = [
    [/Math\.random\s*\(/, "Math.random()"],
    [/crypto\.getRandomValues/, "crypto.getRandomValues"],
    [/new Date\s*\(/, "new Date()"],
    [/Date\.now\s*\(/, "Date.now()"],
    [/performance\.now\s*\(/, "performance.now()"],
  ];

  it.each(CAUSAL_CHAIN_SOURCES)(
    "%sはMath.random/crypto.getRandomValues/new Date()/Date.now()/performance.now()に依存していない",
    (_name, source) => {
      const offenders = FORBIDDEN.filter(([pattern]) => pattern.test(source)).map(([, label]) => label);
      expect(offenders).toEqual([]);
    },
  );
});

describe("Phase 3 受入回帰テスト: 因果整合性", () => {
  it("全preset×代表seedで、reception/interpretation/effect/activeSpeechEffectsの全参照がdanglingしない", () => {
    for (const preset of PRESETS) {
      for (const seed of REPRESENTATIVE_SEEDS) {
        const finalState = runToCompletion(seed, preset.params, { enabled: true });
        const label = `preset=${preset.id} seed=${seed}`;

        const knownAgentIds = new Set(finalState.agents.map((a) => a.id));
        const knownSpeechIds = new Set((finalState.speechLog ?? []).map((s) => s.id));
        const knownReceptionIds = new Set((finalState.speechReceptionLog ?? []).map((r) => r.id));
        const knownInterpretationIds = new Set((finalState.speechInterpretationLog ?? []).map((i) => i.id));
        const knownEffectIds = new Set((finalState.speechEffectLog ?? []).map((e) => e.id));

        for (const reception of finalState.speechReceptionLog ?? []) {
          expect(knownSpeechIds.has(reception.speechEventId), `${label} reception ${reception.id}`).toBe(true);
          expect(knownAgentIds.has(reception.receiverId), `${label} reception ${reception.id}`).toBe(true);
        }
        for (const interpretation of finalState.speechInterpretationLog ?? []) {
          expect(knownSpeechIds.has(interpretation.speechEventId), `${label} interpretation ${interpretation.id}`).toBe(
            true,
          );
          expect(
            knownReceptionIds.has(interpretation.receptionEventId),
            `${label} interpretation ${interpretation.id}`,
          ).toBe(true);
          expect(knownAgentIds.has(interpretation.receiverId), `${label} interpretation ${interpretation.id}`).toBe(
            true,
          );

          const reception = (finalState.speechReceptionLog ?? []).find(
            (r) => r.id === interpretation.receptionEventId,
          );
          expect(
            reception?.heard,
            `${label} interpretation ${interpretation.id} は聞こえなかった(heard: false)receptionから生成されている`,
          ).toBe(true);
        }
        for (const effect of finalState.speechEffectLog ?? []) {
          expect(knownSpeechIds.has(effect.speechEventId), `${label} effect ${effect.id}`).toBe(true);
          expect(knownInterpretationIds.has(effect.interpretationEventId), `${label} effect ${effect.id}`).toBe(true);
          expect(knownAgentIds.has(effect.receiverId), `${label} effect ${effect.id}`).toBe(true);
          expect(knownAgentIds.has(effect.speakerId), `${label} effect ${effect.id}`).toBe(true);
        }
        for (const active of finalState.activeSpeechEffects ?? []) {
          expect(knownEffectIds.has(active.speechEffectEventId), `${label} activeEffect ${active.id}`).toBe(true);
          expect(knownSpeechIds.has(active.speechEventId), `${label} activeEffect ${active.id}`).toBe(true);
          expect(knownAgentIds.has(active.receiverId), `${label} activeEffect ${active.id}`).toBe(true);
        }
      }
    }
  });

  it("valence===\"neutral\"の解釈からはeffectが生成されない(全preset×代表seed)", () => {
    for (const preset of PRESETS) {
      for (const seed of REPRESENTATIVE_SEEDS) {
        const finalState = runToCompletion(seed, preset.params, { enabled: true });
        const neutralInterpretationIds = new Set(
          (finalState.speechInterpretationLog ?? [])
            .filter((interp) => interp.valence === "neutral")
            .map((interp) => interp.id),
        );
        for (const effect of finalState.speechEffectLog ?? []) {
          expect(
            neutralInterpretationIds.has(effect.interpretationEventId),
            `preset=${preset.id} seed=${seed} effect ${effect.id}`,
          ).toBe(false);
        }
      }
    }
  });

  it("あるtickで新規生成されたSpeechActiveEffectは、そのtick自身の意思決定入力(activeEffects)には含まれず、翌tick以降にのみ現れる(off-by-one不変条件)", () => {
    const preset = PRESETS[0];
    const intervention: InterventionRuntimeOptions = { interventionId: "light-observer-invitation" };
    const states = runCollectingStates(2024, preset.params, { enabled: true }, intervention);

    let sawNewActiveEffect = false;
    for (let i = 1; i < states.length; i++) {
      const prev = states[i - 1];
      const curr = states[i];
      const tick = curr.tick;

      // engine.tsが実際にこのtickの意思決定へ渡すactiveEffectsと同じ導出(engine.ts:335-337参照)
      const usedThisTick = advanceActiveSpeechEffects(prev.activeSpeechEffects ?? [], tick);
      const usedIds = new Set(usedThisTick.map((e) => e.id));

      const newlyStarted = (curr.activeSpeechEffects ?? []).filter((e) => e.startedAtTick === tick);
      if (newlyStarted.length > 0) sawNewActiveEffect = true;

      for (const fresh of newlyStarted) {
        expect(
          usedIds.has(fresh.id),
          `tick ${tick}: 新規effect ${fresh.id} が同一tickの意思決定入力に含まれてしまっている`,
        ).toBe(false);
      }
    }
    expect(sawNewActiveEffect, "新規SpeechActiveEffectが一度も生成されなかった").toBe(true);
  });

  it("失効したactiveSpeechEffectはその後のtickの意思決定入力に一切残らない(expiresAtTick > tickが常に成立する)", () => {
    const preset = PRESETS[0];
    const states = runCollectingStates(2024, preset.params, { enabled: true });

    for (const state of states) {
      for (const effect of state.activeSpeechEffects ?? []) {
        expect(
          effect.expiresAtTick > state.tick,
          `tick ${state.tick}: 失効済み(expiresAtTick=${effect.expiresAtTick})のeffect ${effect.id} が残存している`,
        ).toBe(true);
      }
    }
  });
});

describe("Phase 3 受入回帰テスト: 数値安全性", () => {
  const DIMENSIONS = ["stress", "attractiveness", "approachProbability", "leaveThreshold"] as const;

  it("全preset×代表seedで、stress/reception距離/interpretation強度/effect出力値/activeEffect強度がすべて有限かつ定義範囲内", () => {
    for (const preset of PRESETS) {
      for (const seed of REPRESENTATIVE_SEEDS) {
        const finalState = runToCompletion(seed, preset.params, { enabled: true });
        const label = `preset=${preset.id} seed=${seed}`;

        for (const agent of finalState.agents) {
          expect(Number.isFinite(agent.stress), label).toBe(true);
          expect(agent.stress, label).toBeGreaterThanOrEqual(0);
          expect(agent.stress, label).toBeLessThanOrEqual(1);
          expect(Number.isFinite(agent.x) && Number.isFinite(agent.y), label).toBe(true);
        }

        for (const reception of finalState.speechReceptionLog ?? []) {
          expect(Number.isFinite(reception.distance), label).toBe(true);
          expect(Number.isFinite(reception.threshold), label).toBe(true);
        }

        for (const interpretation of finalState.speechInterpretationLog ?? []) {
          expect(Number.isFinite(interpretation.intensity), label).toBe(true);
          expect(interpretation.intensity, label).toBeGreaterThanOrEqual(0);
          expect(interpretation.intensity, label).toBeLessThanOrEqual(1);
          for (const factor of interpretation.factors) {
            expect(Number.isFinite(factor.rawValue), `${label} factor ${factor.key}`).toBe(true);
            expect(Number.isFinite(factor.normalizedValue), `${label} factor ${factor.key}`).toBe(true);
            expect(Number.isFinite(factor.contribution), `${label} factor ${factor.key}`).toBe(true);
          }
        }

        for (const effect of finalState.speechEffectLog ?? []) {
          expect(Number.isFinite(effect.outputValue), label).toBe(true);
          // 単一発言1件分の基礎強度を明らかに超える異常値を検知するための緩い安全域
          // (dimensionごとの個別チューニング値そのものには依存しない)
          expect(Math.abs(effect.outputValue), label).toBeLessThanOrEqual(1);
          expect(Number.isFinite(effect.durationTicks), label).toBe(true);
          expect(effect.durationTicks, label).toBeGreaterThan(0);
        }

        for (const active of finalState.activeSpeechEffects ?? []) {
          expect(Number.isFinite(active.initialStrength), label).toBe(true);
          expect(Number.isFinite(active.currentStrength), label).toBe(true);
          expect(Math.abs(active.initialStrength), label).toBeLessThanOrEqual(1);
          expect(Math.abs(active.currentStrength), label).toBeLessThanOrEqual(1);
          expect(active.expiresAtTick, label).toBeGreaterThan(active.startedAtTick);
        }

        // engine.tsの計算式へ実際に加算される集約後の値(複数effectの上限付き加算後)も、
        // 有限かつ緩い安全域内に収まる
        for (const agent of finalState.agents) {
          for (const dimension of DIMENSIONS) {
            const value = sumActiveEffectValue(finalState.activeSpeechEffects ?? [], agent.id, dimension, finalState.tick);
            expect(Number.isFinite(value), `${label} agent=${agent.id} dimension=${dimension}`).toBe(true);
            expect(Math.abs(value), `${label} agent=${agent.id} dimension=${dimension}`).toBeLessThanOrEqual(1.5);
          }
        }
      }
    }
  });

  it("全preset×代表seedで、speechLog/receptionLog/interpretationLog/effectLog/activeSpeechEffects間でidが一切衝突しない", () => {
    for (const preset of PRESETS) {
      for (const seed of REPRESENTATIVE_SEEDS) {
        const finalState = runToCompletion(seed, preset.params, { enabled: true });
        const allIds = [
          ...(finalState.speechLog ?? []).map((e) => e.id),
          ...(finalState.speechReceptionLog ?? []).map((e) => e.id),
          ...(finalState.speechInterpretationLog ?? []).map((e) => e.id),
          ...(finalState.speechEffectLog ?? []).map((e) => e.id),
          ...(finalState.activeSpeechEffects ?? []).map((e) => e.id),
        ];
        expect(new Set(allIds).size, `preset=${preset.id} seed=${seed}`).toBe(allIds.length);
      }
    }
  });

  it("長時間runでもactiveSpeechEffectsが無制限に増加しない(populationSizeに対して有界)", () => {
    const preset = PRESETS[0];
    const states = runCollectingStates(2024, preset.params, { enabled: true });
    const populationSize = preset.params.populationSize;
    // 4次元 x 話者候補 x 受け手候補、という理論上の緩い上限(`registerActiveSpeechEffects`が
    // 同一話者・同一intentの再発言を置換するため実際にはこれよりずっと少ない件数で安定するはずだが、
    // ここではtick数が増えても際限なく増加し続けないことだけを保証する)
    const bound = populationSize * populationSize * 4;

    for (const state of states) {
      expect((state.activeSpeechEffects ?? []).length, `tick ${state.tick}`).toBeLessThanOrEqual(bound);
    }

    const half = Math.floor(states.length / 2);
    const firstHalfMax = Math.max(0, ...states.slice(0, half).map((s) => (s.activeSpeechEffects ?? []).length));
    const secondHalfMax = Math.max(0, ...states.slice(half).map((s) => (s.activeSpeechEffects ?? []).length));
    expect(secondHalfMax).toBeLessThanOrEqual(Math.max(firstHalfMax * 3, 10));
  });
});
