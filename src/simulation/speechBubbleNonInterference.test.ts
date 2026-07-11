import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { applySpeechBubbleEvents, createActiveSpeechBubblesState, toSpeechBubbleCandidate } from "./activeSpeechBubbles";
import { formatSpeechBubbleText } from "../components/speechBubbleFormat";
import { buildAgentLabelMap } from "../components/speechDisplay";
import { SeededRandom } from "./random";
import { PRESETS } from "./presets";
import { buildSimulationSummary } from "./summary";
import type { SimParams, SimulationState } from "./types";

/**
 * Issue #82の受け入れ条件「発言吹き出しの表示ON/OFFによって、シミュレーション状態系列・
 * 乱数列・最終結果が変化しない」の受入テスト。`nonInterference.test.ts`(心の声)と同じ考え方。
 *
 * `SpeechEvent`自体の生成(`speech.ts`/`engine.ts`)は常に行われる第一級のシミュレーション記録
 * であり、そこはトグル対象ではない(`speechGeneration.test.ts`/`speech.test.ts`で別途検証済み)。
 * ここで検証するのは表示レイヤー(`activeSpeechBubbles.ts`/`useActiveSpeechBubbles`)のON/OFFが
 * 本体に影響しないことで、表示レイヤーはrng・SimulationStateのいずれも受け取らず書き換えない
 * 設計であるため、以下では「表示処理を毎tick実行するかどうか」で2モードを比較する。
 */

type Mode = "noDisplay" | "display";

const MAX_TICKS = 400;

function runSimulation(seed: number, params: SimParams, mode: Mode): { states: SimulationState[]; rngProbe: number } {
  const rng = new SeededRandom(seed);
  let state = createInitialState(seed, params);
  const states: SimulationState[] = [state];
  let bubbles = createActiveSpeechBubblesState();

  let ticks = 0;
  while (!state.finished && ticks < MAX_TICKS) {
    const next = stepSimulation(state, params, rng);

    if (mode === "display") {
      const labelById = buildAgentLabelMap(next.agents);
      const newEvents = (next.speechLog ?? []).filter((event) => event.tick === next.tick);
      const candidates = newEvents.map((event) => {
        const agent = next.agents.find((a) => a.id === event.speakerId);
        const isObserverJoiner = agent?.isObserverJoiner ?? false;
        return toSpeechBubbleCandidate(event, formatSpeechBubbleText(event, labelById), isObserverJoiner);
      });
      bubbles = applySpeechBubbleEvents(bubbles, candidates, next.tick);
    }

    state = next;
    states.push(state);
    ticks += 1;
  }

  const rngProbe = rng.next();
  return { states, rngProbe };
}

const SEEDS = [1, 12345, 999999];

describe("非介入性: 発言吹き出しの表示はシミュレーション本体に影響しない", () => {
  for (const preset of PRESETS) {
    for (const seed of SEEDS) {
      it(`preset="${preset.id}" seed=${seed}: 表示処理あり/なしのtick別状態列とPRNG消費が完全一致する`, () => {
        const baseline = runSimulation(seed, preset.params, "noDisplay");
        const withDisplay = runSimulation(seed, preset.params, "display");

        expect(withDisplay.states.length).toBe(baseline.states.length);
        expect(withDisplay.states).toEqual(baseline.states);
        expect(withDisplay.rngProbe).toBe(baseline.rngProbe);
      });
    }
  }

  it("最終結果(参加/離脱人数・observerJoiner最終状態・グループ成立数/tick)が表示の有無で一致する", () => {
    for (const preset of PRESETS) {
      for (const seed of SEEDS) {
        const baseline = runSimulation(seed, preset.params, "noDisplay");
        const withDisplay = runSimulation(seed, preset.params, "display");

        const baselineSummary = buildSimulationSummary(baseline.states.at(-1)!);
        const displaySummary = buildSimulationSummary(withDisplay.states.at(-1)!);

        expect(displaySummary).toEqual(baselineSummary);
      }
    }
  });
});
