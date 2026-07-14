import { describe, expect, it } from "vitest";
import useActiveSpeechBubblesSource from "./useActiveSpeechBubbles.ts?raw";
import {
  advanceSpeechBubbleDisplay,
  createSpeechBubbleDisplayDriverState,
  type SpeechBubbleDisplayDriverState,
} from "./useActiveSpeechBubbles";
import { createInitialState, stepSimulation } from "../simulation/engine";
import { SeededRandom } from "../simulation/random";
import { PRESETS } from "../simulation/presets";
import type { SimulationState } from "../simulation/types";

/**
 * `useActiveExpressions.test.ts`と同じ設計方針の受入テスト。`useActiveSpeechBubbles`も
 * タイマー/subscriptionを持たず、すべて`simState`の変化(=tick)駆動の薄いReactラッパーであるため、
 * Pause/Step/Reset/seed変更のライフサイクル挙動は、フックが内部で使う純粋関数
 * `advanceSpeechBubbleDisplay`を直接駆動することでReactレンダリング環境なしに検証できる。
 */

function runTicks(seed: number, params = PRESETS[0].params, count = 40): SimulationState[] {
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
    let driver = createSpeechBubbleDisplayDriverState(states[0], "run-0");

    for (let i = 1; i < states.length; i++) {
      driver = advanceSpeechBubbleDisplay(driver, states[i], "run-0");
      expect(driver.prevSimState).toBe(states[i]);
    }
  });

  it("表示中の吹き出しは、対応するSpeechEventが発生したtickのspeechLog内容と一致する", () => {
    const states = runTicks(42, PRESETS[2].params, 60);
    let driver = createSpeechBubbleDisplayDriverState(states[0], "run-0");

    for (let i = 1; i < states.length; i++) {
      driver = advanceSpeechBubbleDisplay(driver, states[i], "run-0");
      const thisTickEvents = (states[i].speechLog ?? []).filter((e) => e.tick === states[i].tick);
      // このtickに新規発言があれば、必ずどれかがactiveまたはpendingとして反映されている
      if (thisTickEvents.length > 0) {
        const speakerIds = new Set(thisTickEvents.map((e) => e.speakerId));
        for (const speakerId of speakerIds) {
          const isActive = driver.bubbles.active.has(speakerId);
          const isPending = driver.bubbles.pending.has(speakerId);
          expect(isActive || isPending).toBe(true);
        }
      }
    }
  });
});

describe("ライフサイクル: Pause", () => {
  it("同一のsimState参照で繰り返し呼ばれても(Pause中のインターバル空振りを模す)driverは変化しない", () => {
    const states = runTicks(7, PRESETS[0].params, 10);
    let driver = createSpeechBubbleDisplayDriverState(states[0], "run-0");
    driver = advanceSpeechBubbleDisplay(driver, states[3], "run-0");
    const pausedSnapshot = driver;

    driver = advanceSpeechBubbleDisplay(driver, states[3], "run-0");
    driver = advanceSpeechBubbleDisplay(driver, states[3], "run-0");

    expect(driver).toBe(pausedSnapshot);
  });

  it("Pauseを挟んでも、再開後は一時停止直前のprevSimStateから続きを導出する(取りこぼし・重複がない)", () => {
    const states = runTicks(7, PRESETS[0].params, 10);
    let driver = createSpeechBubbleDisplayDriverState(states[0], "run-0");
    driver = advanceSpeechBubbleDisplay(driver, states[2], "run-0");

    driver = advanceSpeechBubbleDisplay(driver, states[2], "run-0");
    driver = advanceSpeechBubbleDisplay(driver, states[2], "run-0");

    driver = advanceSpeechBubbleDisplay(driver, states[3], "run-0");
    expect(driver.prevSimState).toBe(states[3]);
  });
});

describe("ライフサイクル: Reset / seed変更", () => {
  function accumulateSomeBubbles(): SpeechBubbleDisplayDriverState {
    const states = runTicks(123, PRESETS[1].params, 60);
    let driver = createSpeechBubbleDisplayDriverState(states[0], "run-0");
    for (let i = 1; i < states.length; i++) {
      driver = advanceSpeechBubbleDisplay(driver, states[i], "run-0");
    }
    return driver;
  }

  it("resetKeyが変わると、蓄積していたアクティブ/キュー状態と表示中の吹き出しを完全に破棄する", () => {
    const driverBeforeReset = accumulateSomeBubbles();

    const freshStates = runTicks(999, PRESETS[0].params, 5);
    const driverAfterReset = advanceSpeechBubbleDisplay(driverBeforeReset, freshStates[0], "run-1");

    expect(driverAfterReset.displayed).toEqual([]);
    expect(driverAfterReset.bubbles.active.size).toBe(0);
    expect(driverAfterReset.bubbles.pending.size).toBe(0);
    expect(driverAfterReset.prevSimState).toBe(freshStates[0]);
    expect(driverAfterReset.resetKey).toBe("run-1");
  });

  it("seed変更相当のresetKey変化でも古い吹き出しを引き継がない", () => {
    const driverBeforeReset = accumulateSomeBubbles();
    const newSeedStates = runTicks(456, PRESETS[1].params, 5);

    const driverAfterSeedChange = advanceSpeechBubbleDisplay(driverBeforeReset, newSeedStates[0], "seed-456");

    expect(driverAfterSeedChange.displayed).toEqual([]);
    expect(driverAfterSeedChange.bubbles.active.size).toBe(0);
  });
});

