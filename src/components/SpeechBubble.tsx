import type { ThoughtBubbleLayout } from "./thoughtBubbleLayout";

type Props = {
  layout: ThoughtBubbleLayout;
  /** observerJoinerによる発言かどうか。心の声側の`isObserverJoiner`スタイル切り替えと同じ軸 */
  isObserverJoiner?: boolean;
};

const TEXT_LINE_HEIGHT = 13;
const TEXT_TOP_OFFSET = 15;

/**
 * 発言(`SpeechEvent`)1件分の吹き出し。表示データ(text由来のlines)とanchor座標
 * (既に画面内へ補正済みのlayout)を受け取るだけのpresentational component。
 *
 * `ThoughtBubble`(心の声)との視覚的な区別は、色だけに頼らず3つの手がかりを重ねる:
 * - 枠線: 実線(`ThoughtBubble`は点線)
 * - しっぽ: 三角形の矢羽根(`ThoughtBubble`は本体から離れた丸の連なり)
 * - テキスト: 括弧で囲まない代わりに💬アイコンを先頭に置く(`text`側で組み立て済み。
 *   `speechBubbleFormat.ts`参照)。これは他エージェントに認知される実際の発言であり、
 *   観察者にしか見えない心の声とは異なることを示す。
 */
export function SpeechBubble({ layout, isObserverJoiner = false }: Props) {
  const { boxX, boxY, boxWidth, boxHeight, lines, tailX, tailY } = layout;
  const centerX = boxX + boxWidth / 2;
  const boxBottomY = boxY + boxHeight;

  const tailDirX = tailX - centerX;
  const tailDirY = tailY - boxBottomY;
  const tailBaseLeftX = centerX - 5 + tailDirX * 0.08;
  const tailBaseRightX = centerX + 5 + tailDirX * 0.08;
  const tailBaseY = boxBottomY + tailDirY * 0.08;

  return (
    <g className={isObserverJoiner ? "speech-bubble observer" : "speech-bubble"}>
      <polygon
        points={`${tailBaseLeftX},${tailBaseY} ${tailBaseRightX},${tailBaseY} ${tailX},${tailY}`}
        className="speech-bubble-tail"
      />
      <rect x={boxX} y={boxY} width={boxWidth} height={boxHeight} rx={6} ry={6} className="speech-bubble-box" />
      <text x={centerX} y={boxY + TEXT_TOP_OFFSET} textAnchor="middle" className="speech-bubble-text">
        {lines.map((line, index) => (
          <tspan key={index} x={centerX} dy={index === 0 ? 0 : TEXT_LINE_HEIGHT}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
}
