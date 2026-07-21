import type { InterventionCategory, InterventionScenarioId } from "../simulation/interventions";
import { getInterventionById, INTERVENTION_SCENARIOS } from "../simulation/interventions";

type Props = {
  interventionId: InterventionScenarioId;
  onInterventionChange: (interventionId: InterventionScenarioId) => void;
  availableInterventionIds?: readonly InterventionScenarioId[];
};

const CATEGORY_LABEL: Record<InterventionCategory, string> = {
  none: "—",
  publicCoordination: "場の調整",
  socialPermission: "社会的許可",
  targetedSupport: "個別への働きかけ",
  timeDesign: "時間設計",
};

/** どの観察指標(Monte Carlo集計値)に効きやすいかの目安。engine.tsのロジックに基づく目視での対応付け */
const LIKELY_METRICS: Record<InterventionScenarioId, string> = {
  none: "—",
  "explicit-meeting-point": "平均グループ成立tick / グループ不成立率",
  "late-join-ok": "後乗り成功率 / observerJoiner参加率",
  "light-observer-invitation": "observerJoiner参加率 / observerJoiner離脱率",
  "short-ambiguity-window": "グループ不成立率 / observerJoiner離脱率",
  "predecided-venue": "後乗り成功率 / 平均グループ成立tick",
  "anonymous-low-pressure-intent": "observerJoiner参加率 / 平均グループ成立tick",
  "nearby-peer-prompt": "平均ペア/班成立tick / 未割当率",
  "open-group-signal": "平均ペア/班成立tick / 未割当率",
  "anonymous-help-signal": "未割当率 / 平均ペア/班成立tick",
  "teacher-recommendation": "未割当率 / 平均ペア/班成立tick",
};

export function InterventionSelector({
  interventionId,
  onInterventionChange,
  availableInterventionIds = INTERVENTION_SCENARIOS.map((candidate) => candidate.id),
}: Props) {
  const scenario = getInterventionById(interventionId);
  const availableScenarios = INTERVENTION_SCENARIOS.filter((candidate) =>
    availableInterventionIds.includes(candidate.id),
  );

  return (
    <div className="panel intervention-selector">
      <h2>介入シナリオ</h2>
      <label className="field">
        <span>介入</span>
        <select
          value={interventionId}
          onChange={(e) => onInterventionChange(e.target.value as InterventionScenarioId)}
        >
          {availableScenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      <div className="intervention-description">
        <p className="intervention-description-text">{scenario.description}</p>
        {scenario.id !== "none" && (
          <>
            <p className="intervention-description-row">
              <span className="intervention-description-label">期待される効果</span>
              {scenario.expectedEffect}
            </p>
            <p className="intervention-description-row">
              <span className="intervention-description-label">分類</span>
              {CATEGORY_LABEL[scenario.category]}
            </p>
            <p className="intervention-description-row">
              <span className="intervention-description-label">効きやすい観察指標</span>
              {LIKELY_METRICS[scenario.id]}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
