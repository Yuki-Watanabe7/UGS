import { useEffect, useRef } from "react";
import type { LogEntry } from "../simulation/types";

type Props = {
  log: LogEntry[];
};

export function EventLog({ log }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [log.length]);

  return (
    <div className="panel event-log">
      <h2>状態ログ</h2>
      <div className="event-log-list">
        {log.length === 0 && <p className="event-log-empty">まだイベントはありません。</p>}
        {log.map((entry, i) => (
          <div key={`${entry.tick}-${i}`} className="event-log-entry">
            {entry.message}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
