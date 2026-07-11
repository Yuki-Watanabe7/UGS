import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import appCss from "../App.css?raw";
import { SpeechBubble } from "./SpeechBubble";
import { computeThoughtBubbleLayout } from "./thoughtBubbleLayout";

describe("SpeechBubble", () => {
  const layout = computeThoughtBubbleLayout({
    agentX: 400,
    agentY: 260,
    agentRadius: 9,
    text: "💬こっちも一緒にどう?",
    canvasWidth: 800,
    canvasHeight: 520,
  });

  it("renders a solid-outline bubble shape with an arrow tail, distinct from ThoughtBubble's dashed box/dot trail", () => {
    const html = renderToStaticMarkup(createElement(SpeechBubble, { layout }));
    expect(html).toContain("speech-bubble-box");
    expect(html).toContain("speech-bubble-tail");
    expect(html).not.toContain("thought-bubble");
  });

  it("does not wrap text in full-width brackets (that marker is reserved for thoughts)", () => {
    const html = renderToStaticMarkup(createElement(SpeechBubble, { layout }));
    expect(html).not.toContain("（");
    expect(html).not.toContain("）");
  });

  it("renders the pre-formatted speech icon text as-is", () => {
    const html = renderToStaticMarkup(createElement(SpeechBubble, { layout }));
    expect(html).toContain("💬");
  });

  it("applies the observer style class only when isObserverJoiner is true", () => {
    const observerHtml = renderToStaticMarkup(createElement(SpeechBubble, { layout, isObserverJoiner: true }));
    const generalHtml = renderToStaticMarkup(createElement(SpeechBubble, { layout, isObserverJoiner: false }));
    expect(observerHtml).toContain("speech-bubble observer");
    expect(generalHtml).not.toContain("observer");
  });

  it("renders one tspan per wrapped line", () => {
    const longLayout = computeThoughtBubbleLayout({
      agentX: 400,
      agentY: 260,
      agentRadius: 9,
      text: `💬${"あ".repeat(30)}`,
      canvasWidth: 800,
      canvasHeight: 520,
    });
    const html = renderToStaticMarkup(createElement(SpeechBubble, { layout: longLayout }));
    const tspanCount = html.split("<tspan").length - 1;
    expect(tspanCount).toBe(longLayout.lines.length);
    expect(longLayout.lines.length).toBeGreaterThan(1);
  });

  it("does not set an inline font-size (text size is controlled only by the fixed .speech-bubble-text CSS class)", () => {
    const html = renderToStaticMarkup(createElement(SpeechBubble, { layout }));
    expect(html).not.toMatch(/font-size/);
  });

  it("App.css defines a fixed absolute font-size for .speech-bubble-text (not a viewport-relative unit that could shrink on narrow screens)", () => {
    const match = /\.speech-bubble-text\s*\{[^}]*font-size:\s*([^;]+);/.exec(appCss);
    expect(match).not.toBeNull();
    const fontSize = match![1].trim();
    expect(fontSize).toMatch(/^\d+(\.\d+)?px$/);
    expect(Number.parseFloat(fontSize)).toBeGreaterThanOrEqual(9);
  });
});
