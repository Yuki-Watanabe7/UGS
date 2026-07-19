import type { Agent, GroupCandidate } from "../simulation/types";
import type { FormationScenarioId } from "../simulation/formationPolicy";
import type { ExpressionIntent } from "../simulation/expression";
import type { SpeechIntent } from "../simulation/speech";
import { ThoughtBubble } from "./ThoughtBubble";
import { SpeechBubble } from "./SpeechBubble";
import { computeThoughtBubbleLayouts, type ThoughtBubblePlacementInput } from "./thoughtBubbleLayout";
import { getScenarioPresentation, type ScenarioPresentation } from "../presentation/scenarioPresentation";

/**
 * 表示すべき心の声1件分。文言生成・寿命管理は呼び出し側(表示管理レイヤー)の責務で、ここでは受け取るだけ。
 * `isObserverJoiner`/`intent`は描画そのものには使わないが、呼び出し側(App.tsx)の表示設定フィルタ
 * (`expressionDisplayFilter.ts`)がここを経由せず素通しできるよう、型として保持しておく。
 */
export type ThoughtBubbleDisplay = {
  agentId: string;
  text: string;
  isObserverJoiner?: boolean;
  intent?: ExpressionIntent;
};

/**
 * 表示すべき発言(`SpeechEvent`)1件分。`agentId`は発言者(`SpeechEvent.speakerId`)を指し、
 * 吹き出しは発言者の位置に追従する。文言(宛先の補助表現込み)・寿命管理は呼び出し側
 * (`useActiveSpeechBubbles`)の責務。
 */
export type SpeechBubbleDisplay = {
  agentId: string;
  text: string;
  isObserverJoiner?: boolean;
  intent?: SpeechIntent;
  /**
   * Issue #119: 乖離場面での本心(心の声)側文言。設定されている場合、この発言(建前=`text`)と対に
   * 本心吹き出しを同時表示し、本心と建前のずれを視認できるようにする(非乖離発言ではundefined)。
   */
  innerThought?: string;
};

type Props = {
  agents: Agent[];
  groupCandidates: GroupCandidate[];
  width: number;
  height: number;
  /** Issue #135: 学校ペア形成でのみ容量・割当状態を詳しく表示する */
  formationScenarioId?: FormationScenarioId;
  /** 現在表示すべき心の声。未指定/空配列なら既存のCanvas表示から変化しない */
  thoughts?: ThoughtBubbleDisplay[];
  /** 現在表示すべき発言。未指定/空配列なら発言吹き出しは表示しない */
  speeches?: SpeechBubbleDisplay[];
};

function stateColor(agent: Agent, showClassroomAssignmentState: boolean): string {
  switch (agent.state) {
    case "undecided":
      if (showClassroomAssignmentState && (agent.searchRestartCount ?? 0) > 0) return "#eab308";
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
    case "unassigned":
      return showClassroomAssignmentState ? "#db2777" : "#9ca3af";
    default:
      return "#9ca3af";
  }
}

function agentStateClass(agent: Agent, showClassroomAssignmentState: boolean): string {
  if (showClassroomAssignmentState && agent.state === "unassigned") return "unassigned";
  if (showClassroomAssignmentState && agent.state === "undecided" && (agent.searchRestartCount ?? 0) > 0) {
    return "searching-again";
  }
  return agent.state;
}

