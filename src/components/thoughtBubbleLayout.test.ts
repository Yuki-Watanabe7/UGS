import { describe, expect, it } from "vitest";
import { computeThoughtBubbleLayout, computeThoughtBubbleLayouts, wrapThoughtText } from "./thoughtBubbleLayout";

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

  it("places to the left of the agent and points its tail at the agent's left edge when side is 'left'", () => {
    const layout = computeThoughtBubbleLayout(baseInput, "left");
    expect(layout.boxX + layout.boxWidth).toBeLessThanOrEqual(baseInput.agentX);
    expect(layout.tailX).toBe(baseInput.agentX - baseInput.agentRadius);
    expect(layout.tailY).toBe(baseInput.agentY);
  });

  it("places to the right of the agent and points its tail at the agent's right edge when side is 'right'", () => {
    const layout = computeThoughtBubbleLayout(baseInput, "right");
    expect(layout.boxX).toBeGreaterThanOrEqual(baseInput.agentX);
    expect(layout.tailX).toBe(baseInput.agentX + baseInput.agentRadius);
    expect(layout.tailY).toBe(baseInput.agentY);
  });

  it("forces placement below the agent when side is 'below', even when there is room above", () => {
    const layout = computeThoughtBubbleLayout(baseInput, "below");
    expect(layout.boxY).toBeGreaterThan(baseInput.agentY);
  });
});

describe("computeThoughtBubbleLayouts", () => {
  const canvasWidth = 800;
  const canvasHeight = 520;

  function boxesOverlap(a: { boxX: number; boxY: number; boxWidth: number; boxHeight: number }, b: typeof a): boolean {
    return (
      a.boxX < b.boxX + b.boxWidth &&
      a.boxX + a.boxWidth > b.boxX &&
      a.boxY < b.boxY + b.boxHeight &&
      a.boxY + a.boxHeight > b.boxY
    );
  }

  it("returns one layout per input, keyed by agentId", () => {
    const layouts = computeThoughtBubbleLayouts([
      { agentId: "a", agentX: 400, agentY: 260, agentRadius: 9, text: "あ", canvasWidth, canvasHeight },
      { agentId: "b", agentX: 420, agentY: 260, agentRadius: 9, text: "い", canvasWidth, canvasHeight },
    ]);
    expect(layouts.size).toBe(2);
    expect(layouts.has("a")).toBe(true);
    expect(layouts.has("b")).toBe(true);
  });

  it("avoids overlapping boxes for two agents standing right next to each other", () => {
    const layouts = computeThoughtBubbleLayouts([
      { agentId: "a", agentX: 400, agentY: 260, agentRadius: 9, text: "近くに輪が見当たらないな", canvasWidth, canvasHeight },
      { agentId: "b", agentX: 415, agentY: 260, agentRadius: 9, text: "そろそろ潮時かもしれない", canvasWidth, canvasHeight },
    ]);
    const [a, b] = ["a", "b"].map((id) => layouts.get(id)!);
    expect(boxesOverlap(a, b)).toBe(false);
  });

  it("still returns a layout for every agent even when many are clustered together (may fall back to overlapping)", () => {
    const inputs = Array.from({ length: 5 }, (_, i) => ({
      agentId: `agent-${i}`,
      agentX: 400 + i * 2,
      agentY: 260,
      agentRadius: 9,
      text: "テスト",
      canvasWidth,
      canvasHeight,
    }));
    const layouts = computeThoughtBubbleLayouts(inputs);
    expect(layouts.size).toBe(5);
  });

  it("gives earlier entries first pick, so a later entry yields to an already-placed earlier one", () => {
    const layouts = computeThoughtBubbleLayouts([
      { agentId: "priority", agentX: 400, agentY: 260, agentRadius: 9, text: "重要な心の声", canvasWidth, canvasHeight },
      { agentId: "other", agentX: 405, agentY: 260, agentRadius: 9, text: "その他の心の声", canvasWidth, canvasHeight },
    ]);
    const priorityDefault = computeThoughtBubbleLayout({
      agentX: 400,
      agentY: 260,
      agentRadius: 9,
      text: "重要な心の声",
      canvasWidth,
      canvasHeight,
    });
    expect(layouts.get("priority")).toEqual(priorityDefault);
  });
});

/**
 * Issue #67「レスポンシブ・アクセシビリティ確認」の受入テスト。
 * PC想定幅とiPhone想定幅(iPhone SEクラスの狭い幅も含む)でCanvas端の吹き出し位置補正を検証し、
 * 横スクロールの原因になる「Canvas幅を超えるはみ出し」が発生しないことを確認する。
 */
describe("responsive: PC / iPhone想定幅での吹き出し位置補正", () => {
  const VIEWPORTS = [
    { label: "PC (1200x800)", canvasWidth: 1200, canvasHeight: 800 },
    { label: "iPhone想定 (390x844)", canvasWidth: 390, canvasHeight: 844 },
    { label: "iPhone SEクラスの狭い幅 (320x568)", canvasWidth: 320, canvasHeight: 568 },
  ];

  for (const viewport of VIEWPORTS) {
    describe(viewport.label, () => {
      it("エージェントがCanvas内のどこにいても、吹き出しがCanvas幅を横方向にはみ出さない(横スクロール要因を作らない)", () => {
        const sampleXs = [
          2,
          viewport.canvasWidth * 0.25,
          viewport.canvasWidth * 0.5,
          viewport.canvasWidth * 0.75,
          viewport.canvasWidth - 2,
        ];
        for (const agentX of sampleXs) {
          const layout = computeThoughtBubbleLayout({
            agentX,
            agentY: viewport.canvasHeight / 2,
            agentRadius: 9,
            text: "そろそろ潮時かもしれない",
            canvasWidth: viewport.canvasWidth,
            canvasHeight: viewport.canvasHeight,
          });
          expect(layout.boxX).toBeGreaterThanOrEqual(0);
          expect(layout.boxX + layout.boxWidth).toBeLessThanOrEqual(viewport.canvasWidth);
        }
      });

      it("エージェントがCanvas内のどこにいても、吹き出しが縦方向にもCanvas範囲内に収まる", () => {
        const sampleYs = [2, viewport.canvasHeight * 0.5, viewport.canvasHeight - 2];
        for (const agentY of sampleYs) {
          const layout = computeThoughtBubbleLayout({
            agentX: viewport.canvasWidth / 2,
            agentY,
            agentRadius: 9,
            text: "近くに輪が見当たらないな",
            canvasWidth: viewport.canvasWidth,
            canvasHeight: viewport.canvasHeight,
          });
          expect(layout.boxY).toBeGreaterThanOrEqual(0);
          expect(layout.boxY + layout.boxHeight).toBeLessThanOrEqual(viewport.canvasHeight);
        }
      });

      it("最大文字数の吹き出しでもCanvas幅を超えない(最大吹き出し幅がどのビューポートより十分小さいこと)", () => {
        const layout = computeThoughtBubbleLayout({
          agentX: viewport.canvasWidth / 2,
          agentY: viewport.canvasHeight / 2,
          agentRadius: 9,
          text: "あ".repeat(50),
          canvasWidth: viewport.canvasWidth,
          canvasHeight: viewport.canvasHeight,
        });
        expect(layout.boxWidth).toBeLessThan(viewport.canvasWidth);
      });
    });
  }
});
