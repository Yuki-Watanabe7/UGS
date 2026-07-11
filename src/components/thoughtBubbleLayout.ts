/**
 * 心の声吹き出しの、テキスト折り返しと画面内配置(はみ出し補正)を計算する純粋関数群。
 * SimulationCanvasのSVG座標系(state.width/height, agent.x/y)にそのまま乗る値を返す前提で、
 * DOM計測(getBoundingClientRect等)には依存しない。エージェントの日本語一人称的な短文が
 * スペースを含まない前提のため、折り返しは文字数ベースの単純な等幅換算で行う。
 */

const MAX_CHARS_PER_LINE = 10;
const MAX_LINES = 3;
const CHAR_WIDTH_PX = 7;
const LINE_HEIGHT_PX = 13;
const PADDING_X_PX = 8;
const PADDING_Y_PX = 7;
const MAX_BUBBLE_WIDTH_PX = 140;
/** Canvas端からの最小マージン */
const EDGE_MARGIN_PX = 6;
/** 吹き出し下端とエージェント本体(円)の間の隙間。agent-labelがagent.y - r - 4付近に描画されるため、
 * それより上に出るだけの余白を確保する */
const GAP_ABOVE_AGENT_PX = 20;

export type ThoughtBubbleLayout = {
  boxX: number;
  boxY: number;
  boxWidth: number;
  boxHeight: number;
  lines: string[];
  /** 吹き出しが実際に指し示すべきエージェント上の座標(しっぽの先端) */
  tailX: number;
  tailY: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * テキストを`maxCharsPerLine`ごとに折り返し、`maxLines`を超える場合は末尾を省略記号で切り詰める。
 * 空文字列を渡された場合は1行の空文字列を返す(呼び出し側で0行を特別扱いしなくてよいように)。
 */
export function wrapThoughtText(
  text: string,
  maxCharsPerLine: number = MAX_CHARS_PER_LINE,
  maxLines: number = MAX_LINES,
): string[] {
  const totalMaxChars = maxCharsPerLine * maxLines;
  const truncated = text.length > totalMaxChars;
  const source = truncated ? `${text.slice(0, Math.max(totalMaxChars - 1, 0))}…` : text;

  const lines: string[] = [];
  for (let i = 0; i < source.length; i += maxCharsPerLine) {
    lines.push(source.slice(i, i + maxCharsPerLine));
  }
  return lines.length > 0 ? lines : [""];
}

export type ThoughtBubbleLayoutInput = {
  agentX: number;
  agentY: number;
  agentRadius: number;
  text: string;
  canvasWidth: number;
  canvasHeight: number;
};

/**
 * エージェント座標を起点に、Canvas外へはみ出しにくい吹き出し位置を計算する。
 * 基本方針は「エージェントの真上」。上に十分な余白がなければ下側に配置し、
 * 左右/上下の端はCanvas内に収まるようクランプする(それでも入りきらない極端なケースでは
 * 吹き出しがエージェントから離れうるため、tailX/tailYで常に実座標を指し示す)。
 */
export function computeThoughtBubbleLayout({
  agentX,
  agentY,
  agentRadius,
  text,
  canvasWidth,
  canvasHeight,
}: ThoughtBubbleLayoutInput): ThoughtBubbleLayout {
  const lines = wrapThoughtText(text);
  const longestLine = Math.max(...lines.map((line) => line.length), 1);
  const boxWidth = Math.min(MAX_BUBBLE_WIDTH_PX, PADDING_X_PX * 2 + longestLine * CHAR_WIDTH_PX);
  const boxHeight = PADDING_Y_PX * 2 + lines.length * LINE_HEIGHT_PX;

  const preferredAboveY = agentY - agentRadius - GAP_ABOVE_AGENT_PX - boxHeight;
  const placeAbove = preferredAboveY >= EDGE_MARGIN_PX;
  const boxY = placeAbove
    ? clamp(preferredAboveY, EDGE_MARGIN_PX, canvasHeight - EDGE_MARGIN_PX - boxHeight)
    : clamp(agentY + agentRadius + GAP_ABOVE_AGENT_PX, EDGE_MARGIN_PX, canvasHeight - EDGE_MARGIN_PX - boxHeight);
  const boxX = clamp(agentX - boxWidth / 2, EDGE_MARGIN_PX, canvasWidth - EDGE_MARGIN_PX - boxWidth);

  return {
    boxX,
    boxY,
    boxWidth,
    boxHeight,
    lines,
    tailX: agentX,
    tailY: agentY - agentRadius,
  };
}
