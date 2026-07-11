import { describe, expect, it } from "vitest";
import {
  applySpeechBubbleEvents,
  createActiveSpeechBubblesState,
  MAX_CONCURRENT_SPEECH_BUBBLES,
  MIN_SPEECH_DISPLAY_TICKS,
  type SpeechBubbleCandidate,
} from "./activeSpeechBubbles";

function makeCandidate(overrides: Partial<SpeechBubbleCandidate>): SpeechBubbleCandidate {
  return {
    agentId: "agent-a",
    text: "テスト",
    isObserverJoiner: false,
    intent: "invite",
    priority: 1,
    eventTick: 0,
    ttlTicks: 12,
    ...overrides,
  };
}

describe("applySpeechBubbleEvents: lifetime", () => {
  it("keeps a bubble active until tick reaches its expiresAtTick", () => {
    const state0 = createActiveSpeechBubblesState();
    const candidate = makeCandidate({ eventTick: 10, ttlTicks: 10 });
    const state1 = applySpeechBubbleEvents(state0, [candidate], 10);
    expect(state1.active.has("agent-a")).toBe(true);

    const state2 = applySpeechBubbleEvents(state1, [], 19);
    expect(state2.active.has("agent-a")).toBe(true);

    const state3 = applySpeechBubbleEvents(state2, [], 20);
    expect(state3.active.has("agent-a")).toBe(false);
  });

  it("floors the displayed lifetime with minDisplayTicks even when ttlTicks is tiny", () => {
    const state0 = createActiveSpeechBubblesState();
    const candidate = makeCandidate({ eventTick: 0, ttlTicks: 1 });
    const state1 = applySpeechBubbleEvents(state0, [candidate], 0, { minDisplayTicks: 6 });

    const state2 = applySpeechBubbleEvents(state1, [], 2);
    expect(state2.active.has("agent-a")).toBe(true);

    const state3 = applySpeechBubbleEvents(state2, [], 6);
    expect(state3.active.has("agent-a")).toBe(false);
  });

  it("does not mutate the input state (returns new Maps)", () => {
    const state0 = createActiveSpeechBubblesState();
    const candidate = makeCandidate({ eventTick: 0, ttlTicks: 5 });
    const state1 = applySpeechBubbleEvents(state0, [candidate], 0);

    expect(state0.active.size).toBe(0);
    expect(state1.active).not.toBe(state0.active);
    expect(state1.pending).not.toBe(state0.pending);
  });

  it("stays frozen across repeated calls at the same tick (models Pause: no real-time decay)", () => {
    const state0 = createActiveSpeechBubblesState();
    const candidate = makeCandidate({ eventTick: 0, ttlTicks: 5 });
    const state1 = applySpeechBubbleEvents(state0, [candidate], 0);

    const state2 = applySpeechBubbleEvents(state1, [], 0);
    const state3 = applySpeechBubbleEvents(state2, [], 0);
    expect(state3.active.has("agent-a")).toBe(true);
    expect(state3.active.get("agent-a")).toEqual(state1.active.get("agent-a"));
  });
});

describe("applySpeechBubbleEvents: per-agent conflict (same speaker, multiple events in close ticks)", () => {
  it("queues a same-or-lower priority event instead of interrupting the active bubble before minDisplayTicks", () => {
    const state0 = createActiveSpeechBubblesState();
    const first = makeCandidate({ eventTick: 0, priority: 1, text: "最初の発言" });
    const state1 = applySpeechBubbleEvents(state0, [first], 0, { minDisplayTicks: 6 });

    const second = makeCandidate({ eventTick: 1, priority: 1, text: "次の発言" });
    const state2 = applySpeechBubbleEvents(state1, [second], 1, { minDisplayTicks: 6 });

    expect(state2.active.get("agent-a")?.text).toBe("最初の発言");
    expect(state2.pending.get("agent-a")?.text).toBe("次の発言");
  });

  it("promotes the queued event once the active bubble's minimum display time elapses", () => {
    const state0 = createActiveSpeechBubblesState();
    const first = makeCandidate({ eventTick: 0, priority: 1, text: "最初", ttlTicks: 100 });
    const state1 = applySpeechBubbleEvents(state0, [first], 0, { minDisplayTicks: 6 });

    const second = makeCandidate({ eventTick: 1, priority: 1, text: "次" });
    const state2 = applySpeechBubbleEvents(state1, [second], 1, { minDisplayTicks: 6 });
    expect(state2.active.get("agent-a")?.text).toBe("最初");

    const state3 = applySpeechBubbleEvents(state2, [], 6, { minDisplayTicks: 6 });
    expect(state3.active.get("agent-a")?.text).toBe("次");
    expect(state3.pending.has("agent-a")).toBe(false);
  });

  it("is deterministic regardless of input order when two events target the same speaker in the same tick", () => {
    const state0 = createActiveSpeechBubblesState();
    const first = [
      makeCandidate({ eventTick: 0, priority: 1, text: "A" }),
      makeCandidate({ eventTick: 0, priority: 3, text: "B" }),
    ];
    const reversed = [...first].reverse();

    const resultA = applySpeechBubbleEvents(state0, first, 0);
    const resultB = applySpeechBubbleEvents(state0, reversed, 0);

    expect(resultA.active.get("agent-a")?.text).toBe("B");
    expect(resultB.active.get("agent-a")?.text).toBe("B");
  });
});

