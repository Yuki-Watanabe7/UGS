import { describe, expect, it } from "vitest";
import {
  applyExpressionEvents,
  createActiveExpressionsState,
  toExpressionBubbleCandidate,
  MAX_CONCURRENT_BUBBLES,
  MIN_DISPLAY_TICKS,
  type ExpressionBubbleCandidate,
} from "./activeExpressions";
import { createInitialState, stepSimulation } from "./engine";
import { deriveExpressionEvents } from "./expression";
import { resolveExpressionEventText } from "./expressionTemplates";
import { SeededRandom } from "./random";
import { PRESETS } from "./presets";

function makeCandidate(overrides: Partial<ExpressionBubbleCandidate>): ExpressionBubbleCandidate {
  return {
    agentId: "agent-a",
    text: "テスト",
    isObserverJoiner: false,
    intent: "watching",
    priority: 1,
    eventTick: 0,
    ttlTicks: 12,
    ...overrides,
  };
}

describe("applyExpressionEvents: lifetime", () => {
  it("keeps a bubble active until tick reaches its expiresAtTick", () => {
    const state0 = createActiveExpressionsState();
    const candidate = makeCandidate({ eventTick: 10, ttlTicks: 10 });
    const state1 = applyExpressionEvents(state0, [candidate], 10);
    expect(state1.active.has("agent-a")).toBe(true);

    const state2 = applyExpressionEvents(state1, [], 19);
    expect(state2.active.has("agent-a")).toBe(true);

    const state3 = applyExpressionEvents(state2, [], 20);
    expect(state3.active.has("agent-a")).toBe(false);
  });

  it("floors the displayed lifetime with minDisplayTicks even when recommendedTtlTicks is tiny", () => {
    const state0 = createActiveExpressionsState();
    const candidate = makeCandidate({ eventTick: 0, ttlTicks: 1 });
    const state1 = applyExpressionEvents(state0, [candidate], 0, { minDisplayTicks: 6 });

    const state2 = applyExpressionEvents(state1, [], 2);
    expect(state2.active.has("agent-a")).toBe(true);

    const state3 = applyExpressionEvents(state2, [], 6);
    expect(state3.active.has("agent-a")).toBe(false);
  });

  it("does not mutate the input state (returns new Maps)", () => {
    const state0 = createActiveExpressionsState();
    const candidate = makeCandidate({ eventTick: 0, ttlTicks: 5 });
    const state1 = applyExpressionEvents(state0, [candidate], 0);

    expect(state0.active.size).toBe(0);
    expect(state1.active).not.toBe(state0.active);
    expect(state1.pending).not.toBe(state0.pending);
  });

  it("stays frozen across repeated calls at the same tick (models Pause: no real-time decay)", () => {
    const state0 = createActiveExpressionsState();
    const candidate = makeCandidate({ eventTick: 0, ttlTicks: 5 });
    const state1 = applyExpressionEvents(state0, [candidate], 0);

    const state2 = applyExpressionEvents(state1, [], 0);
    const state3 = applyExpressionEvents(state2, [], 0);
    expect(state3.active.has("agent-a")).toBe(true);
    expect(state3.active.get("agent-a")).toEqual(state1.active.get("agent-a"));
  });
});

