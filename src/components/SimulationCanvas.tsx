import type { Agent, GroupCandidate } from "../simulation/types";

type Props = {
  agents: Agent[];
  groupCandidates: GroupCandidate[];
  width: number;
  height: number;
};

function stateColor(agent: Agent): string {
  switch (agent.state) {
    case "undecided":
      return agent.isObserverJoiner ? "#f97316" : "#9ca3af";
    case "forming":
      return "#a855f7";
    case "approaching":
      return agent.isObserverJoiner ? "#f97316" : "#3b82f6";
    case "joined":
      return "#22c55e";
    case "leaving":
    case "left":
      return "#ef4444";
    default:
      return "#9ca3af";
  }
}

function radiusFor(agent: Agent): number {
  const base = 9;
  const leaderBonus = agent.initiative > 0.6 ? 4 : 0;
  const observerBonus = agent.isObserverJoiner ? 2 : 0;
  return base + leaderBonus + observerBonus;
}

export function SimulationCanvas({ agents, groupCandidates, width, height }: Props) {
  return (
    <div className="panel canvas-panel">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="グループ形成シミュレーション領域"
      >
        <rect x={0} y={0} width={width} height={height} className="canvas-bg" />

        {groupCandidates.map((candidate) => (
          <g key={candidate.id}>
            <circle
              cx={candidate.x}
              cy={candidate.y}
              r={54}
              className={candidate.confirmed ? "candidate-ring confirmed" : "candidate-ring"}
            />
            <text x={candidate.x} y={candidate.y - 60} className="candidate-label">
              {candidate.confirmed ? "二次会グループ" : "形成中の輪"} ({candidate.memberIds.length})
            </text>
          </g>
        ))}

        {agents.map((agent) => {
          const r = radiusFor(agent);
          const opacity = agent.state === "left" ? 0.3 : 1;
          return (
            <g key={agent.id} opacity={opacity}>
              <circle
                cx={agent.x}
                cy={agent.y}
                r={r}
                fill={stateColor(agent)}
                className={agent.isObserverJoiner ? "agent-dot observer" : "agent-dot"}
              />
              <text x={agent.x} y={agent.y - r - 4} className="agent-label">
                {agent.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
