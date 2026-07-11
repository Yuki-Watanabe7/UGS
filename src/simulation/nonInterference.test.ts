import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { deriveExpressionEvents } from "./expression";
import { resolveExpressionEventText } from "./expressionTemplates";
import { applyExpressionEvents, createActiveExpressionsState, toExpressionBubbleCandidate } from "./activeExpressions";
import { SeededRandom } from "./random";
import { PRESETS } from "./presets";
import { buildSimulationSummary } from "./summary";
import type { SimParams, SimulationState } from "./types";
import type { InterventionRuntimeOptions } from "./interventions";

/**
 * Phase 1の最重要要件(Issue #67)の受入テスト: 心の声の生成・表示は観察専用であり、
 * それらの有無でシミュレーション本体(SimulationState/PRNG消費)の結果が一切変わらないことを保証する。
 *
 * 3つのモードを比較する:
 * - "noExpression": deriveExpressionEventsを一切呼ばない(心の声生成なし)
 * - "generateOnly": 毎tick deriveExpressionEventsを呼ぶが結果は捨てる(心の声生成あり・表示OFF相当)
 * - "generateAndDisplay": 毎tick deriveExpressionEvents→文言解決→activeExpressionsの
 *   競合/寿命/混雑制御まで、UI(useActiveExpressions)が実際に行う処理を丸ごと通す(表示ON相当)
 *
 * 3モードとも同じ`SeededRandom`インスタンスの状態遷移(=消費回数)を経て`stepSimulation`を
 * 呼ぶ点は共通。deriveExpressionEvents/activeExpressions側は本体のrngを一切受け取らないため、
 * ここで本体状態列とPRNG消費後の後続乱数が一致すれば「非介入性」の直接的な証拠になる。
 */

type Mode = "noExpression" | "generateOnly" | "generateAndDisplay";

const MAX_TICKS = 400;

function runSimulation(
  seed: number,
  params: SimParams,
  mode: Mode,
  intervention?: InterventionRuntimeOptions,
): { states: SimulationState[]; rngProbe: number } {
  const rng = new SeededRandom(seed);
  let state = createInitialState(seed, params, intervention);
  const states: SimulationState[] = [state];
  let activeExpressions = createActiveExpressionsState();

  let ticks = 0;
  while (!state.finished && ticks < MAX_TICKS) {
    const next = stepSimulation(state, params, rng, intervention);

    if (mode !== "noExpression") {
      const events = deriveExpressionEvents(state, next, { seed });

      if (mode === "generateAndDisplay") {
        const candidates = events.map((event) => {
          const agent = next.agents.find((a) => a.id === event.agentId);
          const isObserverJoiner = agent?.isObserverJoiner ?? false;
          return toExpressionBubbleCandidate(event, resolveExpressionEventText(event, isObserverJoiner), isObserverJoiner);
        });
        activeExpressions = applyExpressionEvents(activeExpressions, candidates, next.tick);
      }
    }

    state = next;
    states.push(state);
    ticks += 1;
  }

  // 本体PRNGの「消費回数が変わっていないこと」を、後続の乱数値が一致するかどうかで検証する。
  // deriveExpressionEvents/activeExpressionsはrngインスタンスを受け取らないため、途中で
  // 余計に消費/温存されていればここでずれるはずである。
  const rngProbe = rng.next();

  return { states, rngProbe };
}

const SEEDS = [1, 12345, 999999];

describe("非介入性: 心の声の生成・表示はシミュレーション本体に影響しない", () => {
  for (const preset of PRESETS) {
    for (const seed of SEEDS) {
      it(`preset="${preset.id}" seed=${seed}: 生成なし/生成のみ/生成+表示のtick別状態列とPRNG消費が完全一致する`, () => {
        const baseline = runSimulation(seed, preset.params, "noExpression");
        const generateOnly = runSimulation(seed, preset.params, "generateOnly");
        const generateAndDisplay = runSimulation(seed, preset.params, "generateAndDisplay");

        // tick数(=停止タイミング)が変わっていないこと
        expect(generateOnly.states.length).toBe(baseline.states.length);
        expect(generateAndDisplay.states.length).toBe(baseline.states.length);

        // 各tickのagent state/position/stress/group membership/group state/logが完全一致すること
        // (snapshotではなく構造化データ同士のdeep equalで比較する)
        expect(generateOnly.states).toEqual(baseline.states);
        expect(generateAndDisplay.states).toEqual(baseline.states);

        // 本体PRNGの消費回数が変わっていないことを、停止直後に1回追加でnext()した値の一致で確認する
        expect(generateOnly.rngProbe).toBe(baseline.rngProbe);
        expect(generateAndDisplay.rngProbe).toBe(baseline.rngProbe);
      });
    }
  }

  it("最終結果(参加/離脱人数・observerJoiner最終状態・グループ成立数/tick)が生成/表示の有無で一致する", () => {
    for (const preset of PRESETS) {
      for (const seed of SEEDS) {
        const baseline = runSimulation(seed, preset.params, "noExpression");
        const generateAndDisplay = runSimulation(seed, preset.params, "generateAndDisplay");

        const baselineSummary = buildSimulationSummary(baseline.states.at(-1)!);
        const displaySummary = buildSimulationSummary(generateAndDisplay.states.at(-1)!);

        expect(displaySummary).toEqual(baselineSummary);
      }
    }
  });

  it("介入シナリオ適用時も非介入性が保たれる(light-observer-invitationで検証)", () => {
    const preset = PRESETS[0];
    const intervention: InterventionRuntimeOptions = { interventionId: "light-observer-invitation" };

    for (const seed of SEEDS) {
      const baseline = runSimulation(seed, preset.params, "noExpression", intervention);
      const generateAndDisplay = runSimulation(seed, preset.params, "generateAndDisplay", intervention);

      expect(generateAndDisplay.states).toEqual(baseline.states);
      expect(generateAndDisplay.rngProbe).toBe(baseline.rngProbe);
    }
  });
});