describe("applyExpressionEvents: per-agent conflict (1 bubble + short queue)", () => {
  it("replaces the active bubble immediately when a higher-priority event arrives", () => {
    const state0 = createActiveExpressionsState();
    const low = makeCandidate({ eventTick: 0, priority: 1, text: "低優先度" });
    const state1 = applyExpressionEvents(state0, [low], 0);

    const high = makeCandidate({ eventTick: 1, priority: 2, text: "高優先度" });
    const state2 = applyExpressionEvents(state1, [high], 1);

    expect(state2.active.get("agent-a")?.text).toBe("高優先度");
  });

  it("queues a same-or-lower priority event instead of interrupting the active bubble before minDisplayTicks", () => {
    const state0 = createActiveExpressionsState();
    const first = makeCandidate({ eventTick: 0, priority: 1, text: "最初" });
    const state1 = applyExpressionEvents(state0, [first], 0, { minDisplayTicks: 6 });

    const second = makeCandidate({ eventTick: 1, priority: 1, text: "次" });
    const state2 = applyExpressionEvents(state1, [second], 1, { minDisplayTicks: 6 });

    expect(state2.active.get("agent-a")?.text).toBe("最初");
    expect(state2.pending.get("agent-a")?.text).toBe("次");
  });

  it("promotes the queued event once the active bubble's minimum display time elapses", () => {
    const state0 = createActiveExpressionsState();
    const first = makeCandidate({ eventTick: 0, priority: 1, text: "最初", ttlTicks: 100 });
    const state1 = applyExpressionEvents(state0, [first], 0, { minDisplayTicks: 6 });

    const second = makeCandidate({ eventTick: 1, priority: 1, text: "次" });
    const state2 = applyExpressionEvents(state1, [second], 1, { minDisplayTicks: 6 });
    expect(state2.active.get("agent-a")?.text).toBe("最初");

    const state3 = applyExpressionEvents(state2, [], 6, { minDisplayTicks: 6 });
    expect(state3.active.get("agent-a")?.text).toBe("次");
    expect(state3.pending.has("agent-a")).toBe(false);
  });

  it("does not let a later low-priority event overwrite an already-queued higher-priority event", () => {
    const state0 = createActiveExpressionsState();
    const first = makeCandidate({ eventTick: 0, priority: 1, text: "最初", ttlTicks: 100 });
    const state1 = applyExpressionEvents(state0, [first], 0, { minDisplayTicks: 6 });

    const important = makeCandidate({ eventTick: 1, priority: 1, text: "重要" });
    const state2 = applyExpressionEvents(state1, [important], 1, { minDisplayTicks: 6 });
    expect(state2.pending.get("agent-a")?.text).toBe("重要");

    const trivial = makeCandidate({ eventTick: 2, priority: 0, text: "些細" });
    const state3 = applyExpressionEvents(state2, [trivial], 2, { minDisplayTicks: 6 });
    expect(state3.pending.get("agent-a")?.text).toBe("重要");
  });

  it("replaces the active bubble once minDisplayTicks has elapsed even for a same-priority event", () => {
    const state0 = createActiveExpressionsState();
    const first = makeCandidate({ eventTick: 0, priority: 1, text: "最初", ttlTicks: 100 });
    const state1 = applyExpressionEvents(state0, [first], 0, { minDisplayTicks: 6 });

    const second = makeCandidate({ eventTick: 6, priority: 1, text: "次" });
    const state2 = applyExpressionEvents(state1, [second], 6, { minDisplayTicks: 6 });
    expect(state2.active.get("agent-a")?.text).toBe("次");
  });
});

describe("applyExpressionEvents: canvas-wide concurrency cap", () => {
  it("admits new agents up to maxConcurrent without eviction", () => {
    const state0 = createActiveExpressionsState();
    const candidates = ["a", "b", "c"].map((id) => makeCandidate({ agentId: id, eventTick: 0 }));
    const state1 = applyExpressionEvents(state0, candidates, 0, { maxConcurrent: 3 });
    expect(state1.active.size).toBe(3);
  });

  it("drops a new low-priority agent event when at capacity and nothing weaker exists", () => {
    const state0 = createActiveExpressionsState();
    const candidates = ["a", "b"].map((id) =>
      makeCandidate({ agentId: id, eventTick: 0, priority: 2, isObserverJoiner: true }),
    );
    const state1 = applyExpressionEvents(state0, candidates, 0, { maxConcurrent: 2 });

    const newcomer = makeCandidate({ agentId: "c", eventTick: 1, priority: 1, isObserverJoiner: false });
    const state2 = applyExpressionEvents(state1, [newcomer], 1, { maxConcurrent: 2 });

    expect(state2.active.has("c")).toBe(false);
    expect(state2.active.size).toBe(2);
  });

  it("evicts the lowest-priority active bubble to admit a higher-priority newcomer at capacity", () => {
    const state0 = createActiveExpressionsState();
    const candidates = ["a", "b"].map((id) => makeCandidate({ agentId: id, eventTick: 0, priority: 1 }));
    const state1 = applyExpressionEvents(state0, candidates, 0, { maxConcurrent: 2 });

    const important = makeCandidate({ agentId: "c", eventTick: 1, priority: 2, isObserverJoiner: true });
    const state2 = applyExpressionEvents(state1, [important], 1, { maxConcurrent: 2 });

    expect(state2.active.has("c")).toBe(true);
    expect(state2.active.size).toBe(2);
  });

  it("prefers evicting the oldest event among equal-priority active bubbles at capacity", () => {
    const state0 = createActiveExpressionsState();
    const older = makeCandidate({ agentId: "a", eventTick: 0, priority: 1 });
    const newer = makeCandidate({ agentId: "b", eventTick: 1, priority: 1 });
    const state1 = applyExpressionEvents(state0, [older], 0, { maxConcurrent: 2 });
    const state2 = applyExpressionEvents(state1, [newer], 1, { maxConcurrent: 2 });

    const challenger = makeCandidate({ agentId: "c", eventTick: 2, priority: 1 });
    const state3 = applyExpressionEvents(state2, [challenger], 2, { maxConcurrent: 2 });

    expect(state3.active.has("a")).toBe(false);
    expect(state3.active.has("b")).toBe(true);
    expect(state3.active.has("c")).toBe(true);
  });

  it("prefers keeping an observerJoiner bubble over a non-observerJoiner one at equal priority", () => {
    const state0 = createActiveExpressionsState();
    const observer = makeCandidate({ agentId: "obs", eventTick: 0, priority: 1, isObserverJoiner: true });
    const general = makeCandidate({ agentId: "gen", eventTick: 0, priority: 1, isObserverJoiner: false });
    const state1 = applyExpressionEvents(state0, [observer, general], 0, { maxConcurrent: 2 });

    const challenger = makeCandidate({ agentId: "new", eventTick: 1, priority: 1, isObserverJoiner: false });
    const state2 = applyExpressionEvents(state1, [challenger], 1, { maxConcurrent: 2 });

    expect(state2.active.has("obs")).toBe(true);
    expect(state2.active.has("gen")).toBe(false);
    expect(state2.active.has("new")).toBe(true);
  });
});