describe("applySpeechBubbleEvents: canvas-wide concurrency cap", () => {
  it("admits new speakers up to maxConcurrent without eviction", () => {
    const state0 = createActiveSpeechBubblesState();
    const candidates = ["a", "b", "c"].map((id) => makeCandidate({ agentId: id, eventTick: 0 }));
    const state1 = applySpeechBubbleEvents(state0, candidates, 0, { maxConcurrent: 3 });
    expect(state1.active.size).toBe(3);
  });

  it("evicts the lowest-priority active bubble to admit a higher-priority (observerJoiner) newcomer at capacity", () => {
    const state0 = createActiveSpeechBubblesState();
    const candidates = ["a", "b"].map((id) => makeCandidate({ agentId: id, eventTick: 0, priority: 1 }));
    const state1 = applySpeechBubbleEvents(state0, candidates, 0, { maxConcurrent: 2 });

    const important = makeCandidate({ agentId: "c", eventTick: 1, priority: 2, isObserverJoiner: true });
    const state2 = applySpeechBubbleEvents(state1, [important], 1, { maxConcurrent: 2 });

    expect(state2.active.has("c")).toBe(true);
    expect(state2.active.size).toBe(2);
  });

  it("drops a new low-priority speaker event when at capacity and nothing weaker exists", () => {
    const state0 = createActiveSpeechBubblesState();
    const candidates = ["a", "b"].map((id) =>
      makeCandidate({ agentId: id, eventTick: 0, priority: 2, isObserverJoiner: true }),
    );
    const state1 = applySpeechBubbleEvents(state0, candidates, 0, { maxConcurrent: 2 });

    const newcomer = makeCandidate({ agentId: "c", eventTick: 1, priority: 1, isObserverJoiner: false });
    const state2 = applySpeechBubbleEvents(state1, [newcomer], 1, { maxConcurrent: 2 });

    expect(state2.active.has("c")).toBe(false);
    expect(state2.active.size).toBe(2);
  });
});

describe("crowding defaults: オプション省略時はエクスポート済みの既定値が使われる", () => {
  it("maxConcurrentを省略するとMAX_CONCURRENT_SPEECH_BUBBLESが上限として使われる", () => {
    const state0 = createActiveSpeechBubblesState();
    const candidates = Array.from({ length: MAX_CONCURRENT_SPEECH_BUBBLES + 2 }, (_, i) =>
      makeCandidate({ agentId: `agent-${i}`, eventTick: 0, priority: 1 }),
    );
    const state1 = applySpeechBubbleEvents(state0, candidates, 0);
    expect(state1.active.size).toBe(MAX_CONCURRENT_SPEECH_BUBBLES);
  });

  it("minDisplayTicksを省略するとMIN_SPEECH_DISPLAY_TICKSが最低表示時間として使われる", () => {
    const state0 = createActiveSpeechBubblesState();
    const candidate = makeCandidate({ eventTick: 0, priority: 1, ttlTicks: 1 });
    const state1 = applySpeechBubbleEvents(state0, [candidate], 0);

    const justBefore = applySpeechBubbleEvents(state1, [], MIN_SPEECH_DISPLAY_TICKS - 1);
    expect(justBefore.active.has("agent-a")).toBe(true);

    const atMinDisplay = applySpeechBubbleEvents(state1, [], MIN_SPEECH_DISPLAY_TICKS);
    expect(atMinDisplay.active.has("agent-a")).toBe(false);
  });
});
