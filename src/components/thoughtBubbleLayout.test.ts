import { describe, expect, it } from "vitest";
import { computeThoughtBubbleLayout, wrapThoughtText } from "./thoughtBubbleLayout";

describe("wrapThoughtText", () => {
  it("returns the whole text as a single line when it fits within one line", () => {
    expect(wrapThoughtText("よし、声をかけてみよう", 12, 3)).toEqual(["よし、声をかけてみよう"]);
  });

  it("splits text longer than one line into multiple lines without dropping characters", () => {
    const lines = wrapThoughtText("これ以上待つのはやめておこう", 10, 3);
    expect(lines.join("")).toBe("これ以上待つのはやめておこう");
    expect(lines.every((line) => line.length <= 10)).toBe(true);
  });

  it("truncates text that would exceed maxLines and appends an ellipsis", () => {
    const longText = "あ".repeat(50);
    const lines = wrapThoughtText(longText, 10, 3);
    expect(lines).toHaveLength(3);
    expect(lines[2].endsWith("…")).toBe(true);
    expect(lines.join("").length).toBe(30);
  });

  it("returns a single empty line for empty input instead of an empty array", () => {
    expect(wrapThoughtText("", 10, 3)).toEqual([""]);
  });
});

describe("computeThoughtBubbleLayout", () => {
  const baseInput = {
    agentX: 400,
    agentY: 260,
    agentRadius: 9,
    text: "近くに輪が見当たらないな",
    canvasWidth: 800,
    canvasHeight: 520,
  };

  it("places the bubble above the agent and always points its tail at the agent's exact position", () => {
    const layout = computeThoughtBubbleLayout(baseInput);
    expect(layout.tailX).toBe(baseInput.agentX);
    expect(layout.tailY).toBe(baseInput.agentY - baseInput.agentRadius);
    expect(layout.boxY + layout.boxHeight).toBeLessThan(baseInput.agentY - baseInput.agentRadius);
  });

  it("keeps the bubble within the canvas bounds when the agent is near the left edge", () => {
    const layout = computeThoughtBubbleLayout({ ...baseInput, agentX: 2 });
    expect(layout.boxX).toBeGreaterThanOrEqual(0);
  });

  it("keeps the bubble within the canvas bounds when the agent is near the right edge", () => {
    const layout = computeThoughtBubbleLayout({ ...baseInput, agentX: baseInput.canvasWidth - 2 });
    expect(layout.boxX + layout.boxWidth).toBeLessThanOrEqual(baseInput.canvasWidth);
  });

  it("flips the bubble below the agent when there is no room above (agent near the top edge)", () => {
    const agentY = 5;
    const layout = computeThoughtBubbleLayout({ ...baseInput, agentY });
    expect(layout.boxY).toBeGreaterThan(agentY);
    expect(layout.boxY).toBeGreaterThanOrEqual(0);
  });

  it("caps the bubble width so long text does not stretch it unbounded", () => {
    const layout = computeThoughtBubbleLayout({ ...baseInput, text: "あ".repeat(50) });
    expect(layout.boxWidth).toBeLessThanOrEqual(140);
  });
});
