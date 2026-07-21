import { buildAgentInspection, buildObserverJoinerInspection } from "../simulation/inspection";
import { getFormationPolicyById } from "../simulation/formationPolicy";
import type {
  AgentAssignmentStatus,
  ApproachFailureReason,
  GroupCandidateStatus,
  ObserverJoinerInspection,
  ObserverSocialExpressionSnapshot,
  ObserverSpeechEffectDetail,
  ObserverSpeechHistoryEntry,
  ObserverTieSummary,
  ObserverTrustSummary,
  SimParams,
  SimulationState,
  SpeechRelation,
} from "../simulation/types";
import type { ExpressedStance, PublicExpressionFactorKey } from "../simulation/socialExpression";
import type { SpeechTextContext } from "../simulation/speechTemplates";
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
import { getScenarioPresentation, type ScenarioPresentation } from "../presentation/scenarioPresentation";

type Props = {
  state: SimulationState;
  params: SimParams;
  seed?: number;
  presetId?: string;
};

const SPEECH_RELATION_LABEL: Record<SpeechRelation, string> = {
  speaker: "話者",
  target: "対象",
  audience: "周囲",
};

const ASSIGNMENT_STATUS_LABEL: Record<AgentAssignmentStatus, string> = {
  searching: "探索中",
  waitingForPartner: "相手待ち",
  approaching: "接近中",
  searchingAgain: "再探索中",
  assigned: "割当済み",
  unassigned: "未割当確定",
  leaving: "離脱中",
  left: "離脱済み",
};

const APPROACH_FAILURE_REASON_LABEL: Record<ApproachFailureReason, string> = {
  capacityFull: "満員",
  groupDissolved: "候補が解散",
  groupExpired: "候補が期限切れ",
  groupMissing: "候補が消失",
};

const GROUP_STATUS_LABEL: Record<GroupCandidateStatus, string> = {
  forming: "形成中",
  confirmed: "成立済み",
  dissolving: "解散中",
  dissolved: "解散済み",
  expired: "期限切れ",
};

/** Issue #155: 学校シナリオでagentの現在の班について表示する、人数・容量の状態 */
type ClassroomGroupCapacityInfo = {
  currentSize: number;
  minGroupSize: number;
  maxGroupSize: number;
  /** "forming" = 未成立(最小人数未満)、"confirmed-vacancy" = 成立済みだが空きあり、"full" = 収容最大人数に到達 */
  capacityState: "forming" | "confirmed-vacancy" | "full";
};

const CLASSROOM_GROUP_CAPACITY_STATE_LABEL: Record<ClassroomGroupCapacityInfo["capacityState"], string> = {
  forming: "形成中(未成立)",
  "confirmed-vacancy": "成立済み・空きあり",
  full: "確定・満員",
};

const STANCE_LABEL: Record<ExpressedStance, string> = {
  positive: "積極的",
  none: "無表明",
  negative: "消極的",
};

const FACTOR_KEY_LABEL: Record<PublicExpressionFactorKey, string> = {
  reserve: "遠慮",
  conformityPressure: "同調圧力",
  impressionManagement: "印象管理",
};

const TIE_OBSERVATION_LABEL: Record<"consistent" | "inconsistent", string> = {
  consistent: "一致",
  inconsistent: "不一致",
};

