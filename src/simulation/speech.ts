import type { SimulationState } from "./types";

/**
 * `SpeechEvent`が意味する発言の分類。「その発言が何を伝えるものか」を表す。
 * Phase 2が扱うのは、誘う("invite")・歓迎する("welcome")・合流を告げる("greet")・
 * 辞退を告げる("decline")の4種のみ。
 */
export type SpeechIntent = "invite" | "welcome" | "greet" | "decline";

/**
 * 発言が発生した構造的な理由。`SpeechEvent.textKey`のテンプレート参照キーにも使う。
 * - "initiativeFormedCore" / "cliqueFormedCore": 核形成時に founder が周囲を誘う発言
 *   (`ExpressionReason`の同名値と対応する状況だが、こちらは実際にエージェントが発した発言を表す)。
 * - "formingGroupRecruitment": 既にできかけている核に新たな一人が加わる際、founder(その核の
 *   memberIds[0])が重ねて周囲を誘う発言。
 * - "approachWelcome": undecidedがforming/confirmedな輪へ接近を始めた際、その輪の代表
 *   (memberIds[0])が接近者に向けて発する歓迎の発言。
 * - "joinGreeting": 輪への到着・グループ成立により合流した本人が発する合流挨拶。
 * - "leaveDeclaration": 曖昧な時間に耐えられず離脱を始めた本人が発する、辞退・帰宅表明。
 * - "lightObserverInvitation": `light-observer-invitation`介入で、observerJoinerに軽く声をかける発言。
 */
export type SpeechReason =
  | "initiativeFormedCore"
  | "cliqueFormedCore"
  | "formingGroupRecruitment"
  | "approachWelcome"
  | "joinGreeting"
  | "leaveDeclaration"
  | "lightObserverInvitation";

/** 発言が届く範囲。特定の1人ではなく周囲へ向けた発言の場合に設定される(`target`とは排他) */
export type SpeechAudience = "nearby";

/**
 * エージェントが実際に行う「発言」を表す第一級のシミュレーションイベント。
 *
 * Phase 1の`ExpressionEvent`(`expression.ts`)との責務差:
 * - `ExpressionEvent`: 観察者にのみ見える非介入の演出データ。`SimulationState`には保持されず、
 *   他エージェントに認知されない「心の声」。状態遷移や乱数列に一切影響しない。
 * - `SpeechEvent`: シミュレーション上で実際に発せられ、他エージェントが認知しうる発言。
 *   `SimulationState.speechLog`に記録として蓄積される第一級イベント。
 *
 * Phase 2時点のスコープ(重要): 発言イベントを生成・記録・表示できる基盤を作るところまでを担う。
 * この発言を「聞いた」他エージェントのstress/attractiveness/参加・離脱判断を変化させる介入効果は
 * 一切持たない(それらはPhase 3で扱う)。`createSpeechEvent`はこの境界を越えず、`SimulationState`や
 * 他エージェントを一切参照・変更しない純粋な生成関数として保つこと。
 */
export type SpeechEvent = {
  id: string;
  tick: number;
  speakerId: string;
  intent: SpeechIntent;
  reason: SpeechReason;
  /** 発言の名宛先。特定の1人に向けた発言(observerJoinerへの声かけ等)の場合のみ設定される。`audience`とは排他 */
  target?: string;
  /** 発言が届く範囲。周囲全体に向けた発言の場合のみ設定される。`target`とは排他 */
  audience?: SpeechAudience;
  /** 表示文言そのものではなく、テンプレート参照キー。実際の文言解決はUI側の責務(`speechTemplates.ts`) */
  textKey: string;
};

export type CreateSpeechEventInput = {
  tick: number;
  speakerId: string;
  intent: SpeechIntent;
  reason: SpeechReason;
  target?: string;
  audience?: SpeechAudience;
  /**
   * id生成のみに使う衝突回避用の追加識別子(`SpeechEvent`のフィールドには含まれない)。
   * 同一tick・同一speakerId・同一reasonの発言が複数回起こりうる場合(例:
   * "formingGroupRecruitment"で同じfounderが同一tick内に複数人を誘う)、target/audienceの
   * 意味を変えずにidだけを一意にするために、遷移した相手のagent idなどを渡す。
   * `target`が設定されている場合はそちらが既に一意性を持つためidSuffixは無視される。
   */
  idSuffix?: string;
};

