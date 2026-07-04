import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MonteCarloPanel } from "./MonteCarloPanel";
import { isSameCondition, isValidRunCount } from "./monteCarloPanelHelpers";
import { DEFAULT_PARAMS } from "../simulation/presets";
import type { SimParams } from "../simulation/types";

describe("isValidRunCount", () => {
  it("rejects zero and negative counts", () => {
    expect(isValidRunCount(0)).toBe(false);
    expect(isValidRunCount(-5)).toBe(false);
  });

  it("rejects counts above the recommended upper bound", () => {
    expect(isValidRunCount(101)).toBe(false);
  });

  it("rejects non-integer counts", () => {
    expect(isValidRunCount(1.5)).toBe(false);
    expect(isValidRunCount(Number.NaN)).toBe(false);
  });

  it("accepts counts within [1, 100]", () => {
    expect(isValidRunCount(1)).toBe(true);
    expect(isValidRunCount(30)).toBe(true);
    expect(isValidRunCount(100)).toBe(true);
  });
});

describe("isSameCondition", () => {
  const base = { presetId: "natural", seed: 1, params: DEFAULT_PARAMS, interventionId: "none" as const };

  it("treats identical preset/seed/params/intervention as the same condition", () => {
    expect(isSameCondition(base, { ...base, params: { ...DEFAULT_PARAMS } })).toBe(true);
  });

  it("detects a changed seed", () => {
    expect(isSameCondition(base, { ...base, seed: 2 })).toBe(false);
  });

  it("detects a changed preset", () => {
    expect(isSameCondition(base, { ...base, presetId: "strong-leader" })).toBe(false);
  });

  it("detects a changed param value", () => {
    const changedParams: SimParams = { ...DEFAULT_PARAMS, overallWillingness: 0.99 };
    expect(isSameCondition(base, { ...base, params: changedParams })).toBe(false);
  });

  it("detects a changed intervention", () => {
    expect(isSameCondition(base, { ...base, interventionId: "late-join-ok" })).toBe(false);
  });
});

describe("MonteCarloPanel", () => {
  it("renders the empty state before any run has been executed", () => {
    const html = renderToStaticMarkup(
      createElement(MonteCarloPanel, {
        presetId: "natural",
        params: DEFAULT_PARAMS,
        seed: 12345,
        interventionId: "none",
        singleSimRunning: false,
        onBeforeRun: () => {},
      }),
    );

    expect(html).toContain("現在の条件でMonte Carloを実行すると、確率的傾向を確認できます。");
    expect(html).not.toContain("monte-carlo-stale");
  });

  it("shows a note that the single simulation will pause when it is currently running", () => {
    const html = renderToStaticMarkup(
      createElement(MonteCarloPanel, {
        presetId: "natural",
        params: DEFAULT_PARAMS,
        seed: 12345,
        interventionId: "none",
        singleSimRunning: true,
        onBeforeRun: () => {},
      }),
    );

    expect(html).toContain("単発シミュレーションは一時停止します");
  });
});
