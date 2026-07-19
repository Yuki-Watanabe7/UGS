import { buildSimulationSummary } from "../simulation/summary";
import type {
  AgentState,
  ObserverJoinerRunSummary,
  SimulationFinishReason,
  SimulationState,
} from "../simulation/types";

type Props = {
  state: SimulationState;
};

const AGENT_STATE_LABEL: Record<AgentState, string> = {
  undecided: "未定",
  forming: "輪を形成中",
  approaching: "接近中",
  joined: "参加済み",
  leaving: "離脱中",
  left: "離脱済み",
  unassigned: "未割当",
};

const AGENT_STATE_ORDER: AgentState[] = [
  "undecided",
  "forming",
  "approaching",
  "joined",
  "leaving",
  "left",
  "unassigned",
];

const FINISH_REASON_LABEL: Record<SimulationFinishReason, string> = {
  allAssigned: "全員割当済み",
  deadlineReached: "締切到達",
  allSettled: "全員決着済み",
  maxTicksReached: "最大tick到達",
};

const NOT_OCCURRED = "未発生";
const NOT_JOINED = "未参加";
const NOT_LEFT = "未離脱";

function formatTick(tick: number | undefined, placeholder: string): string {
  return tick === undefined ? placeholder : `tick ${tick}`;
}

function joinedGroupKindLabel(summary: ObserverJoinerRunSummary): string {
  if (summary.joinedTick === undefined) return NOT_JOINED;
  return summary.joinedGroupStatus === "confirmed" ? "成立済みグループ" : "未確定の輪";
}

function ObserverJoinerSummaryCard({ summary }: { summary: ObserverJoinerRunSummary }) {
  return (
    <div className="simulation-summary-card">
      <div className="simulation-summary-row simulation-summary-row--header">
        <span className="simulation-summary-label-name">{summary.label}</span>
        <span className="simulation-summary-state">{AGENT_STATE_LABEL[summary.finalState]}</span>
      </div>
      <div className="simulation-summary-row">
        <span>参加tick</span>
        <span>{formatTick(summary.joinedTick, NOT_JOINED)}</span>
      </div>
      <div className="simulation-summary-row">
        <span>参加先</span>
        <span>{joinedGroupKindLabel(summary)}</span>
      </div>
      <div className="simulation-summary-row">
        <span>離脱開始tick</span>
        <span>{formatTick(summary.leaveStartedTick, NOT_LEFT)}</span>
      </div>
      <div className="simulation-summary-row">
        <span>帰宅完了tick</span>
        <span>{formatTick(summary.leftTick, NOT_LEFT)}</span>
      </div>
      <div className="simulation-summary-row">
        <span>後乗り成功</span>
        <span>{summary.lateJoinSucceeded ? "成功" : "いいえ"}</span>
      </div>
    </div>
  );
}

export function SimulationSummaryPanel({ state }: Props) {
  const summary = buildSimulationSummary(state);
  const isClassroomPair = state.formationScenarioId === "classroomPair";

  return (
    <div className="panel simulation-summary">
      <h2>終了サマリー</h2>
      {!summary.finished && <p className="simulation-summary-provisional">現在時点の暫定集計</p>}

      <section className="simulation-summary-section">
        <h3>終了状態</h3>
        <div className="simulation-summary-row">
          <span>状態</span>
          <span>{summary.finished ? "終了済み" : "実行中"}</span>
        </div>
        <div className="simulation-summary-row">
          <span>終了tick</span>
          <span>{formatTick(summary.finishedTick, NOT_OCCURRED)}</span>
        </div>
        <div className="simulation-summary-row">
          <span>終了理由</span>
          <span>{summary.finishReason ? FINISH_REASON_LABEL[summary.finishReason] : NOT_OCCURRED}</span>
        </div>
      </section>

      <section className="simulation-summary-section">
        <h3>人数サマリー</h3>
        <div className="simulation-summary-row">
          <span>参加人数</span>
          <span>{summary.joinedCount}</span>
        </div>
        <div className="simulation-summary-row">
          <span>帰宅人数</span>
          <span>{summary.leftCount}</span>
        </div>
        <div className="simulation-summary-row">
          <span>未割当人数</span>
          <span>{summary.unassignedCount}</span>
        </div>
        {AGENT_STATE_ORDER.map((agentState) => (
          <div className="simulation-summary-row" key={agentState}>
            <span>{AGENT_STATE_LABEL[agentState]}</span>
            <span>{summary.stateCounts[agentState]}</span>
          </div>
        ))}
        {summary.unassignedAgents.length > 0 && (
          <div className="simulation-summary-card">
            <div className="simulation-summary-row simulation-summary-row--header">
              <span className="simulation-summary-label-name">未割当者一覧</span>
              <span>{summary.unassignedAgents.map((agent) => agent.label).join(" / ")}</span>
            </div>
            {summary.unassignedAgents.map((agent) => (
              <div className="simulation-summary-row" key={agent.agentId}>
                <span>{agent.label}</span>
                <span>
                  確定前: {agent.previousState ? AGENT_STATE_LABEL[agent.previousState] : "不明"} / 再探索
                  {agent.searchRestartCount}回
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="simulation-summary-section">
        <h3>observerJoinerサマリー</h3>
        {summary.observerJoiners.length === 0 ? (
          <p className="simulation-summary-empty">observerJoinerがいません。</p>
        ) : (
          summary.observerJoiners.map((observer) => (
            <ObserverJoinerSummaryCard key={observer.agentId} summary={observer} />
          ))
        )}
      </section>

      <section className="simulation-summary-section">
        <h3>{isClassroomPair ? "ペア形成サマリー" : "グループ形成サマリー"}</h3>
        <div className="simulation-summary-row">
          <span>最初の核形成tick</span>
          <span>{formatTick(summary.firstNucleusTick, NOT_OCCURRED)}</span>
        </div>
        <div className="simulation-summary-row">
          <span>最初のグループ成立tick</span>
          <span>{formatTick(summary.firstGroupConfirmedTick, NOT_OCCURRED)}</span>
        </div>
        <div className="simulation-summary-row">
          <span>{isClassroomPair ? "成立ペア数" : "成立グループ数"}</span>
          <span>{summary.confirmedGroupCount}</span>
        </div>
        <div className="simulation-summary-row">
          <span>グループ不成立</span>
          <span>{summary.groupFailure ? "はい" : "いいえ"}</span>
        </div>
      </section>
    </div>
  );
}
