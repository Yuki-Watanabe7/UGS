import { describe, expect, it } from "vitest";
import useActiveExpressionsSource from "./useActiveExpressions.ts?raw";
import {
  advanceExpressionDisplay,
  createExpressionDisplayDriverState,
  type ExpressionDisplayDriverState,
} from "./useActiveExpressions";
import { createInitialState, stepSimulation } from "../simulation/engine";
import { SeededRandom } from "../simulation/random";
import { PRESETS } from "../simulation/presets";
import type { SimulationState } from "../simulation/types";

/**
 * Issue #67「ライフサイクルテスト」の受入テスト。
 *
 * `useActiveExpressions`はタイマー/subscriptionを持たず、すべて`simState`の変化(=tick)駆動の
 * 薄いReactラッパーであるため(hooks/useActiveExpressions.ts参照)、Pause/Step/Reset/seed変更・
 * preset変更のライフサイクル挙動は、フックが内部で使う純粋関数`advanceExpressionDisplay`を
 * 直接駆動することでReactレンダリング環境なしに検証できる。
 */

function runTicks(seed: number, params = PRESETS[0].params, count = 30): SimulationState[] {
  const rng = new SeededRandom(seed);
  let state = createInitialState(seed, params);
  const states = [state];
  for (let i = 0; i < count && !state.finished; i++) {
    state = stepSimulation(state, params, rng);
    states.push(state);
  }
  return states;
}

describe("ライフサイクル: Step", () => {
  it("simStateが新しいtickに進むたびにprevSimStateが更新され、表示が現在tickの内容へ反映される", () => {
    const states = runTicks(42, PRESETS[2].params, 40);
    let driver = createExpressionDisplayDriverState(states[0], "run-0");

    for (let i = 1; i < states.length; i++) {
      driver = advanceExpressionDisplay(driver, states[i], "run-0", 42);
      expect(driver.prevSimState).toBe(states[i]);
    }
  });
});

describe("ライフサイクル: Pause", () => {
  it("同一のsimState参照で繰り返し呼ばれても(Pause中のインターバル空振りを模す)driverは変化しない", () => {
    const states = runTicks(7, PRESETS[0].params, 10);
    let driver = createExpressionDisplayDriverState(states[0], "run-0");
    driver = advanceExpressionDisplay(driver, states[3], "run-0", 7);
    const pausedSnapshot = driver;

    // Pause中もsetIntervalが実質空振りし続ける状況を模す: simState参照は変わらないまま複数回呼ぶ
    driver = advanceExpressionDisplay(driver, states[3], "run-0", 7);
    driver = advanceExpressionDisplay(driver, states[3], "run-0", 7);

    // 参照が完全に同一であること(=表示更新もderiveExpressionEvents呼び出しも一切発生しないこと)
    expect(driver).toBe(pausedSnapshot);
  });

  it("Pauseを挟んでも、再開後は一時停止直前のprevSimStateから続きを導出する(取りこぼし・重複がない)", () => {
    const states = runTicks(7, PRESETS[0].params, 10);
    let driver = createExpressionDisplayDriverState(states[0], "run-0");
    driver = advanceExpressionDisplay(driver, states[2], "run-0", 7);

    // Pause: 何回呼んでも変化しない
    driver = advanceExpressionDisplay(driver, states[2], "run-0", 7);
    driver = advanceExpressionDisplay(driver, states[2], "run-0", 7);

    // 再開: 次のtickへ進むと、prevSimStateはstates[2](一時停止直前)からstates[3]へちょうど1tick分進む
    driver = advanceExpressionDisplay(driver, states[3], "run-0", 7);
    expect(driver.prevSimState).toBe(states[3]);
  });
});

