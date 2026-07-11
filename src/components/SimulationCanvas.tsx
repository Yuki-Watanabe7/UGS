import type { Agent, GroupCandidate } from "../simulation/types";
import { ThoughtBubble } from "./ThoughtBubble";
import { computeThoughtBubbleLayouts } from "./thoughtBubbleLayout";

/** 表示すべき心の声1件分。文言生成・寿命管理は呼び出し側(表示管理レイヤー)の責務で、ここでは受け取るだけ */
export type ThoughtBubbleDisplay = {
  agentId: string;
  text: string;
};

type Props = {
  agents: Agent[];
  groupCandidates: GroupCandidate[];
  width: number;
  height: number;
  /** 現在表示すべき心の声。未指定/空配列なら既存のCanvas表示から変化しない */
  thoughts?: ThoughtBubbleDisplay[];
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

function candidateRingClass(candidate: GroupCandidate): string {
  switch (candidate.status) {
    case "confirmed":
      return "candidate-ring confirmed";
    case "dissolving":
    case "dissolved":
      return "candidate-ring dissolving";
    case "expired":
      return "candidate-ring expired";
    default:
      return "candidate-ring";
  }
}

function candidateLabel(candidate: GroupCandidate): string {
  switch (candidate.status) {
    case "confirmed":
      return "二次会グループ";
    case "dissolving":
    case "dissolved":
      return "解散した輪";
    case "expired":
      return "時間切れの輪";
    default:
      return "形成中の輪";
  }
}

/**
 * 表示すべき心の声を、対応するagentが存在するものだけ配置用の入力へ変換する。
 * observerJoinerを先頭に寄せて`computeThoughtBubbleLayouts`へ渡すことで、
 * 重ならない候補位置(above/below/right/left)をobserverJoiner優先で確保させる
 * (吹き出しの表示可否そのものの優先度制御はuseActiveExpressions側の責務)。
 */
function buildThoughtPlacementInputs(agents: Agent[], thoughts: ThoughtBubbleDisplay[], width: number, height: number) {
  return thoughts
    .map((thought) => {
      const agent = agents.find((a) => a.id === thought.agentId);
      if (!agent) return undefined;
      return {
        agentId: thought.agentId,
        agentX: agent.x,
        agentY: agent.y,
        agentRadius: radiusFor(agent),
        text: thought.text,
        canvasWidth: width,
        canvasHeight: height,
        isObserverJoiner: agent.isObserverJoiner,
      };
    })
    .filter((input): input is NonNullable<typeof input> => input !== undefined)
    .sort((a, b) => Number(b.isObserverJoiner) - Number(a.isObserverJoiner));
}

export function SimulationCanvas({ agents, groupCandidates, width, height, thoughts = [] }: Props) {
  const thoughtInputs = buildThoughtPlacementInputs(agents, thoughts, width, height);
  const thoughtLayouts = computeThoughtBubbleLayouts(thoughtInputs);

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

        {groupCandidates.map((candidate) => {
          const fading =
            candidate.status === "dissolving" ||
            candidate.status === "dissolved" ||
            candidate.status === "expired";
          return (
            <g key={candidate.id} opacity={fading ? 0.35 : 1}>
              <circle cx={candidate.x} cy={candidate.y} r={54} className={candidateRingClass(candidate)} />

              <text x={candidate.x} y={candidate.y - 60} className="candidate-label">
                {candidateLabel(candidate)} ({candidate.memberIds.length})
              </text>
            </g>
          );
        })}

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

        {thoughtInputs.map((input) => {
          const layout = thoughtLayouts.get(input.agentId);
          if (!layout) return null;
          return <ThoughtBubble key={input.agentId} layout={layout} isObserverJoiner={input.isObserverJoiner} />;
        })}
      </svg>
    </div>
  );
}
