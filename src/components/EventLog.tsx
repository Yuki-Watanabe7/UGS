import { useEffect, useMemo, useRef, useState } from "react";
import type { LogTag, SimulationState } from "../simulation/types";
import type { SpeechEvent } from "../simulation/speech";
import type { ExpressedStance, DivergenceFactor } from "../simulation/socialExpression";
import { classifyDivergenceScene, DIVERGENCE_SCENE_FACTOR } from "../simulation/socialExpression";
import { buildAgentLabelMap, formatSpeechDebugMeta, formatSpeechLogMessage } from "./speechDisplay";
import { formatEffectLine, formatInterpretationFactorLine, formatInterpretationLine } from "./speechEffectsDisplay";
import type { ScenarioPresentation } from "../presentation/scenarioPresentation";
import {
  AFTER_PARTY_PRESENTATION,
  resolveScenarioLogMessage,
} from "../presentation/scenarioPresentation";

type FilterKey =
  | "all"
  | "observerJoiner"
  | "nucleus"
  | "groupConfirmed"
  | "joinFailure"
  | "unassigned"
  | "leave"
  | "speech"
  | "speechEffect"
  | "divergence"
  | "trust"
  | "tie";

function filtersForPresentation(
  presentation: ScenarioPresentation,
): Array<{ key: FilterKey; label: string; tag?: LogTag }> {
  const filters: Array<{ key: FilterKey; label: string; tag?: LogTag }> = [
    { key: "all", label: "全ログ" },
    {
      key: "observerJoiner",
      label: presentation.id === "classroomPair" ? "待ちやすい生徒のみ" : "observerJoinerのみ",
      tag: "observerJoiner",
    },
    { key: "nucleus", label: presentation.eventLog.nucleusFilter, tag: "nucleus" },
    { key: "groupConfirmed", label: presentation.eventLog.confirmedFilter, tag: "groupConfirmed" },
    { key: "joinFailure", label: presentation.eventLog.joinFailureFilter, tag: "joinFailure" },
    { key: "unassigned", label: "未割当確定のみ", tag: "unassigned" },
    { key: "speech", label: "発言のみ" },
    { key: "speechEffect", label: "発言効果のみ" },
    { key: "divergence", label: "乖離発言のみ" },
    { key: "trust", label: "信頼更新のみ" },
    { key: "tie", label: "関係性変化のみ" },
  ];
  if (presentation.eventLog.showLeaveFilter) {
    filters.splice(6, 0, { key: "leave", label: presentation.eventLog.leaveFilter, tag: "leave" });
  }
  return filters;
}

const STANCE_LABEL: Record<ExpressedStance, string> = { positive: "積極的", none: "無表明", negative: "消極的" };
const FACTOR_LABEL: Record<DivergenceFactor, string> = { reserve: "遠慮", conformity: "同調", impression: "社交辞令" };
const OBSERVATION_LABEL: Record<"consistent" | "inconsistent", string> = { consistent: "一致", inconsistent: "不一致" };

// 発言効果(解釈/効果)の行が一度に大量になっても操作を妨げないよう、既定では末尾からこの件数だけ表示する
// (Issue #98の受入条件: 「長い履歴の折りたたみ・件数上限等を設け、既存観察UIを妨げない」)。
const ROW_DISPLAY_LIMIT = 200;

/**
 * 状態ログ(検証可能な出来事の記録)・発言ログ(`SpeechEvent`)・Phase 3の解釈/効果ログを
 * tick順にまとめた1行分の表示データ。`kind`で由来を判別できるようにし、発言/発言効果側には
 * 表示文言と別に構造化属性を確認できる補足行(meta)を持たせる(Issue #81/#98: 心の声/通常状態ログ/
 * 発言/発言効果をログ上で区別できることが目的)。認知(`SpeechReceptionEvent`)は、圏外を含め
 * 全agentに対して生成されうるため件数が跳ね上がりやすく、この時系列には含めない
 * (観察者ごとの認知/非認知の詳細はObserverJoinerInspector側で確認する)。
 */
type TimelineRow =
  | { kind: "state"; key: string; tick: number; message: string; tags: LogTag[] }
  | { kind: "speech"; key: string; tick: number; message: string; meta: string }
  | { kind: "speechInterpretation"; key: string; tick: number; message: string; meta: string }
  | { kind: "speechEffect"; key: string; tick: number; message: string; meta: string }
  | { kind: "divergence"; key: string; tick: number; message: string; meta: string }
  | { kind: "trustUpdate"; key: string; tick: number; message: string; meta: string }
  | { kind: "tieUpdate"; key: string; tick: number; message: string; meta: string };

type Props = {
  state: SimulationState;
  presentation?: ScenarioPresentation;
  seed?: number;
  presetId?: string;
};

