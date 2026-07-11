import { describe, expect, it } from "vitest";
import {
  getExpressionVariantCount,
  resolveExpressionEventText,
  resolveExpressionText,
  resolveExpressionVariants,
} from "./expressionTemplates";
import type { ExpressionEvent, ExpressionReason } from "./expression";

const ALL_REASONS: ExpressionReason[] = [
  "initiativeFormedCore",
  "cliqueFormedCore",
  "approachedFormingGroup",
  "approachedConfirmedGroup",
  "arrivedAtFormingGroup",
  "arrivedAtConfirmedGroup",
  "ambiguityStressExceeded",
  "reachedScreenEdge",
  "receivedLightInvitation",
  "stressCrossedRisingThreshold",
  "stressNearLeaveThreshold",
  "nearbyGroupUnapproached",
  "noJoinableGroupNearby",
];

describe("expressionTemplates: coverage", () => {
  it("has at least one non-empty variant for every ExpressionReason, both general and observerJoiner", () => {
    for (const reason of ALL_REASONS) {
      expect(resolveExpressionVariants(reason, false).length).toBeGreaterThan(0);
      expect(resolveExpressionVariants(reason, true).length).toBeGreaterThan(0);
    }
  });

  it("keeps every template short enough to read inside a speech bubble", () => {
    for (const reason of ALL_REASONS) {
      for (const isObserverJoiner of [false, true]) {
        for (const text of resolveExpressionVariants(reason, isObserverJoiner)) {
          expect(text.length).toBeLessThanOrEqual(40);
        }
      }
    }
  });
});

describe("expressionTemplates: general vs observerJoiner distinction", () => {
  it("falls back to the general variants when a reason has no observerJoiner override", () => {
    const general = resolveExpressionVariants("initiativeFormedCore", false);
    const observerJoiner = resolveExpressionVariants("initiativeFormedCore", true);
    expect(observerJoiner).toEqual(general);
  });

  it("uses observerJoiner-specific wording for reasons that define an override", () => {
    const general = resolveExpressionVariants("ambiguityStressExceeded", false);
    const observerJoiner = resolveExpressionVariants("ambiguityStressExceeded", true);
    expect(observerJoiner).not.toEqual(general);
  });
});

describe("getExpressionVariantCount / resolveExpressionText", () => {
  it("getExpressionVariantCount matches the resolved variants array length", () => {
    for (const reason of ALL_REASONS) {
      expect(getExpressionVariantCount(reason, false)).toBe(resolveExpressionVariants(reason, false).length);
      expect(getExpressionVariantCount(reason, true)).toBe(resolveExpressionVariants(reason, true).length);
    }
  });

  it("resolveExpressionText returns the variant at the given index", () => {
    const variants = resolveExpressionVariants("nearbyGroupUnapproached", false);
    expect(resolveExpressionText("nearbyGroupUnapproached", false, 0)).toBe(variants[0]);
  });

  it("resolveExpressionText wraps out-of-range indices instead of throwing", () => {
    const variants = resolveExpressionVariants("nearbyGroupUnapproached", false);
    expect(resolveExpressionText("nearbyGroupUnapproached", false, variants.length)).toBe(variants[0]);
  });
});

describe("resolveExpressionEventText", () => {
  function makeEvent(overrides: Partial<ExpressionEvent>): ExpressionEvent {
    return {
      id: "expr-1-agent-a-watching",
      tick: 1,
      agentId: "agent-a",
      kind: "thought",
      intent: "watching",
      reason: "noJoinableGroupNearby",
      textKey: "thought.noJoinableGroupNearby.v0",
      priority: 1,
      recommendedTtlTicks: 12,
      ...overrides,
    };
  }

  it("extracts the variant index from textKey and resolves the matching text", () => {
    const variants = resolveExpressionVariants("noJoinableGroupNearby", false);
    const event = makeEvent({ textKey: "thought.noJoinableGroupNearby.v1" });
    expect(resolveExpressionEventText(event, false)).toBe(variants[1]);
  });

  it("uses observerJoiner wording when isObserverJoiner is true", () => {
    const observerVariants = resolveExpressionVariants("ambiguityStressExceeded", true);
    const event = makeEvent({ reason: "ambiguityStressExceeded", textKey: "thought.ambiguityStressExceeded.v0" });
    expect(resolveExpressionEventText(event, true)).toBe(observerVariants[0]);
  });

  it("falls back to variant 0 when textKey has no trailing variant number", () => {
    const variants = resolveExpressionVariants("noJoinableGroupNearby", false);
    const event = makeEvent({ textKey: "thought.noJoinableGroupNearby" });
    expect(resolveExpressionEventText(event, false)).toBe(variants[0]);
  });
});