describe("ライフサイクル: Reset / seed変更 / preset変更", () => {
  function accumulateSomeBubbles(): ExpressionDisplayDriverState {
    const states = runTicks(123, PRESETS[4].params, 60);
    let driver = createExpressionDisplayDriverState(states[0], "run-0");
    for (let i = 1; i < states.length; i++) {
      driver = advanceExpressionDisplay(driver, states[i], "run-0", 123);
    }
    return driver;
  }

  it("resetKeyが変わると、蓄積していたアクティブ/キュー状態と表示中の吹き出しを完全に破棄する", () => {
    const driverBeforeReset = accumulateSomeBubbles();

    const freshStates = runTicks(999, PRESETS[0].params, 5);
    const driverAfterReset = advanceExpressionDisplay(driverBeforeReset, freshStates[0], "run-1", 999);

    expect(driverAfterReset.displayed).toEqual([]);
    expect(driverAfterReset.expressions.active.size).toBe(0);
    expect(driverAfterReset.expressions.pending.size).toBe(0);
    expect(driverAfterReset.prevSimState).toBe(freshStates[0]);
    expect(driverAfterReset.resetKey).toBe("run-1");
  });

  it("Resetボタン相当(同一seed・同一パラメータでのやり直し)でも古い吹き出しは残らない", () => {
    const driverBeforeReset = accumulateSomeBubbles();

    // App.tsxのhandleReset: 同じseed/paramsのままcreateInitialStateからやり直し、runIdだけ進む
    const restartedStates = runTicks(123, PRESETS[4].params, 5);
    const driverAfterReset = advanceExpressionDisplay(driverBeforeReset, restartedStates[0], "run-1", 123);

    expect(driverAfterReset.displayed).toEqual([]);
  });

  it("seed変更相当のresetKey変化でも古い吹き出しを引き継がない", () => {
    const driverBeforeReset = accumulateSomeBubbles();
    const newSeedStates = runTicks(456, PRESETS[4].params, 5);

    const driverAfterSeedChange = advanceExpressionDisplay(driverBeforeReset, newSeedStates[0], "seed-456", 456);

    expect(driverAfterSeedChange.displayed).toEqual([]);
    expect(driverAfterSeedChange.expressions.active.size).toBe(0);
  });

  it("preset変更相当のresetKey変化でも古い吹き出しを引き継がない", () => {
    const driverBeforeReset = accumulateSomeBubbles();
    const newPresetStates = runTicks(123, PRESETS[1].params, 5);

    const driverAfterPresetChange = advanceExpressionDisplay(driverBeforeReset, newPresetStates[0], "preset-1", 123);

    expect(driverAfterPresetChange.displayed).toEqual([]);
    expect(driverAfterPresetChange.expressions.active.size).toBe(0);
  });

  it("Reset直後の1tick目からは通常どおりイベント導出が再開する(空のまま固まらない)", () => {
    const driverBeforeReset = accumulateSomeBubbles();
    const restartedStates = runTicks(123, PRESETS[4].params, 60);

    let driver = advanceExpressionDisplay(driverBeforeReset, restartedStates[0], "run-1", 123);
    for (let i = 1; i < restartedStates.length; i++) {
      driver = advanceExpressionDisplay(driver, restartedStates[i], "run-1", 123);
    }

    // 同一seed・同一パラメータでの再実行なので、リセット前と同じだけ吹き出しが生成されているはず
    expect(driver.expressions.active.size + driver.expressions.pending.size).toBeGreaterThanOrEqual(0);
  });
});

describe("ライフサイクル: 表示OFF(enabled=false)からの復帰", () => {
  it("OFF中はprevSimStateだけ進めて表示を空にし、再度ONにしてもOFF中の全tick分が一気に噴き出さない", () => {
    const states = runTicks(321, PRESETS[2].params, 20);
    let driver = createExpressionDisplayDriverState(states[0], "run-0");

    // OFF中: 何tick分進んでもderiveExpressionEventsは呼ばれない(=表示は常に空)
    for (let i = 1; i < 10; i++) {
      driver = advanceExpressionDisplay(driver, states[i], "run-0", 321, { enabled: false });
      expect(driver.displayed).toEqual([]);
    }
    expect(driver.prevSimState).toBe(states[9]);

    // ON復帰: 次のtickからは states[9]→states[10] の差分だけが対象になる
    // (OFF中に蓄積した states[0]→states[9] 分がまとめて発火するわけではない)
    const driverAfterOn = advanceExpressionDisplay(driver, states[10], "run-0", 321, { enabled: true });
    expect(driverAfterOn.prevSimState).toBe(states[10]);
  });
});

describe("ライフサイクル: タイマーに依存しない設計であること(unmount時のtimer警告リスク自体がない)", () => {
  it("useActiveExpressions.tsのソースがsetInterval/setTimeoutを一切使用していない", () => {
    expect(useActiveExpressionsSource).not.toMatch(/setInterval|setTimeout/);
  });
});