function agentStatusLabel(agent: Agent): string | undefined {
  if (agent.state === "unassigned") return "未割当";
  if (agent.state === "undecided" && (agent.searchRestartCount ?? 0) > 0) return "再探索";
  return undefined;
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

function candidateLabel(candidate: GroupCandidate, presentation: ScenarioPresentation): string {
  switch (candidate.status) {
    case "confirmed":
      return presentation.canvas.confirmedCandidate;
    case "dissolving":
    case "dissolved":
      return presentation.canvas.dissolvedCandidate;
    case "expired":
      return presentation.canvas.expiredCandidate;
    default:
      return presentation.canvas.formingCandidate;
  }
}

type ClassroomCandidateVisualState = "waiting" | "approaching" | "full" | "resolved";

function classroomCandidateMaxSize(candidate: GroupCandidate): number {
  return candidate.maxGroupSize !== undefined && Number.isFinite(candidate.maxGroupSize)
    ? candidate.maxGroupSize
    : 2;
}

function candidateApproachers(candidate: GroupCandidate, agents: Agent[]): Agent[] {
  return agents.filter((agent) => agent.state === "approaching" && agent.joinedGroupId === candidate.id);
}

function classroomCandidateState(
  candidate: GroupCandidate,
  agents: Agent[],
): ClassroomCandidateVisualState {
  if (
    candidate.status === "dissolving" ||
    candidate.status === "dissolved" ||
    candidate.status === "expired"
  ) {
    return "resolved";
  }
  if (
    candidate.status === "confirmed" ||
    candidate.memberIds.length >= classroomCandidateMaxSize(candidate)
  ) {
    return "full";
  }
  return candidateApproachers(candidate, agents).length > 0 ? "approaching" : "waiting";
}

function classroomCandidateStateLabel(state: ClassroomCandidateVisualState): string {
  switch (state) {
    case "waiting":
      return "相手待ち";
    case "approaching":
      return "接近者あり";
    case "full":
      return "ペア確定・満員";
    case "resolved":
      return "解消済み";
  }
}

type BubblePlacementInput = ThoughtBubblePlacementInput & { isObserverJoiner?: boolean };

/**
 * 表示すべき心の声を、対応するagentが存在するものだけ配置用の入力へ変換する。
 * `excludeAgentIds`に含まれるagentId(=現在発言吹き出しを表示中のagent)は除外する
 * (「心の声と発言が競合したら発言を優先する」方針。呼び出し元(`SimulationCanvas`)が
 * `speeches`の話者agentIdを渡す)。
 * observerJoinerを先頭に寄せて`computeThoughtBubbleLayouts`へ渡すことで、
 * 重ならない候補位置(above/below/right/left)をobserverJoiner優先で確保させる
 * (吹き出しの表示可否そのものの優先度制御はuseActiveExpressions側の責務)。
 */
function buildThoughtPlacementInputs(
  agents: Agent[],
  thoughts: ThoughtBubbleDisplay[],
  width: number,
  height: number,
  excludeAgentIds: ReadonlySet<string>,
): BubblePlacementInput[] {
  return thoughts
    .filter((thought) => !excludeAgentIds.has(thought.agentId))
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

/**
 * 表示すべき発言を、対応するagentが存在するものだけ配置用の入力へ変換する。
 * 心の声と同様、observerJoinerを先頭に寄せる。
 */
function buildSpeechPlacementInputs(
  agents: Agent[],
  speeches: SpeechBubbleDisplay[],
  width: number,
  height: number,
): BubblePlacementInput[] {
  return speeches
    .map((speech) => {
      const agent = agents.find((a) => a.id === speech.agentId);
      if (!agent) return undefined;
      return {
        agentId: speech.agentId,
        agentX: agent.x,
        agentY: agent.y,
        agentRadius: radiusFor(agent),
        text: speech.text,
        canvasWidth: width,
        canvasHeight: height,
        isObserverJoiner: agent.isObserverJoiner,
      };
    })
    .filter((input): input is NonNullable<typeof input> => input !== undefined)
    .sort((a, b) => Number(b.isObserverJoiner) - Number(a.isObserverJoiner));
}

/**
 * 発言吹き出しのlayout keyと衝突しないよう、本心オーバーレイ用に付与する接尾辞(Issue #119)。
 * 同一話者について「発言(建前)」と「本心」を別々のlayoutとして配置・描画するため、
 * `computeThoughtBubbleLayouts`のagentId基準のkeyを別物にする必要がある。
 */
const INNER_THOUGHT_KEY_SUFFIX = "\0inner";

/**
 * 乖離発言(`innerThought`を持つSpeechBubbleDisplay)から、本心(心の声)側の配置用入力を作る(Issue #119)。
 * layout keyは発言側と衝突しない接尾辞付きにし、tailは話者本体を指す(発言吹き出しと同一話者へ並ぶ)。
 */
function buildInnerThoughtPlacementInputs(
  agents: Agent[],
  speeches: SpeechBubbleDisplay[],
  width: number,
  height: number,
): BubblePlacementInput[] {
  return speeches
    .map((speech) => {
      if (!speech.innerThought) return undefined;
      const agent = agents.find((a) => a.id === speech.agentId);
      if (!agent) return undefined;
      return {
        agentId: `${speech.agentId}${INNER_THOUGHT_KEY_SUFFIX}`,
        agentX: agent.x,
        agentY: agent.y,
        agentRadius: radiusFor(agent),
        text: speech.innerThought,
        canvasWidth: width,
        canvasHeight: height,
        isObserverJoiner: agent.isObserverJoiner,
      };
    })
    .filter((input): input is NonNullable<typeof input> => input !== undefined)
    .sort((a, b) => Number(b.isObserverJoiner) - Number(a.isObserverJoiner));
}

export function SimulationCanvas({
  agents,
  groupCandidates,
  width,
  height,
  formationScenarioId,
  thoughts = [],
  speeches = [],
}: Props) {
  const presentation = getScenarioPresentation(formationScenarioId);
  const isClassroomPair = presentation.id === "classroomPair";
  const speakingAgentIds = new Set(speeches.map((speech) => speech.agentId));
  const speechInputs = buildSpeechPlacementInputs(agents, speeches, width, height);
  // Issue #119: 乖離発言では本心(心の声)を発言と対に同時表示する。話者本人の通常の心の声は
  // 引き続き除外(`speakingAgentIds`)し、代わりにこの本心オーバーレイを別layoutとして並べる。
  const innerThoughtInputs = buildInnerThoughtPlacementInputs(agents, speeches, width, height);
  const thoughtInputs = buildThoughtPlacementInputs(agents, thoughts, width, height, speakingAgentIds);
  // 発言を先に並べてcomputeThoughtBubbleLayoutsへ渡すことで、重ならない候補位置の
  // 確保を発言吹き出し優先で行う(心の声と発言の間の重なりも避けるため、まとめて同じ衝突回避に通す)。
  // 本心オーバーレイは対になる発言の直後に置き、発言側の配置を優先させる。
  const bubbleLayouts = computeThoughtBubbleLayouts([...speechInputs, ...innerThoughtInputs, ...thoughtInputs]);

  return (
    <div className="panel canvas-panel">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={presentation.canvas.ariaLabel}
      >
        <rect x={0} y={0} width={width} height={height} className="canvas-bg" />

        {isClassroomPair &&
          agents.map((agent) => {
            if (agent.state !== "approaching" || !agent.joinedGroupId) return null;
            const target = groupCandidates.find((candidate) => candidate.id === agent.joinedGroupId);
            if (!target) return null;
            return (
              <line
                key={`approach-${agent.id}-${target.id}`}
                x1={agent.x}
                y1={agent.y}
                x2={target.x}
                y2={target.y}
                className="approach-link"
                aria-label={`${agent.label}からペア候補 ${target.id} への接近`}
              />
            );
          })}

        {groupCandidates.map((candidate) => {
          const fading =
            candidate.status === "dissolving" ||
            candidate.status === "dissolved" ||
            candidate.status === "expired";
          const classroomState = isClassroomPair ? classroomCandidateState(candidate, agents) : undefined;
          const maxSize = classroomCandidateMaxSize(candidate);
          const openSlots = Math.max(0, maxSize - candidate.memberIds.length);
          return (
            <g
              key={candidate.id}
              opacity={fading ? 0.35 : 1}
              data-candidate-state={classroomState}
              aria-label={
                classroomState
                  ? `ペア候補 ${candidate.id}: ${classroomCandidateStateLabel(classroomState)}、${candidate.memberIds.length}/${maxSize}、空き${openSlots}`
                  : undefined
              }
            >
              <circle
                cx={candidate.x}
                cy={candidate.y}
                r={54}
                className={
                  classroomState
                    ? `candidate-ring classroom-${classroomState}`
                    : candidateRingClass(candidate)
                }
              />

              <text x={candidate.x} y={candidate.y - 60} className="candidate-label">
                {classroomState
                  ? classroomCandidateStateLabel(classroomState)
                  : `${candidateLabel(candidate, presentation)} (${candidate.memberIds.length})`}
              </text>
              {classroomState && (
                <text x={candidate.x} y={candidate.y - 44} className="candidate-capacity-label">
                  {candidate.memberIds.length} / {maxSize}（空き{openSlots}）
                </text>
              )}
            </g>
          );
        })}

        {agents.map((agent) => {
          const r = radiusFor(agent);
          const opacity = agent.state === "left" ? 0.3 : 1;
          const statusLabel = isClassroomPair ? agentStatusLabel(agent) : undefined;
          const stateClass = agentStateClass(agent, isClassroomPair);
          return (
            <g key={agent.id} opacity={opacity} data-agent-state={stateClass}>
              <circle
                cx={agent.x}
                cy={agent.y}
                r={r}
                fill={stateColor(agent, isClassroomPair)}
                className={`agent-dot ${stateClass}${agent.isObserverJoiner ? " observer" : ""}`}
              />
              <text x={agent.x} y={agent.y - r - 4} className="agent-label">
                {agent.label}
              </text>
              {statusLabel && (
                <text x={agent.x} y={agent.y + r + 13} className={`agent-status-label ${stateClass}`}>
                  {statusLabel}
                </text>
              )}
            </g>
          );
        })}

        {speechInputs.map((input) => {
          const layout = bubbleLayouts.get(input.agentId);
          if (!layout) return null;
          return <SpeechBubble key={`speech-${input.agentId}`} layout={layout} isObserverJoiner={input.isObserverJoiner} />;
        })}

        {innerThoughtInputs.map((input) => {
          const layout = bubbleLayouts.get(input.agentId);
          if (!layout) return null;
          // 本心オーバーレイは心の声(ThoughtBubble)として描画し、発言(建前)との種別の違いを視覚的に示す
          return <ThoughtBubble key={`inner-${input.agentId}`} layout={layout} isObserverJoiner={input.isObserverJoiner} />;
        })}

        {thoughtInputs.map((input) => {
          const layout = bubbleLayouts.get(input.agentId);
          if (!layout) return null;
          return <ThoughtBubble key={`thought-${input.agentId}`} layout={layout} isObserverJoiner={input.isObserverJoiner} />;
        })}
      </svg>

      {isClassroomPair && (
        <section className="canvas-pair-status" aria-label="ペア候補の進行状況と空き枠">
          <h3>ペア候補の進行状況</h3>
          {groupCandidates.length === 0 ? (
            <p className="canvas-pair-status-empty">現在のペア候補はありません</p>
          ) : (
            <ul className="canvas-pair-status-list">
              {groupCandidates.map((candidate) => {
                const state = classroomCandidateState(candidate, agents);
                const maxSize = classroomCandidateMaxSize(candidate);
                const openSlots = Math.max(0, maxSize - candidate.memberIds.length);
                const approachers = candidateApproachers(candidate, agents);
                return (
                  <li key={candidate.id} className={`canvas-pair-status-item ${state}`}>
                    <span className="canvas-pair-status-id" title={candidate.id}>
                      {candidate.id}
                    </span>
                    <strong>{classroomCandidateStateLabel(state)}</strong>
                    <span>
                      {candidate.memberIds.length}/{maxSize}・空き{openSlots}
                    </span>
                    {approachers.length > 0 && (
                      <span className="canvas-pair-status-approachers">
                        接近: {approachers.map((agent) => agent.label).join("、")}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
