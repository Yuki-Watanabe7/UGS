import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import appCss from "../App.css?raw";
import { ThoughtBubble } from "./ThoughtBubble";
import { computeThoughtBubbleLayout } from "./thoughtBubbleLayout";

describe("ThoughtBubble", () => {
  const layout = computeThoughtBubbleLayout({
    agentX: 400,
    agentY: 260,
    agentRadius: 9,
    text: "そろそろ潮時かもしれない",
    canvasWidth: 800,
    canvasHeight: 520,
  });

  it("wraps the resolved text in full-width brackets to mark it as a thought, not speech", () => {
    const html = renderToStaticMarkup(createElement(ThoughtBubble, { layout }));
    expect(html).toContain("（");
    expect(html).toContain("）");
  });

  it("renders a dashed-outline bubble shape distinct from a plain label", () => {
    const html = renderToStaticMarkup(createElement(ThoughtBubble, { layout }));
    expect(html).toContain("thought-bubble-box");
    expect(html).toContain("thought-bubble-trail");
  });

  it("applies the observer style class only when isObserverJoiner is true", () => {
    const observerHtml = renderToStaticMarkup(createElement(ThoughtBubble, { layout, isObserverJoiner: true }));
    const generalHtml = renderToStaticMarkup(createElement(ThoughtBubble, { layout, isObserverJoiner: false }));
    expect(observerHtml).toContain("thought-bubble observer");
    expect(generalHtml).not.toContain("observer");
  });

  it("renders one tspan per wrapped line", () => {
    const longLayout = computeThoughtBubbleLayout({
      agentX: 400,
      agentY: 260,
      agentRadius: 9,
      text: "あ".repeat(30),
      canvasWidth: 800,
      canvasHeight: 520,
    });
    const html = renderToStaticMarkup(createElement(ThoughtBubble, { layout: longLayout }));
    const tspanCount = html.split("<tspan").length - 1;
    expect(tspanCount).toBe(longLayout.lines.length);
    expect(longLayout.lines.length).toBeGreaterThan(1);
  });

  it("does not set an inline font-size (text size is controlled only by the fixed .thought-bubble-text CSS class, not shrunk dynamically)", () => {
    // Issue #67「文字が極端に小さくならない」: レイアウト計算(canvasWidth等)に応じてfont-sizeを
    // 動的に縮小するロジックが混入していないことを保証する回帰ガード
    const html = renderToStaticMarkup(createElement(ThoughtBubble, { layout }));
    expect(html).not.toMatch(/font-size/);
  });

  it("App.css defines a fixed absolute font-size for .thought-bubble-text (not a viewport-relative unit that could shrink on narrow screens)", () => {
    const match = /\.thought-bubble-text\s*\{[^}]*font-size:\s*([^;]+);/.exec(appCss);
    expect(match).not.toBeNull();
    const fontSize = match![1].trim();
    expect(fontSize).toMatch(/^\d+(\.\d+)?px$/);
    expect(Number.parseFloat(fontSize)).toBeGreaterThanOrEqual(9);
  });
});