function buildTimeline(
  state: SimulationState,
  labelById: Map<string, string>,
  presentation: ScenarioPresentation,
  seed?: number,
  presetId?: string,
): TimelineRow[] {
  const stateRows: TimelineRow[] = state.log.map((entry, i) => ({
    kind: "state",
    key: `state-${entry.tick}-${i}`,
    tick: entry.tick,
    message: resolveScenarioLogMessage(entry, presentation),
    tags: entry.tags,
  }));
  const speechLog: SpeechEvent[] = state.speechLog ?? [];
  const speechRows: TimelineRow[] = speechLog.map((event) => {
    const agent = state.agents.find((candidate) => candidate.id === event.speakerId);
    const context =
      agent && seed !== undefined && presetId !== undefined
        ? { agent, seed, presetId, scenarioId: presentation.id }
        : undefined;
    return {
      kind: "speech",
      key: event.id,
      tick: event.tick,
      message: formatSpeechLogMessage(event, labelById, context),
      meta: formatSpeechDebugMeta(event, labelById),
    };
  });
  const interpretationRows: TimelineRow[] = (state.speechInterpretationLog ?? []).map((interpretation) => ({
    kind: "speechInterpretation",
    key: interpretation.id,
    tick: interpretation.tick,
    message: formatInterpretationLine(interpretation, labelById),
    meta: interpretation.factors.map((factor) => formatInterpretationFactorLine(factor)).join(" / "),
  }));
  const effectRows: TimelineRow[] = (state.speechEffectLog ?? []).map((effect) => ({
    kind: "speechEffect",
    key: effect.id,
    tick: effect.occurredTick,
    message: formatEffectLine(effect, labelById, presentation.id),
    meta: `speechEventId: ${effect.speechEventId} / reason: ${effect.reason} / speaker: ${labelById.get(effect.speakerId) ?? effect.speakerId}`,
  }));
  // Issue #119: 乖離発言(本心と建前がずれた発言)を、発言ログの`expression`から抽出する。
  const divergenceRows: TimelineRow[] = speechLog
    .filter((event) => event.expression?.divergent)
    .map((event) => {
      const link = event.expression!;
      const scene = classifyDivergenceScene(link, event.intent);
      const factorLabel = scene ? FACTOR_LABEL[DIVERGENCE_SCENE_FACTOR[scene]] : "その他";
      const speaker = labelById.get(event.speakerId) ?? event.speakerId;
      return {
        kind: "divergence",
        key: `divergence-${event.id}`,
        tick: event.tick,
        message: `${speaker}が本心(${STANCE_LABEL[link.privateStance]})と異なる建前(${STANCE_LABEL[link.expressedStance]})で発言 [${factorLabel}]`,
        meta: `speechEventId: ${event.id} / intent: ${event.intent}(基礎: ${link.baseIntent})`,
      };
    });
  // Issue #119: 信頼(trust)更新イベント(speechTrustUpdateLog)。
  const trustRows: TimelineRow[] = (state.speechTrustUpdateLog ?? []).map((update) => {
    const observer = labelById.get(update.observerId) ?? update.observerId;
    const speaker = labelById.get(update.speakerId) ?? update.speakerId;
    return {
      kind: "trustUpdate",
      key: update.id,
      tick: update.tick,
      message: `信頼更新: ${observer}→${speaker} ${OBSERVATION_LABEL[update.observation]}(${update.previousTrust.toFixed(2)}→${update.newTrust.toFixed(2)})`,
      meta: `観測: ${update.observedFromState}→${update.observedToState} / speechEventId: ${update.speechEventId}`,
    };
  });
  // Issue #119: 関係性補正(tie)変化イベント(relationshipTieUpdateLog)。
  const tieRows: TimelineRow[] = (state.relationshipTieUpdateLog ?? []).map((update) => {
    const observer = labelById.get(update.observerId) ?? update.observerId;
    const speaker = labelById.get(update.speakerId) ?? update.speakerId;
    return {
      kind: "tieUpdate",
      key: update.id,
      tick: update.tick,
      message: `関係性変化: ${observer}→${speaker} ${OBSERVATION_LABEL[update.observation]}(補正 ${update.previousCorrection.toFixed(2)}→${update.newCorrection.toFixed(2)})`,
      meta: `観測: ${update.intent} → ${update.observedToState} / speechEventId: ${update.speechEventId}`,
    };
  });
  // 状態ログ→発言ログ→解釈ログ→効果ログ→乖離→信頼→関係性の順に連結してからtickだけでソートする(Array#sortは
  // 安定ソートのため、同一tick内では連結順、各配列内は元の発生順という決定的な順序が保たれる)。
  return [
    ...stateRows,
    ...speechRows,
    ...interpretationRows,
    ...effectRows,
    ...divergenceRows,
    ...trustRows,
    ...tieRows,
  ].sort((a, b) => a.tick - b.tick);
}