/**
 * `SpeechEvent`を組み立てる唯一の生成口(発言生成境界)。engine.tsはこの関数を通してのみ
 * SpeechEventを作り、`id`/`textKey`の組み立てルールをここに集約することで生成箇所ごとの
 * 表記ゆれを防ぐ。`SimulationState`・`SeededRandom`のいずれも受け取らない純粋関数。
 *
 * `id`は`tick`/`speakerId`/`reason`だけでは、同一tickに同じspeakerが同じreasonで複数回
 * 発言しうるケース(1人のfounder/welcomerが同一tick内で複数の相手に対応する場合)で衝突する。
 * `target`(またはそれがない場合は`idSuffix`)を末尾に含めて一意性を担保する。
 */
export function createSpeechEvent(input: CreateSpeechEventInput): SpeechEvent {
  const disambiguator = input.target ?? input.idSuffix;
  return {
    id: `speech-${input.tick}-${input.speakerId}-${input.reason}${disambiguator ? `-${disambiguator}` : ""}`,
    tick: input.tick,
    speakerId: input.speakerId,
    intent: input.intent,
    reason: input.reason,
    target: input.target,
    audience: input.audience,
    textKey: `speech.${input.reason}`,
  };
}

/**
 * 直前/直後のシミュレーション状態を比較し、状態遷移そのものから一意に発言主体・発言内容が
 * 決まる`SpeechEvent`を導出する純粋関数(`deriveExpressionEvents`と同様の設計だが、
 * 責務は混在させない。ExpressionEventの生成には一切関与しない)。
 *
 * ここで扱うのは、遷移の当事者(またはその輪の代表=`GroupCandidate.memberIds[0]`、
 * 常に既存のagentを指す)だけからspeakerIdを一意に特定できる4つのreasonのみ。
 * 核形成(nucleusCreated)・`light-observer-invitation`招待は、rngで選ばれた発言主体を
 * state差分だけから復元できないため対象外とし、engine.ts側で直接`createSpeechEvent`を呼ぶ。
 *
 * `SimulationState`・`SeededRandom`のいずれも受け取らず、mutationもしない。
 */
export function deriveSpeechEvents(previousState: SimulationState, nextState: SimulationState): SpeechEvent[] {
  const events: SpeechEvent[] = [];
  const previousById = new Map(previousState.agents.map((a) => [a.id, a]));

  for (const agent of nextState.agents) {
    const previousAgent = previousById.get(agent.id);
    if (!previousAgent) continue;

    if (previousAgent.state === "undecided" && agent.state === "forming") {
      // memberIds[0]は常にその核を最初に立てたfounder。自分自身がfounderの場合は
      // 新規核形成(nucleusCreated)側でengine.tsが既に発言しているのでここでは扱わない。
      const candidate = nextState.groupCandidates.find(
        (c) => c.status === "forming" && c.memberIds.includes(agent.id),
      );
      const founderId = candidate?.memberIds[0];
      if (founderId && founderId !== agent.id) {
        events.push(
          createSpeechEvent({
            tick: nextState.tick,
            speakerId: founderId,
            intent: "invite",
            reason: "formingGroupRecruitment",
            audience: "nearby",
            idSuffix: agent.id,
          }),
        );
      }
    }

    if (previousAgent.state === "undecided" && agent.state === "approaching") {
      const candidate = nextState.groupCandidates.find((c) => c.id === agent.joinedGroupId);
      const welcomerId = candidate?.memberIds[0];
      if (welcomerId) {
        events.push(
          createSpeechEvent({
            tick: nextState.tick,
            speakerId: welcomerId,
            intent: "welcome",
            reason: "approachWelcome",
            target: agent.id,
          }),
        );
      }
    }

    if ((previousAgent.state === "approaching" || previousAgent.state === "forming") && agent.state === "joined") {
      events.push(
        createSpeechEvent({
          tick: nextState.tick,
          speakerId: agent.id,
          intent: "greet",
          reason: "joinGreeting",
          audience: "nearby",
        }),
      );
    }

    if (previousAgent.state === "undecided" && agent.state === "leaving") {
      events.push(
        createSpeechEvent({
          tick: nextState.tick,
          speakerId: agent.id,
          intent: "decline",
          reason: "leaveDeclaration",
          audience: "nearby",
        }),
      );
    }
  }

  return events;
}
