import { describe, expect, it } from "vitest";
import { filterThoughtsForDisplay } from "./expressionDisplayFilter";
import type { ThoughtBubbleDisplay } from "./SimulationCanvas";

const THOUGHTS: ThoughtBubbleDisplay[] = [
  { agentId: "a", text: "様子を見よう", isObserverJoiner: false, intent: "watching" },
  { agentId: "b", text: "もう帰ろう", isObserverJoiner: true, intent: "givingUpWaiting" },
  { agentId: "c", text: "参加した", isObserverJoiner: false, intent: "joinedGroup" },
  { agentId: "d", text: "そろそろ限界", isObserverJoiner: true, intent: "consideringLeaving" },
];

describe("filterThoughtsForDisplay", () => {
  it("passes every thought through unchanged for target=all", () => {
    expect(filterThoughtsForDisplay(THOUGHTS, "all")).toEqual(THOUGHTS);
  });

  it("keeps only observerJoiner thoughts for target=observerJoiner", () => {
    const result = filterThoughtsForDisplay(THOUGHTS, "observerJoiner");
    expect(result.map((t) => t.agentId)).toEqual(["b", "d"]);
  });

  it("keeps only state-transition/notification intents for target=important, excluding ambient ones", () => {
    const result = filterThoughtsForDisplay(THOUGHTS, "important");
    expect(result.map((t) => t.agentId)).toEqual(["b", "c", "d"]);
  });

  it("excludes continuous/ambient intents such as watching and hesitating from target=important", () => {
    const ambient: ThoughtBubbleDisplay[] = [
      { agentId: "x", text: "見守り中", isObserverJoiner: false, intent: "watching" },
      { agentId: "y", text: "迷っている", isObserverJoiner: false, intent: "hesitating" },
      { agentId: "z", text: "疲れてきた", isObserverJoiner: false, intent: "stressRising" },
    ];
    expect(filterThoughtsForDisplay(ambient, "important")).toEqual([]);
  });

  it("treats a thought with no isObserverJoiner/intent metadata as not matching observerJoiner/important filters", () => {
    const bare: ThoughtBubbleDisplay[] = [{ agentId: "e", text: "テスト" }];
    expect(filterThoughtsForDisplay(bare, "observerJoiner")).toEqual([]);
    expect(filterThoughtsForDisplay(bare, "important")).toEqual([]);
    expect(filterThoughtsForDisplay(bare, "all")).toEqual(bare);
  });

  it("returns an empty array unchanged for any target", () => {
    expect(filterThoughtsForDisplay([], "all")).toEqual([]);
    expect(filterThoughtsForDisplay([], "observerJoiner")).toEqual([]);
    expect(filterThoughtsForDisplay([], "important")).toEqual([]);
  });
});