export function EventLog({
  state,
  presentation = AFTER_PARTY_PRESENTATION,
  seed,
  presetId,
}: Props) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [showAllRows, setShowAllRows] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const labelById = useMemo(() => buildAgentLabelMap(state.agents), [state.agents]);
  const filters = useMemo(() => filtersForPresentation(presentation), [presentation]);
  const timeline = useMemo(
    () => buildTimeline(state, labelById, presentation, seed, presetId),
    [state, labelById, presentation, seed, presetId],
  );

  const activeTag = filters.find((f) => f.key === filter)?.tag;
  const filteredRows = useMemo(() => {
    if (filter === "all") return timeline;
    if (filter === "speech") return timeline.filter((row) => row.kind === "speech");
    if (filter === "speechEffect") {
      return timeline.filter((row) => row.kind === "speechInterpretation" || row.kind === "speechEffect");
    }
    if (filter === "divergence") return timeline.filter((row) => row.kind === "divergence");
    if (filter === "trust") return timeline.filter((row) => row.kind === "trustUpdate");
    if (filter === "tie") return timeline.filter((row) => row.kind === "tieUpdate");
    return timeline.filter((row) => row.kind === "state" && activeTag !== undefined && row.tags.includes(activeTag));
  }, [timeline, filter, activeTag]);

  const isTruncated = !showAllRows && filteredRows.length > ROW_DISPLAY_LIMIT;
  const visibleRows = isTruncated ? filteredRows.slice(-ROW_DISPLAY_LIMIT) : filteredRows;

  // フィルタ変更・ログ追加のいずれでも、表示中のリスト末尾に追従させる。
  // scrollIntoViewはスクロール可能な祖先(モバイル1カラム時はページ全体)まで
  // スクロールさせ、初回表示やログ追加のたびにページが状態ログへ飛んでしまうため、
  // リスト自身のscrollTopだけを動かす。
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [visibleRows.length, filter]);

  // フィルタを切り替えるたびに、直近件数のみの表示へ戻す(すべて表示ボタンは現在のフィルタ限定)
  useEffect(() => {
    setShowAllRows(false);
  }, [filter]);

  return (
    <div className="panel event-log">
      <h2>状態ログ</h2>
      <div className="event-log-filters">
        <label className="event-log-filter-label" htmlFor="event-log-filter-select">
          表示:
        </label>
        <select
          id="event-log-filter-select"
          className="event-log-filter-select"
          value={filter}
          onChange={(e) => setFilter(e.target.value as FilterKey)}
        >
          {filters.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      {isTruncated && (
        <p className="event-log-truncation-notice">
          直近{ROW_DISPLAY_LIMIT}件のみ表示中(全{filteredRows.length}件)。
          <button type="button" className="event-log-show-all-button" onClick={() => setShowAllRows(true)}>
            すべて表示
          </button>
        </p>
      )}
      <div className="event-log-list" ref={listRef}>
        {visibleRows.length === 0 && (
          <p className="event-log-empty">
            {timeline.length === 0 ? "まだイベントはありません。" : "該当するログはありません。"}
          </p>
        )}
        {visibleRows.map((row) =>
          row.kind === "speech" ? (
            <div key={row.key} className="event-log-entry event-log-entry--speech">
              <div className="event-log-entry-message">💬 {row.message}</div>
              <div className="event-log-entry-meta">{row.meta}</div>
            </div>
          ) : row.kind === "speechInterpretation" ? (
            <div key={row.key} className="event-log-entry event-log-entry--speech-effect">
              <div className="event-log-entry-message">🧠 {row.message}</div>
              <details className="event-log-entry-meta-details">
                <summary>解釈のfactor内訳</summary>
                <div className="event-log-entry-meta">{row.meta}</div>
              </details>
            </div>
          ) : row.kind === "speechEffect" ? (
            <div key={row.key} className="event-log-entry event-log-entry--speech-effect">
              <div className="event-log-entry-message">⚡ {row.message}</div>
              <div className="event-log-entry-meta">{row.meta}</div>
            </div>
          ) : row.kind === "divergence" ? (
            <div key={row.key} className="event-log-entry event-log-entry--speech-effect">
              <div className="event-log-entry-message">🎭 {row.message}</div>
              <div className="event-log-entry-meta">{row.meta}</div>
            </div>
          ) : row.kind === "trustUpdate" ? (
            <div key={row.key} className="event-log-entry event-log-entry--speech-effect">
              <div className="event-log-entry-message">🤝 {row.message}</div>
              <div className="event-log-entry-meta">{row.meta}</div>
            </div>
          ) : row.kind === "tieUpdate" ? (
            <div key={row.key} className="event-log-entry event-log-entry--speech-effect">
              <div className="event-log-entry-message">🔗 {row.message}</div>
              <div className="event-log-entry-meta">{row.meta}</div>
            </div>
          ) : (
            <div key={row.key} className="event-log-entry">
              {row.message}
            </div>
          ),
        )}
      </div>
    </div>
  );
}
