import { useEffect, useMemo, useRef, useState } from "react";
import type { LogEntry, LogTag } from "../simulation/types";

type FilterKey = "all" | "observerJoiner" | "nucleus" | "groupConfirmed" | "leave";

const FILTERS: Array<{ key: FilterKey; label: string; tag?: LogTag }> = [
  { key: "all", label: "全ログ" },
  { key: "observerJoiner", label: "observerJoinerのみ", tag: "observerJoiner" },
  { key: "nucleus", label: "核形成イベントのみ", tag: "nucleus" },
  { key: "groupConfirmed", label: "グループ成立イベントのみ", tag: "groupConfirmed" },
  { key: "leave", label: "離脱イベントのみ", tag: "leave" },
];

type Props = {
  log: LogEntry[];
};

export function EventLog({ log }: Props) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const listRef = useRef<HTMLDivElement>(null);

  const activeTag = FILTERS.find((f) => f.key === filter)?.tag;
  const filteredLog = useMemo(
    () => (activeTag ? log.filter((entry) => entry.tags.includes(activeTag)) : log),
    [log, activeTag],
  );

  // フィルタ変更・ログ追加のいずれでも、表示中のリスト末尾に追従させる。
  // scrollIntoViewはスクロール可能な祖先(モバイル1カラム時はページ全体)まで
  // スクロールさせ、初回表示やログ追加のたびにページが状態ログへ飛んでしまうため、
  // リスト自身のscrollTopだけを動かす。
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [filteredLog.length, filter]);

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
        {filteredLog.length === 0 && (
          <p className="event-log-empty">
            {log.length === 0 ? "まだイベントはありません。" : "該当するログはありません。"}
          </p>
        )}
        {filteredLog.map((entry, i) => (
          <div key={`${entry.tick}-${i}`} className="event-log-entry">
            {entry.message}
          </div>
        ))}
      </div>
    </div>
  );
}
