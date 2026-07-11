import type { ThoughtBubbleLayout } from "./thoughtBubbleLayout";

type Props = {
  layout: ThoughtBubbleLayout;
  /** observerJoinerの心の声かどうか。将来の発言吹き出しとの区別用クラスとは別軸のスタイル切り替え */
  isObserverJoiner?: boolean;
};

/**
 * `intent`ラベル(1文字目)を全角括弧で囲み、複数行にまたがる場合も開き括弧は先頭行、
 * 閉じ括弧は最終行にのみ付与する。括弧付き表示は「これは(発言ではなく)心の声である」ことを
 * 色やアイコンに頼らず伝えるための、視覚以外の手がかり。
 */
function bracketedLine(line: string, index: number, totalLines: number): string {
  const withOpen = index === 0 ? `（${line}` : line;
  return index === totalLines - 1 ? `${withOpen}）` : withOpen;
}

const TEXT_LINE_HEIGHT = 13;
const TEXT_TOP_OFFSET = 15;

/**
 * 心の声1件分の吹き出し。表示データ(text由来のlines)とanchor座標(既に画面内へ補正済みのlayout)
 * を受け取るだけのpresentational component。intentの解釈や文言生成はここでは行わない。
 * 思考バブル特有の「本体から離れた小さな丸が連なる」しっぽ + 点線枠 + 括弧付き文字列の3つで、
 * 通常の発言吹き出し(未実装、実線・矢羽根しっぽを想定)と視覚的に区別する。
 */
export function ThoughtBubble({ layout, isObserverJoiner = false }: Props) {
  const { boxX, boxY, boxWidth, boxHeight, lines, tailX, tailY } = layout;
  const centerX = boxX + boxWidth / 2;
  const boxBottomY = boxY + boxHeight;

  const trail1X = centerX + (tailX - centerX) * 0.6;
  const trail1Y = boxBottomY + (tailY - boxBottomY) * 0.45;
  const trail2X = centerX + (tailX - centerX) * 0.85;
  const trail2Y = boxBottomY + (tailY - boxBottomY) * 0.75;

  return (
    <g className={isObserverJoiner ? "thought-bubble observer" : "thought-bubble"}>
      <circle cx={trail2X} cy={trail2Y} r={2} className="thought-bubble-trail" />
      <circle cx={trail1X} cy={trail1Y} r={3.5} className="thought-bubble-trail" />
      <rect
        x={boxX}
        y={boxY}
        width={boxWidth}
        height={boxHeight}
        rx={9}
        ry={9}
        className="thought-bubble-box"
      />
      <text x={centerX} y={boxY + TEXT_TOP_OFFSET} textAnchor="middle" className="thought-bubble-text">
        {lines.map((line, index) => (
          <tspan key={index} x={centerX} dy={index === 0 ? 0 : TEXT_LINE_HEIGHT}>
            {bracketedLine(line, index, lines.length)}
          </tspan>
        ))}
      </text>
    </g>
  );
}
