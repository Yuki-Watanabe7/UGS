import { buildObserverJoinerInspection } from "../simulation/inspection";
import type {
  AgentState,
  GroupCandidateStatus,
  ObserverJoinerInspection,
  ObserverSpeechEffectDetail,
  ObserverSpeechHistoryEntry,
  SimParams,
  SimulationState,
  SpeechRelation,
} from "../simulation/types";
import { buildAgentLabelMap, formatSpeechDebugMeta, formatSpeechLogMessage } from "./speechDisplay";
import {
  formatActiveEffectStatusLine,
  formatAggregatedEffectSummary,
  formatContributionLine,
  formatEffectLine,
  formatInterpretationFactorLine,
  formatInterpretationLine,
  formatReceptionLine,
} from "./speechEffectsDisplay";

type Props = {
  state: SimulationState;
  params: SimParams;
};

const SPEECH_RELATION_LABEL: Record<SpeechRelation, string> = {
  speaker: "話者",
  target: "対象",
  audience: "周囲",
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

/**
 * `entry`(発言1件)の認知/解釈/効果の因果詳細を折りたたみ表示する(Issue #98)。
 * どの段まで進んだか(認知されなかった/解釈が中立だった/効果が既に失効した等)を、
 * 各段の有無から文言として明示する — 「非認知・効果なしの理由も確認できる」の受入条件に対応。
 */
function SpeechEffectDetailBlock({
  detail,
  labelById,
}: {
  detail: ObserverSpeechEffectDetail;
  labelById: Map<string, string>;
}) {
  if (!detail.reception && !detail.interpretation && !detail.effect) {
    return (
      <p className="observer-inspector-effect-empty">
        発言効果の記録なし(Phase 3効果が無効、またはこのagentが認知対象になっていない)
      </p>
    );
  }

  return (
    <details className="observer-inspector-effect-details">
      <summary>発言効果の詳細</summary>

      {detail.reception ? (
        <div className="observer-inspector-effect-line">{formatReceptionLine(detail.reception, labelById)}</div>
      ) : (
        <div className="observer-inspector-effect-line">認知記録なし</div>
      )}

      {detail.reception && !detail.reception.heard && (
        <p className="observer-inspector-effect-reason">非認知理由: 圏外({detail.reception.reason})</p>
      )}

      {detail.reception?.heard && !detail.interpretation && (
        <p className="observer-inspector-effect-reason">届いたが解釈記録なし</p>
      )}

      {detail.interpretation && (
        <>
          <div className="observer-inspector-effect-line">{formatInterpretationLine(detail.interpretation, labelById)}</div>
          <ul className="observer-inspector-factor-list">
            {detail.interpretation.factors.map((factor) => (
              <li key={factor.key}>{formatInterpretationFactorLine(factor)}</li>
            ))}
          </ul>
        </>
      )}

      {detail.interpretation && detail.interpretation.valence === "neutral" && !detail.effect && (
        <p className="observer-inspector-effect-reason">解釈が中立だったため効果は発生しなかった</p>
      )}

      {detail.effect && (
        <>
          <div className="observer-inspector-effect-line">{formatEffectLine(detail.effect, labelById)}</div>
          <div className="observer-inspector-effect-line">{formatActiveEffectStatusLine(detail.activeEffectStatus)}</div>
        </>
      )}
    </details>
  );
}

function SpeechHistoryEntry({
  entry,
  detail,
  labelById,
}: {
  entry: ObserverSpeechHistoryEntry;
  detail?: ObserverSpeechEffectDetail;
  labelById: Map<string, string>;
}) {
  return (
    <div className="observer-inspector-speech-entry">
      <div className="observer-inspector-speech-message">
        <span className="observer-inspector-speech-relation">{SPEECH_RELATION_LABEL[entry.relation]}</span>
        {formatSpeechLogMessage(entry.event, labelById)}
      </div>
      <div className="observer-inspector-speech-meta">{formatSpeechDebugMeta(entry.event, labelById)}</div>
      {detail && <SpeechEffectDetailBlock detail={detail} labelById={labelById} />}
    </div>
  );
}

/**
 * 現在このagentに作用しているPhase 3効果を、dimensionごとの集約値+個別寄与(speechEventIdの列挙)で
 * 表示する(Issue #98)。複数の発言が同じdimensionへ寄与している場合、正/負/重複の内訳を分けて示す。
 */
function ActiveEffectSummaryList({
  summaries,
  labelById,
}: {
  summaries: ObserverJoinerInspection["activeEffectSummaries"];
  labelById: Map<string, string>;
}) {
  if (summaries.length === 0) {
    return <p className="observer-inspector-speech-empty">現在作用中の発言効果はありません。</p>;
  }
  return (
    <div className="observer-inspector-speech-list">
      {summaries.map((summary) => (
        <div key={`${summary.dimension}-${summary.targetGroupId ?? ""}`} className="observer-inspector-speech-entry">
          <div className="observer-inspector-speech-message">{formatAggregatedEffectSummary(summary)}</div>
          {summary.positiveContributions.length > 0 && (
            <ul className="observer-inspector-factor-list">
              {summary.positiveContributions.map((c) => (
                <li key={c.speechActiveEffectId}>+ {formatContributionLine(c, labelById)}</li>
              ))}
            </ul>
          )}
          {summary.negativeContributions.length > 0 && (
            <ul className="observer-inspector-factor-list">
              {summary.negativeContributions.map((c) => (
                <li key={c.speechActiveEffectId}>- {formatContributionLine(c, labelById)}</li>
              ))}
            </ul>
          )}
          {summary.duplicateContributions.length > 0 && (
            <ul className="observer-inspector-factor-list">
              {summary.duplicateContributions.map((c) => (
                <li key={c.speechActiveEffectId}>(重複・不採用) {formatContributionLine(c, labelById)}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

function InspectionCard({
  inspection,
  labelById,
}: {
  inspection: ObserverJoinerInspection;
  labelById: Map<string, string>;
}) {
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
            <span>attractiveness(適用後)</span>
            <span>{formatRatio(inspection.attractivenessScore as number)}</span>
          </div>
          {inspection.attractivenessScoreBeforeEffects !== undefined &&
            inspection.attractivenessScoreBeforeEffects !== inspection.attractivenessScore && (
              <>
                <div className="observer-inspector-row">
                  <span>attractiveness(適用前)</span>
                  <span>{formatRatio(inspection.attractivenessScoreBeforeEffects)}</span>
                </div>
                <div className="observer-inspector-row">
                  <span>うち発言効果による補正</span>
                  <span>
                    {formatRatio(
                      (inspection.attractivenessScore as number) - inspection.attractivenessScoreBeforeEffects,
                    )}
                  </span>
                </div>
              </>
            )}
        </>
      ) : (
        <div className="observer-inspector-row">
          <span>nearest group</span>
          <span>なし</span>
        </div>
      )}

      <div className="observer-inspector-divider" />

      <div className="observer-inspector-row observer-inspector-row--header">
        <span>関連する発言</span>
      </div>
      {inspection.speechHistory.length === 0 ? (
        <p className="observer-inspector-speech-empty">まだ関連する発言はありません。</p>
      ) : (
        <div className="observer-inspector-speech-list">
          {inspection.speechHistory.map((entry, i) => (
            <SpeechHistoryEntry
              key={entry.event.id}
              entry={entry}
              detail={inspection.speechEffectDetails[i]}
              labelById={labelById}
            />
          ))}
        </div>
      )}

      <div className="observer-inspector-divider" />

      <div className="observer-inspector-row observer-inspector-row--header">
        <span>現在作用中の発言効果</span>
      </div>
      <ActiveEffectSummaryList summaries={inspection.activeEffectSummaries} labelById={labelById} />
    </div>
  );
}

export function ObserverJoinerInspector({ state, params }: Props) {
  const inspections = buildObserverJoinerInspection(state, params);
  const labelById = buildAgentLabelMap(state.agents);

  return (
    <div className="panel observer-inspector">
      <h2>observerJoinerインスペクター</h2>
      {inspections.length === 0 ? (
        <p className="observer-inspector-empty">observerJoinerがいません。</p>
      ) : (
        inspections.map((inspection) => (
          <InspectionCard key={inspection.agentId} inspection={inspection} labelById={labelById} />
        ))
      )}
    </div>
  );
}