// Inspectorの履歴表示は直近この件数までに絞る(観察を妨げないための上限。Issue #98の折りたたみ方針を踏襲)
const HISTORY_DISPLAY_LIMIT = 5;

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
  presentation,
}: {
  detail: ObserverSpeechEffectDetail;
  labelById: Map<string, string>;
  presentation: ScenarioPresentation;
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
          <div className="observer-inspector-effect-line">
            {formatEffectLine(detail.effect, labelById, presentation.id)}
          </div>
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
  context,
  presentation,
}: {
  entry: ObserverSpeechHistoryEntry;
  detail?: ObserverSpeechEffectDetail;
  labelById: Map<string, string>;
  context: SpeechTextContext;
  presentation: ScenarioPresentation;
}) {
  return (
    <div className="observer-inspector-speech-entry">
      <div className="observer-inspector-speech-message">
        <span className="observer-inspector-speech-relation">{SPEECH_RELATION_LABEL[entry.relation]}</span>
        {formatSpeechLogMessage(entry.event, labelById, context)}
      </div>
      <div className="observer-inspector-speech-meta">{formatSpeechDebugMeta(entry.event, labelById)}</div>
      {detail && (
        <SpeechEffectDetailBlock
          detail={detail}
          labelById={labelById}
          presentation={presentation}
        />
      )}
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
  presentation,
}: {
  summaries: ObserverJoinerInspection["activeEffectSummaries"];
  labelById: Map<string, string>;
  presentation: ScenarioPresentation;
}) {
  if (summaries.length === 0) {
    return <p className="observer-inspector-speech-empty">現在作用中の発言効果はありません。</p>;
  }
  return (
    <div className="observer-inspector-speech-list">
      {summaries.map((summary) => (
        <div key={`${summary.dimension}-${summary.targetGroupId ?? ""}`} className="observer-inspector-speech-entry">
          <div className="observer-inspector-speech-message">
            {formatAggregatedEffectSummary(summary, presentation.id)}
          </div>
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

/**
 * Issue #119: 現在tickの本心(private)と対外表現(expressed)、乖離の有無・要因内訳を表示する。
 * 本心と建前のずれ(divergent)と、その次元ごとの要因(遠慮・同調圧力・印象管理)の寄与を明示する。
 */
function SocialExpressionSection({ snapshot }: { snapshot?: ObserverSocialExpressionSnapshot }) {
  if (!snapshot) {
    return <p className="observer-inspector-speech-empty">本心/建前の記録なし(三層モデルが無効)。</p>;
  }
  return (
    <>
      <div className={`observer-inspector-row${snapshot.divergent ? " observer-inspector-row--warning" : ""}`}>
        <span>本心 / 建前(参加意欲)</span>
        <span>
          {STANCE_LABEL[snapshot.privateStance]} → {STANCE_LABEL[snapshot.expressedStance]}
          {snapshot.divergent ? " ⚠ 乖離あり" : ""}
        </span>
      </div>
      <div className="observer-inspector-row">
        <span>参加意欲(本心→建前)</span>
        <span>
          {formatRatio(snapshot.privateJoinDesire)} → {formatRatio(snapshot.expressedJoinDesire)}
        </span>
      </div>
      <div className="observer-inspector-row">
        <span>離脱傾向(本心→建前)</span>
        <span>
          {snapshot.privateLeaveInclination.toFixed(2)} → {snapshot.expressedLeaveInclination.toFixed(2)}
        </span>
      </div>
      {snapshot.divergent && (
        <details className="observer-inspector-effect-details">
          <summary>乖離の要因内訳</summary>
          {snapshot.divergences
            .filter((divergence) => Math.abs(divergence.delta) > 1e-9)
            .map((divergence) => (
              <div key={divergence.dimension} className="observer-inspector-effect-line">
                {divergence.dimension === "joinDesire" ? "参加意欲" : "離脱傾向"}: 乖離量 {divergence.delta.toFixed(2)}
                <ul className="observer-inspector-factor-list">
                  {divergence.factors
                    .filter((factor) => Math.abs(factor.contribution) > 1e-9)
                    .map((factor) => (
                      <li key={factor.key}>
                        {FACTOR_KEY_LABEL[factor.key]}: {factor.contribution >= 0 ? "+" : ""}
                        {factor.contribution.toFixed(2)}
                      </li>
                    ))}
                </ul>
              </div>
            ))}
        </details>
      )}
    </>
  );
}

/** Issue #119: 話者ごとの動的trust現在値と直近の更新履歴(受け手→話者) */
function TrustSummaryList({
  summaries,
  labelById,
}: {
  summaries: ObserverTrustSummary[];
  labelById: Map<string, string>;
}) {
  if (summaries.length === 0) {
    return <p className="observer-inspector-speech-empty">この観測者に紐づくtrust更新はまだありません。</p>;
  }
  return (
    <div className="observer-inspector-speech-list">
      {summaries.map((summary) => {
        const recent = summary.updates.slice(-HISTORY_DISPLAY_LIMIT);
        return (
          <div key={summary.speakerId} className="observer-inspector-speech-entry">
            <div className="observer-inspector-row">
              <span>{labelById.get(summary.speakerId) ?? summary.speakerId} への信頼</span>
              <span>
                {formatRatio(summary.trust)}
                {summary.isDynamic ? "" : "(初期値)"}
              </span>
            </div>
            {recent.length > 0 && (
              <details className="observer-inspector-effect-details">
                <summary>更新履歴({summary.updates.length}件)</summary>
                {recent.map((update) => (
                  <div key={update.id} className="observer-inspector-effect-line">
                    t{update.tick} {TIE_OBSERVATION_LABEL[update.observation]}(
                    {update.observedFromState}→{update.observedToState}): {formatRatio(update.previousTrust)} →{" "}
                    {formatRatio(update.newTrust)}
                  </div>
                ))}
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Issue #119: 話者ごとの関係性補正の現在値・寄与した整合性観測・更新履歴(受け手→話者) */
function TieSummaryList({
  summaries,
  labelById,
}: {
  summaries: ObserverTieSummary[];
  labelById: Map<string, string>;
}) {
  if (summaries.length === 0) {
    return <p className="observer-inspector-speech-empty">この観測者に紐づく関係性補正はまだありません。</p>;
  }
  return (
    <div className="observer-inspector-speech-list">
      {summaries.map((summary) => {
        const recentObservations = summary.observations.slice(-HISTORY_DISPLAY_LIMIT);
        return (
          <div key={summary.speakerId} className="observer-inspector-speech-entry">
            <div className="observer-inspector-row">
              <span>{labelById.get(summary.speakerId) ?? summary.speakerId} との関係性補正</span>
              <span>
                {summary.correction >= 0 ? "+" : ""}
                {summary.correction.toFixed(2)}
              </span>
            </div>
            {recentObservations.length > 0 && (
              <details className="observer-inspector-effect-details">
                <summary>寄与した観測({summary.observations.length}件)</summary>
                {recentObservations.map((observation) => (
                  <div key={`${observation.speechEventId}-${observation.observedTick}`} className="observer-inspector-effect-line">
                    t{observation.speechTick}の{observation.intent} → t{observation.observedTick}{" "}
                    {TIE_OBSERVATION_LABEL[observation.observation]}({observation.observedToState}): {observation.weight >= 0 ? "+" : ""}
                    {observation.weight.toFixed(2)}
                  </div>
                ))}
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

function InspectionCard({
  inspection,
  labelById,
  presentation,
  seed,
  presetId,
  agentById,
}: {
  inspection: ObserverJoinerInspection;
  labelById: Map<string, string>;
  presentation: ScenarioPresentation;
  seed?: number;
  presetId?: string;
  agentById: Map<string, SimulationState["agents"][number]>;
}) {
  const isNearLeaving = inspection.leaveMargin <= LEAVE_MARGIN_WARNING_THRESHOLD;
  const hasNearestGroup = inspection.nearestGroupId !== undefined;

  return (
    <div className={`observer-inspector-card${isNearLeaving ? " observer-inspector-card--warning" : ""}`}>
      <div className="observer-inspector-row observer-inspector-row--header">
        <span className="observer-inspector-label-name">{inspection.label}</span>
        <span className="observer-inspector-state">{presentation.agentStateLabels[inspection.state]}</span>
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
      <div className="observer-inspector-row">
        <span>再探索回数(参加失敗)</span>
        <span>
          {inspection.searchRestartCount}
          {inspection.capacityFailureCount > 0 ? `(うち満員起因 ${inspection.capacityFailureCount})` : ""}
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
              presentation={presentation}
              context={{
                scenarioId: presentation.id,
                seed,
                presetId,
                agent: agentById.get(entry.event.speakerId),
              }}
            />
          ))}
        </div>
      )}

      <div className="observer-inspector-divider" />

      <div className="observer-inspector-row observer-inspector-row--header">
        <span>現在作用中の発言効果</span>
      </div>
      <ActiveEffectSummaryList
        summaries={inspection.activeEffectSummaries}
        labelById={labelById}
        presentation={presentation}
      />

      <div className="observer-inspector-divider" />

      <div className="observer-inspector-row observer-inspector-row--header">
        <span>本心・建前・乖離(Phase 4)</span>
      </div>
      <SocialExpressionSection snapshot={inspection.socialExpression} />

      <div className="observer-inspector-divider" />

      <div className="observer-inspector-row observer-inspector-row--header">
        <span>話者ごとの信頼(trust)</span>
      </div>
      <TrustSummaryList summaries={inspection.trustSummaries} labelById={labelById} />

      <div className="observer-inspector-divider" />

      <div className="observer-inspector-row observer-inspector-row--header">
        <span>話者ごとの関係性補正</span>
      </div>
      <TieSummaryList summaries={inspection.tieSummaries} labelById={labelById} />
    </div>
  );
}

/** Issue #135: 学校ペア形成では全員分を一覧できるよう、割当履歴に絞ったcompact cardを使う */
function ClassroomInspectionCard({
  inspection,
  labelById,
  presentation,
  seed,
  presetId,
  agentById,
  groupCapacityById,
}: {
  inspection: ObserverJoinerInspection;
  labelById: Map<string, string>;
  presentation: ScenarioPresentation;
  seed?: number;
  presetId?: string;
  agentById: Map<string, SimulationState["agents"][number]>;
  groupCapacityById: ReadonlyMap<string, ClassroomGroupCapacityInfo>;
}) {
  const unitWord = presentation.groupUnit?.unitWord ?? "ペア";
  const currentGroupCapacity = inspection.currentGroupId
    ? groupCapacityById.get(inspection.currentGroupId)
    : undefined;

  return (
    <div
      className={`observer-inspector-card classroom-agent-inspector-card assignment-${inspection.assignmentStatus}`}
      data-assignment-status={inspection.assignmentStatus}
    >
      <div className="observer-inspector-row observer-inspector-row--header">
        <span className="observer-inspector-label-name">{inspection.label}</span>
        <span className="observer-inspector-state">{presentation.agentStateLabels[inspection.state]}</span>
      </div>
      <div className="observer-inspector-row">
        <span>割当状況</span>
        <strong>{ASSIGNMENT_STATUS_LABEL[inspection.assignmentStatus]}</strong>
      </div>
      <div className="observer-inspector-row">
        <span>接近先</span>
        <span title={inspection.approachTargetGroupId}>{inspection.approachTargetGroupId ?? "なし"}</span>
      </div>
      <div className="observer-inspector-row">
        <span>現在の{unitWord}候補</span>
        <span title={inspection.currentGroupId}>{inspection.currentGroupId ?? "なし"}</span>
      </div>
      {currentGroupCapacity && (
        <div className="observer-inspector-row" data-capacity-state={currentGroupCapacity.capacityState}>
          <span>{unitWord}の人数・容量</span>
          <span>
            現在{currentGroupCapacity.currentSize}人 / 最小{currentGroupCapacity.minGroupSize}人 / 最大
            {currentGroupCapacity.maxGroupSize}人・{CLASSROOM_GROUP_CAPACITY_STATE_LABEL[currentGroupCapacity.capacityState]}
          </span>
        </div>
      )}
      <div className="observer-inspector-row">
        <span>参加失敗</span>
        <span>{inspection.joinFailureCount}回</span>
      </div>
      <div className="observer-inspector-row">
        <span>再探索</span>
        <span>{inspection.searchRestartCount}回</span>
      </div>
      <div className="observer-inspector-row classroom-agent-inspector-last-failure">
        <span>直近の失敗理由</span>
        <span>
          {inspection.lastFailureReason
            ? `${APPROACH_FAILURE_REASON_LABEL[inspection.lastFailureReason]}（tick ${inspection.lastFailureTick}）`
            : "なし"}
        </span>
      </div>
      {inspection.speechHistory.length > 0 && (
        <details className="observer-inspector-effect-details classroom-agent-speech-details">
          <summary>関連する発言・認知・効果({inspection.speechHistory.length}件)</summary>
          <div className="observer-inspector-speech-list">
            {inspection.speechHistory.slice(-HISTORY_DISPLAY_LIMIT).map((entry, i, recentEntries) => (
              <SpeechHistoryEntry
                key={entry.event.id}
                entry={entry}
                detail={
                  inspection.speechEffectDetails[
                    inspection.speechEffectDetails.length - recentEntries.length + i
                  ]
                }
                labelById={labelById}
                presentation={presentation}
                context={{
                  scenarioId: presentation.id,
                  seed,
                  presetId,
                  agent: agentById.get(entry.event.speakerId),
                }}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export function ObserverJoinerInspector({ state, params, seed, presetId }: Props) {
  const presentation = getScenarioPresentation(state.formationScenarioId, state.formationClassroomGroupSize);
  const isClassroomPair = presentation.id === "classroomPair";
  const inspections = isClassroomPair
    ? buildAgentInspection(state, params)
    : buildObserverJoinerInspection(state, params);
  const labelById = buildAgentLabelMap(state.agents);
  const agentById = new Map(state.agents.map((agent) => [agent.id, agent]));
  // Issue #155: 現在人数・最小/最大人数・forming/confirmed-with-vacancy/fullをagentごとのカードで
  // 確認できるよう、候補ごとに一度だけ実際のFormationPolicy(#154で一般化済み)から容量を解決する。
  const formationPolicy = isClassroomPair
    ? getFormationPolicyById(
        state.formationScenarioId ?? "afterParty",
        state.formationDeadlineTick,
        state.formationClassroomGroupSize,
      )
    : undefined;
  const groupCapacityById = new Map<string, ClassroomGroupCapacityInfo>(
    formationPolicy
      ? state.groupCandidates
          .filter((candidate) => candidate.status === "forming" || candidate.status === "confirmed")
          .map((candidate) => {
            const capacity = formationPolicy.resolveGroupCapacity(candidate, params);
            const currentSize = candidate.memberIds.length;
            const capacityState: ClassroomGroupCapacityInfo["capacityState"] =
              currentSize >= capacity.maxGroupSize ? "full" : candidate.status === "confirmed" ? "confirmed-vacancy" : "forming";
            return [
              candidate.id,
              {
                currentSize,
                minGroupSize: capacity.minGroupSize,
                maxGroupSize: capacity.maxGroupSize,
                capacityState,
              },
            ];
          })
      : [],
  );

  return (
    <div className={`panel observer-inspector${isClassroomPair ? " classroom-agent-inspector" : ""}`}>
      <h2>{isClassroomPair ? "エージェントインスペクター" : "observerJoinerインスペクター"}</h2>
      {inspections.length === 0 ? (
        <p className="observer-inspector-empty">
          {isClassroomPair ? "エージェントがいません。" : "observerJoinerがいません。"}
        </p>
      ) : isClassroomPair ? (
        <div className="classroom-agent-inspector-grid">
          {inspections.map((inspection) => (
            <ClassroomInspectionCard
              key={inspection.agentId}
              inspection={inspection}
              labelById={labelById}
              presentation={presentation}
              seed={seed}
              presetId={presetId}
              agentById={agentById}
              groupCapacityById={groupCapacityById}
            />
          ))}
        </div>
      ) : (
        inspections.map((inspection) => (
          <InspectionCard
            key={inspection.agentId}
            inspection={inspection}
            labelById={labelById}
            presentation={presentation}
            seed={seed}
            presetId={presetId}
            agentById={agentById}
          />
        ))
      )}
    </div>
  );
}
