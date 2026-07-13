import type { SimulationState } from "./types";
import type { ExpressedStance } from "./socialExpression";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./model";

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
 * Issue #115: 発話時点の対外表現(乖離適用後の`PublicExpression`、`socialExpression.ts`)への
 * 参照スナップショット。後段(#116の真実性評価)が、この発言が本心とずれていたかを
 * 発言記録だけから評価できるようにするための最小限のフィールド。
 * `PublicExpression`自体は`SimulationState`に保持されない(呼び出し側が都度導出する)ため、
 * id参照に加えて評価に必要なスタンス・乖離有無を発話時点の値として複製して保持する。
 */
export type SpeechExpressionLink = {
  /** 発話時点の`PublicExpression.id`(`public-${tick}-${agentId}`、決定的に再導出可能) */
  publicExpressionId: string;
  /** 導出元の`PrivateEvaluation.id`(本心側への因果追跡リンク) */
  privateEvaluationId: string;
  /** 発話時点で本心と対外表現に乖離があったか(`PublicExpression.divergent`) */
  divergent: boolean;
  /** 発話時点の本心側スタンス(例: "positive"=参加希望) */
  privateStance: ExpressedStance;
  /** 発話時点の対外表現側スタンス(例: "none"=無表明) */
  expressedStance: ExpressedStance;
  /**
   * 乖離調整前の基礎intent(状態遷移由来の「本心がそのまま発言になる」場合のintent)。
   * `SpeechEvent.intent`と異なる場合、この発言は乖離により内容が変わった発言
   * (例: 遠慮によりinviteがgreetへ軟化)であることを表す。
   */
  baseIntent: SpeechIntent;
};

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
 *
 * Phase 4の三層モデル(`socialExpression.ts`)における位置づけ: `SpeechEvent`は
 * 対外表現(`PublicExpression`)側が実際の発言として観測されたものにあたる(本心側の観察表現は
 * `ExpressionEvent`)。Issue #115により、Phase 4有効時は生成された発言が発話時点の対外表現
 * (乖離適用後)に基づいて調整され(`applyPublicExpressionsToSpeech`、socialExpression.ts)、
 * `expression`フィールドで発話時点の本心とのずれを追跡できる。この調整は`createSpeechEvent`/
 * `deriveSpeechEvents`(いずれも本心=行動=発言前提の基礎生成)の後段で適用されるため、
 * 本ファイルの生成関数自体は引き続き乖離を知らない。
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
  /**
   * 発言時点の話者位置(x, y)のimmutableなスナップショット(Phase 3.1、Issue #94)。
   * `speechEffects.ts`の`deriveSpeechReceptions`はこの値を基準に受け手までの距離を計算するため、
   * 発言後にagentが移動してもこのフィールド自体は変化しない(認知結果が発言後の移動やReplay・
   * Canvas表示状態で変わらないことの技術的な保証)。
   */
  originX: number;
  originY: number;
  /** 発言が届きうる基礎距離(到達範囲)。認知判定の実際の閾値は`audibility`(= range * strength)を使う */
  range: number;
  /** 発言の強さ。rangeへの倍率として働く(叫ぶ/ささやく等、将来の強弱表現の余地として持たせる) */
  strength: number;
  /**
   * 認知判定に使う実際の閾値距離(= range * strength)。`speechEffects.ts`の`deriveSpeechReceptions`が
   * 受け手候補との距離と比較する値そのもので、生成時に一度だけ計算される。
   */
  audibility: number;
  /**
   * Issue #115: 発話時点の対外表現への参照(Phase 4三層モデル有効時のみ設定される)。
   * `createSpeechEvent`では設定されず、`applyPublicExpressionsToSpeech`(socialExpression.ts)が
   * 乖離調整の際に付与する。無効時(デフォルト)は常にundefined(従来のSpeechEventと完全互換)。
   */
  expression?: SpeechExpressionLink;
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
  /**
   * 発言時点の話者位置。省略時は(0, 0)にフォールバックする(座標を渡さない既存の呼び出し元
   * ―表示・テンプレート系のユニットテスト等―との後方互換のため)。`engine.ts`本体の生成経路
   * (`deriveSpeechEvents`および直接呼び出し)は必ず実座標を渡す。
   */
  originX?: number;
  originY?: number;
  /** 到達範囲(距離)。省略時はreasonごとの既定値(`resolveRange`参照)を使う */
  range?: number;
  /** 発言の強さ。省略時は`DEFAULT_SPEECH_STRENGTH`(1) */
  strength?: number;
};

