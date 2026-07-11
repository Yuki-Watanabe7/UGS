import { useEffect, useMemo, useRef, useState } from "react";
import type { LogTag, SimulationState } from "../simulation/types";
import type { SpeechEvent } from "../simulation/speech";
import { buildAgentLabelMap, formatSpeechDebugMeta, formatSpeechLogMessage } from "./speechDisplay";

type FilterKey = "all" | "observerJoiner" | "nucleus" | "groupConfirmed" | "leave" | "speech";

const FILTERS: Array<{ key: FilterKey; label: string; tag?: LogTag }> = [
  { key: "all", label: "全ログ" },
  { key: "observerJoiner", label: "observerJoinerのみ", tag: "observerJoiner" },
  { key: "nucleus", label: "核形成イベントのみ", tag: "nucleus" },
  { key: "groupConfirmed", label: "グループ成立イベントのみ", tag: "groupConfirmed" },
  { key: "leave", label: "離脱イベントのみ", tag: "leave" },
  { key: "speech", label: "発言のみ" },
];

/**
 * 状態ログ(検証可能な出来事の記録)と発言ログ(`SpeechEvent`、誰が誰に何を発言したか)を
 * tick順にまとめた1行分の表示データ。`kind`でどちらの由来かを判別できるようにし、
 * 発言側には表示文言と別に構造化属性を確認できる補足行(meta)を持たせる
 * (Issue #81: 心の声/通常状態ログ/発言をログ上で区別できることが目的)。
 */
type TimelineRow =
  | { kind: "state"; key: string; tick: number; message: string; tags: LogTag[] }
  | { kind: "speech"; key: string; tick: number; message: string; meta: string };

type Props = {
  state: SimulationState;
};

function buildTimeline(state: SimulationState, labelById: Map<string, string>): TimelineRow[] {
  const stateRows: TimelineRow[] = state.log.map((entry, i) => ({
    kind: "state",
    key: `state-${entry.tick}-${i}`,
    tick: entry.tick,
    message: entry.message,
    tags: entry.tags,
  }));
  const speechLog: SpeechEvent[] = state.speechLog ?? [];
  const speechRows: TimelineRow[] = speechLog.map((event) => ({
    kind: "speech",
    key: event.id,
    tick: event.tick,
    message: formatSpeechLogMessage(event, labelById),
    meta: formatSpeechDebugMeta(event, labelById),
  }));
  // 状態ログを先、発言ログを後に連結してからtickだけでソートする(Array#sortは安定ソートのため、
  // 同一tick内では「状態ログ→発言ログ」「各配列内は元の発生順」という決定的な順序が保たれる)。
  return [...stateRows, ...speechRows].sort((a, b) => a.tick - b.tick);
}

export function EventLog({ state }: Props) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const listRef = useRef<HTMLDivElement>(null);

  const labelById = useMemo(() => buildAgentLabelMap(state.agents), [state.agents]);
  const timeline = useMemo(() => buildTimeline(state, labelById), [state, labelById]);

  const activeTag = FILTERS.find((f) => f.key === filter)?.tag;
  const filteredRows = useMemo(() => {
    if (filter === "all") return timeline;
    if (filter === "speech") return timeline.filter((row) => row.kind === "speech");
    return timeline.filter((row) => row.kind === "state" && activeTag !== undefined && row.tags.includes(activeTag));
  }, [timeline, filter, activeTag]);

  // フィルタ変更・ログ追加のいずれでも、表示中のリスト末尾に追従させる。
  // scrollIntoViewはスクロール可能な祖先(モバイル1カラム時はページ全体)まで
  // スクロールさせ、初回表示やログ追加のたびにページが状態ログへ飛んでしまうため、
  // リスト自身のscrollTopだけを動かす。
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [filteredRows.length, filter]);

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
          {FILTERS.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      <div className="event-log-list" ref={listRef}>
        {filteredRows.length === 0 && (
          <p className="event-log-empty">
            {timeline.length === 0 ? "まだイベントはありません。" : "該当するログはありません。"}
          </p>
        )}
        {filteredRows.map((row) =>
          row.kind === "speech" ? (
            <div key={row.key} className="event-log-entry event-log-entry--speech">
              <div className="event-log-entry-message">💬 {row.message}</div>
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
