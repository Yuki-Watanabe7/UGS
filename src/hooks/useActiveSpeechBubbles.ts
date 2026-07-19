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
import { resolveDivergentExpression } from "../simulation/divergenceTemplates";
import type { SpeechBubbleDisplay } from "../components/SimulationCanvas";
import type { FormationScenarioId } from "../simulation/formationPolicy";

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
  /**
   * Issue #119: 乖離場面の本心(心の声)側文言を決定的に選ぶための種・プリセット。
   * `resolveDivergentExpression`(divergenceTemplates.ts)へ渡す。省略時は本心オーバーレイを付与しない
   * (本体`SeededRandom`とは独立であり、表示にのみ影響する)。
   */
  seed?: number;
  presetId?: string;
  scenarioId?: FormationScenarioId;
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
  const { enabled = true, maxConcurrent, seed, presetId, scenarioId } = options;

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
    // Issue #119: 乖離発言なら本心(建前=発言文言と対になる心の声)を決定的に導出してオーバーレイに使う。
    // seed/presetId未指定、または非乖離発言ではundefined(=本心オーバーレイなし)。
    const innerThought =
      agent && event.expression && seed !== undefined && presetId !== undefined
        ? resolveDivergentExpression({
            link: event.expression,
            intent: event.intent,
            agent,
            presetId,
            seed,
            tick: event.tick,
            scenarioId,
          })?.thought
        : undefined;
    return toSpeechBubbleCandidate(
      event,
      formatSpeechBubbleText(
        event,
        labelById,
        agent && seed !== undefined && presetId !== undefined
          ? { agent, seed, presetId, scenarioId }
          : undefined,
      ),
      isObserverJoiner,
      innerThought,
    );
  });

  const bubbles = applySpeechBubbleEvents(driver.bubbles, candidates, simState.tick, { maxConcurrent });
  const displayed = Array.from(bubbles.active.entries()).map(([agentId, bubble]) => ({
    agentId,
    text: bubble.text,
    isObserverJoiner: bubble.isObserverJoiner,
    intent: bubble.intent,
    innerThought: bubble.innerThought,
  }));

  return { resetKey, prevSimState: simState, bubbles, displayed };
}

export function useActiveSpeechBubbles(
  simState: SimulationState,
  resetKey: unknown,
  options: UseActiveSpeechBubblesOptions = {},
): SpeechBubbleDisplay[] {
  const { enabled, maxConcurrent, seed, presetId, scenarioId } = options;
  const driverRef = useRef<SpeechBubbleDisplayDriverState>(
    createSpeechBubbleDisplayDriverState(simState, resetKey),
  );
  const [displayed, setDisplayed] = useState<SpeechBubbleDisplay[]>(driverRef.current.displayed);

  useEffect(() => {
    const next = advanceSpeechBubbleDisplay(driverRef.current, simState, resetKey, {
      enabled,
      maxConcurrent,
      seed,
      presetId,
      scenarioId,
    });
    if (next !== driverRef.current) {
      driverRef.current = next;
      setDisplayed(next.displayed);
    }
  }, [simState, resetKey, enabled, maxConcurrent, seed, presetId, scenarioId]);

  return displayed;
}