/** 発言の既定到達距離。世界の一部を覆う程度(engine.tsのGROUP_GATHER_RADIUS=60より広め)に設定 */
export const DEFAULT_SPEECH_RANGE = 200;
/** 発言の既定の強さ。rangeにそのまま乗算されるため1が基準値 */
export const DEFAULT_SPEECH_STRENGTH = 1;
/**
 * `light-observer-invitation`専用の到達距離(Issue #94: 既存介入が意図したtargetへ確実に届くための
 * 明示的な設定値)。`selectInvitationAgent`(interventions.ts)は近傍(LIGHT_INVITATION_SEARCH_RADIUS=160)
 * に候補がいなければ、距離を問わず最寄りの非observerJoinerにフォールバックするため、話者から
 * observerJoinerまでの距離はワールド対角線近くまで離れうる。ワールド対角線(WORLD_WIDTH×WORLD_HEIGHT)
 * より確実に広く取ることで、この介入の声かけが常にobserverJoinerに届く(heard: true になる)ことを保証する。
 */
export const LIGHT_OBSERVER_INVITATION_RANGE = Math.ceil(Math.hypot(WORLD_WIDTH, WORLD_HEIGHT)) + 50;

/** reasonごとの既定range。表に無いreasonは`DEFAULT_SPEECH_RANGE`を使う */
const REASON_DEFAULT_RANGE: Partial<Record<SpeechReason, number>> = {
  lightObserverInvitation: LIGHT_OBSERVER_INVITATION_RANGE,
};

function resolveRange(reason: SpeechReason, override?: number): number {
  if (override !== undefined) return override;
  return REASON_DEFAULT_RANGE[reason] ?? DEFAULT_SPEECH_RANGE;
}

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
  const range = resolveRange(input.reason, input.range);
  const strength = input.strength ?? DEFAULT_SPEECH_STRENGTH;
  return {
    id: `speech-${input.tick}-${input.speakerId}-${input.reason}${disambiguator ? `-${disambiguator}` : ""}`,
    tick: input.tick,
    speakerId: input.speakerId,
    intent: input.intent,
    reason: input.reason,
    target: input.target,
    audience: input.audience,
    textKey: `speech.${input.reason}`,
    originX: input.originX ?? 0,
    originY: input.originY ?? 0,
    range,
    strength,
    audibility: range * strength,
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
  // 発言時点(nextState.tick)の話者位置スナップショットを取るため、話者候補(founder/welcomer)の
  // 実座標をnextState側から引く。
  const nextById = new Map(nextState.agents.map((a) => [a.id, a]));

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
      const founder = founderId ? nextById.get(founderId) : undefined;
      if (founder && founder.id !== agent.id) {
        events.push(
          createSpeechEvent({
            tick: nextState.tick,
            speakerId: founder.id,
            intent: "invite",
            reason: "formingGroupRecruitment",
            audience: "nearby",
            idSuffix: agent.id,
            originX: founder.x,
            originY: founder.y,
          }),
        );
      }
    }

    if (previousAgent.state === "undecided" && agent.state === "approaching") {
      const candidate = nextState.groupCandidates.find((c) => c.id === agent.joinedGroupId);
      const welcomerId = candidate?.memberIds[0];
      const welcomer = welcomerId ? nextById.get(welcomerId) : undefined;
      if (welcomer) {
        events.push(
          createSpeechEvent({
            tick: nextState.tick,
            speakerId: welcomer.id,
            intent: "welcome",
            reason: "approachWelcome",
            target: agent.id,
            originX: welcomer.x,
            originY: welcomer.y,
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
          originX: agent.x,
          originY: agent.y,
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
          originX: agent.x,
          originY: agent.y,
        }),
      );
    }
  }

  return events;
}
