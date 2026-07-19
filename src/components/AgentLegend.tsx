import {
  AFTER_PARTY_PRESENTATION,
  type ScenarioPresentation,
} from "../presentation/scenarioPresentation";

export function AgentLegend({
  presentation = AFTER_PARTY_PRESENTATION,
}: {
  presentation?: ScenarioPresentation;
}) {
  return (
    <div className="panel legend">
      <h2>凡例</h2>
      <ul>
        {presentation.legend.items.map((item) => (
          <li key={item.label}>
            <span className="dot" style={{ backgroundColor: item.color }} />
            {item.label}
          </li>
        ))}
      </ul>
      <p className="legend-note">{presentation.legend.note}</p>
    </div>
  );
}
