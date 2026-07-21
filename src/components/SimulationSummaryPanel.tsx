import { buildSimulationSummary } from "../simulation/summary";
import { buildPairFormationRunSummary } from "../simulation/pairFormation";
import { DEFAULT_PARAMS } from "../simulation/presets";
import type {
  AgentState,
  ObserverJoinerRunSummary,
  SimParams,
  SimulationFinishReason,
  SimulationState,
} from "../simulation/types";
import { getScenarioPresentation, type ScenarioPresentation } from "../presentation/scenarioPresentation";

type Props = {
  state: SimulationState;
  /**
   * Issue #155: 学校シナリオの終了サマリー(班サイズ分布・構造的未割当)の導出にのみ使う
   * (`buildPairFormationRunSummary`の必須引数)。`classroomPair`のFormationPolicyは実際には
   * この値を参照しないため、省略時は`DEFAULT_PARAMS`にフォールバックする。二次会シナリオでは未使用。
   */
  params?: SimParams;
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

function joinedGroupKindLabel(
  summary: ObserverJoinerRunSummary,
  presentation: ScenarioPresentation,
): string {
  if (summary.joinedTick === undefined) return NOT_JOINED;
  if (presentation.id === "classroomPair") {
    const unitWord = presentation.groupUnit?.unitWord ?? "ペア";
    return summary.joinedGroupStatus === "confirmed" ? `成立済み${unitWord}` : `形成中の${unitWord}候補`;
  }
  return summary.joinedGroupStatus === "confirmed" ? "成立済みグループ" : "未確定の輪";
}

function ObserverJoinerSummaryCard({
  summary,
  presentation,
}: {
  summary: ObserverJoinerRunSummary;
  presentation: ScenarioPresentation;
}) {
  const isClassroomPair = presentation.id === "classroomPair";
  const unitWord = presentation.groupUnit?.unitWord ?? "ペア";
  return (
    <div className="simulation-summary-card">
      <div className="simulation-summary-row simulation-summary-row--header">
        <span className="simulation-summary-label-name">{summary.label}</span>
        <span className="simulation-summary-state">{presentation.agentStateLabels[summary.finalState]}</span>
      </div>
      <div className="simulation-summary-row">
        <span>{isClassroomPair ? `${unitWord}成立tick` : "参加tick"}</span>
        <span>{formatTick(summary.joinedTick, NOT_JOINED)}</span>
      </div>
      <div className="simulation-summary-row">
        <span>{isClassroomPair ? "組み合わせ" : "参加先"}</span>
        <span>{joinedGroupKindLabel(summary, presentation)}</span>
      </div>
      {isClassroomPair ? (
        <div className="simulation-summary-row">
          <span>最終割当</span>
          <span>{summary.finalState === "joined" ? `${unitWord}成立` : "未割当"}</span>
        </div>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}

export function SimulationSummaryPanel({ state, params = DEFAULT_PARAMS }: Props) {
  const summary = buildSimulationSummary(state);
  const presentation = getScenarioPresentation(state.formationScenarioId, state.formationClassroomGroupSize);
  const isClassroomPair = presentation.id === "classroomPair";
  const unitWord = presentation.groupUnit?.unitWord ?? "ペア";
  // Issue #155: 班サイズ分布・構造的未割当は学校シナリオでのみ意味を持つ集計軸のため、
  // 二次会シナリオでは導出自体をスキップする(`buildPairFormationRunSummary`は
  // `state.formationScenarioId`非依存の汎用関数だが、表示上不要な計算は避ける)。
  const pairFormation = isClassroomPair ? buildPairFormationRunSummary(state, params) : undefined;
  const groupSizeEntries = pairFormation
    ? Object.entries(pairFormation.groupSizeDistribution)
        .map(([size, count]) => ({ size: Number(size), count }))
        .sort((a, b) => a.size - b.size)
    : [];

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
          <span>{presentation.summary.joinedCount}</span>
          <span>{summary.joinedCount}</span>
        </div>
        {!isClassroomPair && (
          <div className="simulation-summary-row">
            <span>{presentation.summary.leftCount}</span>
            <span>{summary.leftCount}</span>
          </div>
        )}
        <div className="simulation-summary-row">
          <span>{presentation.summary.unassignedCount}</span>
          <span>{summary.unassignedCount}</span>
        </div>
        {AGENT_STATE_ORDER.map((agentState) => (
          <div className="simulation-summary-row" key={agentState}>
            <span>{presentation.agentStateLabels[agentState]}</span>
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
                  確定前: {agent.previousState ? presentation.agentStateLabels[agent.previousState] : "不明"} / 再探索
                  {agent.searchRestartCount}回
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="simulation-summary-section">
        <h3>{presentation.summary.observerSection}</h3>
        {summary.observerJoiners.length === 0 ? (
          <p className="simulation-summary-empty">
            {isClassroomPair ? "自分から誘わず待ちやすい生徒はいません。" : "observerJoinerがいません。"}
          </p>
        ) : (
          summary.observerJoiners.map((observer) => (
            <ObserverJoinerSummaryCard
              key={observer.agentId}
              summary={observer}
              presentation={presentation}
            />
          ))
        )}
      </section>

      <section className="simulation-summary-section">
        <h3>{isClassroomPair ? `${unitWord}形成サマリー` : "グループ形成サマリー"}</h3>
        <div className="simulation-summary-row">
          <span>{presentation.summary.firstNucleusTick}</span>
          <span>{formatTick(summary.firstNucleusTick, NOT_OCCURRED)}</span>
        </div>
        <div className="simulation-summary-row">
          <span>{presentation.summary.firstConfirmedTick}</span>
          <span>{formatTick(summary.firstGroupConfirmedTick, NOT_OCCURRED)}</span>
        </div>
        <div className="simulation-summary-row">
          <span>{presentation.summary.confirmedCount}</span>
          <span>{summary.confirmedGroupCount}</span>
        </div>
        <div className="simulation-summary-row">
          <span>{presentation.summary.failure}</span>
          <span>{summary.groupFailure ? "はい" : "いいえ"}</span>
        </div>
      </section>

      {isClassroomPair && pairFormation && (
        <section className="simulation-summary-section">
          <h3>{unitWord}人数の内訳</h3>
          <div className="simulation-summary-row">
            <span>割当人数</span>
            <span>{pairFormation.assignedCount}</span>
          </div>
          <div className="simulation-summary-row">
            <span>未割当人数</span>
            <span>{pairFormation.unassignedCount}</span>
          </div>
          {pairFormation.structuralUnassignedFloor !== undefined && (
            <>
              <div className="simulation-summary-row">
                <span>構造的未割当人数(定員上どうしても割り切れない人数)</span>
                <span>{pairFormation.structuralUnassignedFloor}</span>
              </div>
              <div className="simulation-summary-row">
                <span>構造的未割当を超える未割当人数</span>
                <span>{pairFormation.excessUnassignedCount}</span>
              </div>
            </>
          )}
          {groupSizeEntries.length === 0 ? (
            <p className="simulation-summary-empty">まだ成立した{unitWord}はありません。</p>
          ) : (
            <div className="simulation-summary-card">
              <div className="simulation-summary-row simulation-summary-row--header">
                <span className="simulation-summary-label-name">{unitWord}サイズ分布</span>
                <span>{pairFormation.confirmedPairCount}{unitWord}成立</span>
              </div>
              {groupSizeEntries.map(({ size, count }) => (
                <div className="simulation-summary-row" key={size}>
                  <span>{size}人{unitWord}</span>
                  <span>{count}{unitWord}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
