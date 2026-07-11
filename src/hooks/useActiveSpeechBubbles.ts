import { useEffect, useRef, useState } from "react";
import type { SimulationState } from "../simulation/types";
import {
  applySpeechBubbleEvents,
  createActiveSpeechBubblesState,
  toSpeechBubbleCandidate,
  type ActiveSpeechBubblesState,
} from "../simulation/activeSpeechBubbles";
import { buildAgentLabelMap } from "../components/speechDisplay";
import { formatSpeechBubbleText } from "../components/speechBubbleFormat";
import type { SpeechBubbleDisplay } from "../components/SimulationCanvas";

/**
 * `SimulationState.speechLog`の変化からSpeechEvent候補を取り出し、寿命・競合・混雑制御
 * (`activeSpeechBubbles.ts`)を経てSimulationCanvasへ渡す表示リストへ変換する薄いReactラッパー。
 * `useActiveExpressions`と同じ設計方針(タイマー無し・tick駆動・resetKeyでの破棄)を採るが、
 * `speechLog`は既にtickタグ付き・確定済みのイベント列であり`ExpressionEvent`のような
 * (前後状態比較による)導出やテキストバリエーションのハッシュ選択が不要なため、
 * `simState.tick`に一致する`speechLog`要素をそのまま候補として使う分、実装は単純になる。
 *
 * Pause/Step/Replay(任意のtickのSimulationStateから表示を組み立てる場面全般)との整合性:
 * `speechLog`はtickごとに確定した記録であるため、ある`simState`が表す「現在tickの発言」は
 * 常に`speechLog.filter(e => e.tick === simState.tick)`から一意に導出できる。
 * どの経路でその`simState`に辿り着いたか(Step連打かStart/Pauseか)に依存しない。
 */
export type UseActiveSpeechBubblesOptions = {
  /** falseの間は候補抽出・競合制御を一切行わず、表示を空にする(表示設定「発言OFF」用) */
  enabled?: boolean;
  maxConcurrent?: number;
};

export type SpeechBubbleDisplayDriverState = {
  resetKey: unknown;
  prevSimState: SimulationState;
  bubbles: ActiveSpeechBubblesState;
  displayed: SpeechBubbleDisplay[];
};

export function createSpeechBubbleDisplayDriverState(
  simState: SimulationState,
  resetKey: unknown,
): SpeechBubbleDisplayDriverState {
  return { resetKey, prevSimState: simState, bubbles: createActiveSpeechBubblesState(), displayed: [] };
}

/**
 * `simState`/`resetKey`の変化を1回分だけ反映した新しいdriver状態を返す純粋関数。
 * 変化がない(Pause中の再呼び出し等)場合は`driver`をそのまま返す。
 */
export function advanceSpeechBubbleDisplay(
  driver: SpeechBubbleDisplayDriverState,
  simState: SimulationState,
  resetKey: unknown,
  options: UseActiveSpeechBubblesOptions = {},
): SpeechBubbleDisplayDriverState {
  const { enabled = true, maxConcurrent } = options;

  if (driver.resetKey !== resetKey) {
    return createSpeechBubbleDisplayDriverState(simState, resetKey);
  }

  // Pause中(simStateが変化していない)は何もしない。実時間だけで吹き出しが消えることはない。
  if (driver.prevSimState === simState) return driver;

  if (!enabled) {
    return {
      ...driver,
      prevSimState: simState,
      displayed: driver.displayed.length === 0 ? driver.displayed : [],
    };
  }

  const speechLog = simState.speechLog ?? [];
  const newEvents = speechLog.filter((event) => event.tick === simState.tick);

  const labelById = buildAgentLabelMap(simState.agents);
  const candidates = newEvents.map((event) => {
    const agent = simState.agents.find((a) => a.id === event.speakerId);
    const isObserverJoiner = agent?.isObserverJoiner ?? false;
    return toSpeechBubbleCandidate(event, formatSpeechBubbleText(event, labelById), isObserverJoiner);
  });

  const bubbles = applySpeechBubbleEvents(driver.bubbles, candidates, simState.tick, { maxConcurrent });
  const displayed = Array.from(bubbles.active.entries()).map(([agentId, bubble]) => ({
    agentId,
    text: bubble.text,
    isObserverJoiner: bubble.isObserverJoiner,
    intent: bubble.intent,
  }));

  return { resetKey, prevSimState: simState, bubbles, displayed };
}

export function useActiveSpeechBubbles(
  simState: SimulationState,
  resetKey: unknown,
  options: UseActiveSpeechBubblesOptions = {},
): SpeechBubbleDisplay[] {
  const { enabled, maxConcurrent } = options;
  const driverRef = useRef<SpeechBubbleDisplayDriverState>(
    createSpeechBubbleDisplayDriverState(simState, resetKey),
  );
  const [displayed, setDisplayed] = useState<SpeechBubbleDisplay[]>(driverRef.current.displayed);

  useEffect(() => {
    const next = advanceSpeechBubbleDisplay(driverRef.current, simState, resetKey, { enabled, maxConcurrent });
    if (next !== driverRef.current) {
      driverRef.current = next;
      setDisplayed(next.displayed);
    }
  }, [simState, resetKey, enabled, maxConcurrent]);

  return displayed;
}