describe("applyExpressionEvents: multiple same-tick events for one agent", () => {
  it("is deterministic regardless of input order, keeping the highest-priority event active", () => {
    const state0 = createActiveExpressionsState();
    const lowFirst = [
      makeCandidate({ eventTick: 0, priority: 1, text: "低" }),
      makeCandidate({ eventTick: 0, priority: 3, text: "高" }),
    ];
    const highFirst = [...lowFirst].reverse();

    const resultA = applyExpressionEvents(state0, lowFirst, 0);
    const resultB = applyExpressionEvents(state0, highFirst, 0);

    expect(resultA.active.get("agent-a")?.text).toBe("高");
    expect(resultB.active.get("agent-a")?.text).toBe("高");
  });
});

/**
 * Issue #67「混雑・フィルタテスト」の受入テスト。
 * 個別ルールの単体テスト(上記)に加え、実際のシミュレーションを最後まで走らせたときにも
 * 「1エージェント1吹き出し」「同時表示上限」が一度も破られないことを、多数の代表seed・presetで確認する。
 */
describe("crowding invariants: 1エージェント1吹き出し制約 / 同時表示上限が実際のシミュレーション全体を通じて守られる", () => {
  for (const preset of PRESETS) {
    for (const seed of [1, 2024, 999999]) {
      it(`preset="${preset.id}" seed=${seed}: 全tickでactive.size<=maxConcurrentかつagentIdの重複がない`, () => {
        const rng = new SeededRandom(seed);
        let state = createInitialState(seed, preset.params);
        let active = createActiveExpressionsState();
        const maxConcurrent = 4;
        let ticks = 0;

        while (!state.finished && ticks < 400) {
          const next = stepSimulation(state, preset.params, rng);
          const events = deriveExpressionEvents(state, next, { seed });
          const candidates = events.map((event) => {
            const agent = next.agents.find((a) => a.id === event.agentId);
            const isObserverJoiner = agent?.isObserverJoiner ?? false;
            return toExpressionBubbleCandidate(
              event,
              resolveExpressionEventText(event, isObserverJoiner),
              isObserverJoiner,
            );
          });
          active = applyExpressionEvents(active, candidates, next.tick, { maxConcurrent });

          // 混雑上限: アクティブ数は常にmaxConcurrent以下
          expect(active.active.size).toBeLessThanOrEqual(maxConcurrent);
          // 1エージェント1吹き出し: Mapのキーはagentidなので構造上重複しえないが、
          // 値の`agentId`フィールド自体もキーと矛盾しないことを確認する
          for (const [agentId, bubble] of active.active) {
            expect(bubble.agentId).toBe(agentId);
          }
          // pending(キュー)も同様に1エージェントにつき最大1件(全体人数を超えて膨張しない)
          for (const [agentId, bubble] of active.pending) {
            expect(bubble.agentId).toBe(agentId);
          }
          expect(active.pending.size).toBeLessThanOrEqual(next.agents.length);

          state = next;
          ticks += 1;
        }
      });
    }
  }
});

describe("crowding defaults: オプション省略時はエクスポート済みの既定値が使われる", () => {
  it("maxConcurrentを省略するとMAX_CONCURRENT_BUBBLESが上限として使われる", () => {
    const state0 = createActiveExpressionsState();
    const candidates = Array.from({ length: MAX_CONCURRENT_BUBBLES + 2 }, (_, i) =>
      makeCandidate({ agentId: `agent-${i}`, eventTick: 0, priority: 1 }),
    );
    const state1 = applyExpressionEvents(state0, candidates, 0);
    expect(state1.active.size).toBe(MAX_CONCURRENT_BUBBLES);
  });

  it("minDisplayTicksを省略するとMIN_DISPLAY_TICKSが最低表示時間として使われる", () => {
    const state0 = createActiveExpressionsState();
    const candidate = makeCandidate({ eventTick: 0, priority: 1, ttlTicks: 1 });
    const state1 = applyExpressionEvents(state0, [candidate], 0);

    const justBefore = applyExpressionEvents(state1, [], MIN_DISPLAY_TICKS - 1);
    expect(justBefore.active.has("agent-a")).toBe(true);

    const atMinDisplay = applyExpressionEvents(state1, [], MIN_DISPLAY_TICKS);
    expect(atMinDisplay.active.has("agent-a")).toBe(false);
  });
});