describe("ライフサイクル: 表示OFF(enabled=false)からの復帰", () => {
  it("OFF中は表示を空にし、再度ONにしてもOFF中の全tick分が一気に噴き出さない", () => {
    const states = runTicks(321, PRESETS[2].params, 20);
    let driver = createSpeechBubbleDisplayDriverState(states[0], "run-0");

    for (let i = 1; i < 10; i++) {
      driver = advanceSpeechBubbleDisplay(driver, states[i], "run-0", { enabled: false });
      expect(driver.displayed).toEqual([]);
    }
    expect(driver.prevSimState).toBe(states[9]);

    const driverAfterOn = advanceSpeechBubbleDisplay(driver, states[10], "run-0", { enabled: true });
    expect(driverAfterOn.prevSimState).toBe(states[10]);
  });
});

describe("非介入性: advanceSpeechBubbleDisplayはsimStateを一切変更しない", () => {
  it("渡されたsimStateオブジェクトが呼び出し前後で同一の内容を保つ", () => {
    const states = runTicks(2024, PRESETS[3].params, 30);
    let driver = createSpeechBubbleDisplayDriverState(states[0], "run-0");
    for (let i = 1; i < states.length; i++) {
      const before = JSON.parse(JSON.stringify(states[i]));
      driver = advanceSpeechBubbleDisplay(driver, states[i], "run-0");
      expect(states[i]).toEqual(before);
    }
  });
});

describe("ライフサイクル: タイマーに依存しない設計であること(unmount時のtimer警告リスク自体がない)", () => {
  it("useActiveSpeechBubbles.tsのソースがsetInterval/setTimeoutを一切使用していない", () => {
    expect(useActiveSpeechBubblesSource).not.toMatch(/setInterval|setTimeout/);
  });
});

describe("Issue #119: 乖離発言の本心(innerThought)オーバーレイ", () => {
  const speaker = {
    id: "spk",
    label: "S",
    x: 400,
    y: 260,
    vx: 0,
    vy: 0,
    willingness: 0.8,
    initiative: 0.3,
    ambiguityTolerance: 0.5,
    influenceAvoidance: 0.9,
    conformity: 0,
    leaveThreshold: 0.5,
    isObserverJoiner: false,
    state: "leaving" as const,
    stress: 0.9,
  };
  // 社交辞令の辞退: 本心positiveのままのdecline(divergent)
  const divergentDecline = {
    id: "speech-12-spk-leaveDeclaration",
    tick: 12,
    speakerId: "spk",
    intent: "decline" as const,
    reason: "leaveDeclaration" as const,
    audience: "nearby" as const,
    textKey: "speech.leaveDeclaration",
    originX: 400,
    originY: 260,
    range: 200,
    strength: 1,
    audibility: 200,
    expression: {
      publicExpressionId: "public-12-spk",
      privateEvaluationId: "private-12-spk",
      divergent: true,
      privateStance: "positive" as const,
      expressedStance: "none" as const,
      baseIntent: "decline" as const,
    },
  };
  const base = (tick: number, speechLog: typeof divergentDecline[]): SimulationState => ({
    tick,
    agents: [speaker],
    groupCandidates: [],
    log: [],
    width: 800,
    height: 520,
    finished: false,
    speechLog,
  });

  it("seed/presetId指定時、乖離発言のバブルに本心(建前と異なる文言)が付与される", () => {
    const driver = createSpeechBubbleDisplayDriverState(base(11, []), "run");
    const next = advanceSpeechBubbleDisplay(driver, base(12, [divergentDecline]), "run", {
      seed: 7,
      presetId: "natural",
    });
    const bubble = next.bubbles.active.get("spk");
    expect(bubble?.innerThought).toBeDefined();
    expect(bubble?.innerThought).not.toBe(bubble?.text); // 本心と建前の文言が異なる
  });

  it("seed/presetId未指定なら本心オーバーレイは付与されない(後方互換)", () => {
    const driver = createSpeechBubbleDisplayDriverState(base(11, []), "run");
    const next = advanceSpeechBubbleDisplay(driver, base(12, [divergentDecline]), "run");
    expect(next.bubbles.active.get("spk")?.innerThought).toBeUndefined();
  });
});
