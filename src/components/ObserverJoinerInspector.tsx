import { buildObserverJoinerInspection } from "../simulation/inspection";
import type { AgentState, GroupCandidateStatus, ObserverJoinerInspection, SimParams, SimulationState } from "../simulation/types";

type Props = {
  state: SimulationState;
  params: SimParams;
};

const AGENT_STATE_LABEL: Record<AgentState, string> = {
  undecided: "未定",
  forming: "輪を形成中",
  approaching: "接近中",
  joined: "参加済み",
  leaving: "離脱中",
  left: "離脱済み",
};

const GROUP_STATUS_LABEL: Record<GroupCandidateStatus, string> = {
  forming: "形成中",
  confirmed: "成立済み",
  dissolving: "解散中",
  dissolved: "解散済み",
  expired: "期限切れ",
};

// leaveMarginがこの値を下回ったら、まだ離脱していなくても注意表示にする
const LEAVE_MARGIN_WARNING_THRESHOLD = 0.15;

function formatRatio(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatDistance(value: number): string {
  return value.toFixed(1);
}

function InspectionCard({ inspection }: { inspection: ObserverJoinerInspection }) {
  const isNearLeaving = inspection.leaveMargin <= LEAVE_MARGIN_WARNING_THRESHOLD;
  const hasNearestGroup = inspection.nearestGroupId !== undefined;

  return (
    <div className={`observer-inspector-card${isNearLeaving ? " observer-inspector-card--warning" : ""}`}>
      <div className="observer-inspector-row observer-inspector-row--header">
        <span className="observer-inspector-label-name">{inspection.label}</span>
        <span className="observer-inspector-state">{AGENT_STATE_LABEL[inspection.state]}</span>
      </div>

      <div className="observer-inspector-row">
        <span>stress</span>
        <span>{formatRatio(inspection.stress)}</span>
      </div>
      <div className="observer-inspector-row">
        <span>willingness</span>
        <span>{formatRatio(inspection.willingness)}</span>
      </div>
      <div className="observer-inspector-row">
        <span>ambiguityTolerance</span>
        <span>{formatRatio(inspection.ambiguityTolerance)}</span>
      </div>
      <div className="observer-inspector-row">
        <span>influenceAvoidance</span>
        <span>{formatRatio(inspection.influenceAvoidance)}</span>
      </div>
      <div className="observer-inspector-row">
        <span>leaveThreshold</span>
        <span>{formatRatio(inspection.leaveThreshold)}</span>
      </div>
      <div className={`observer-inspector-row${isNearLeaving ? " observer-inspector-row--warning" : ""}`}>
        <span>離脱までの余裕</span>
        <span>
          {formatRatio(inspection.leaveMargin)}
          {isNearLeaving ? " ⚠ 離脱間近" : ""}
        </span>
      </div>

      <div className="observer-inspector-divider" />

      {hasNearestGroup ? (
        <>
          <div className="observer-inspector-row">
            <span>nearest group</span>
            <span>{inspection.nearestGroupId}</span>
          </div>
          <div className="observer-inspector-row">
            <span>nearest group status</span>
            <span>{GROUP_STATUS_LABEL[inspection.nearestGroupStatus as GroupCandidateStatus]}</span>
          </div>
          <div className="observer-inspector-row">
            <span>nearest group人数</span>
            <span>{inspection.nearestGroupMemberCount}</span>
          </div>
          <div className="observer-inspector-row">
            <span>nearest group距離</span>
            <span>{formatDistance(inspection.nearestGroupDistance as number)}</span>
          </div>
          <div className="observer-inspector-row">
            <span>attractiveness</span>
            <span>{formatRatio(inspection.attractivenessScore as number)}</span>
          </div>
        </>
      ) : (
        <div className="observer-inspector-row">
          <span>nearest group</span>
          <span>なし</span>
        </div>
      )}
    </div>
  );
}

export function ObserverJoinerInspector({ state, params }: Props) {
  const inspections = buildObserverJoinerInspection(state, params);

  return (
    <div className="panel observer-inspector">
      <h2>observerJoinerインスペクター</h2>
      {inspections.length === 0 ? (
        <p className="observer-inspector-empty">observerJoinerがいません。</p>
      ) : (
        inspections.map((inspection) => <InspectionCard key={inspection.agentId} inspection={inspection} />)
      )}
    </div>
  );
}
