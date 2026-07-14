import type { Agent } from "./types";
import type { SpeechExpressionLink, SpeechIntent } from "./speech";
import type { DivergenceFactor, DivergenceScene } from "./socialExpression";
import { classifyDivergenceScene, DIVERGENCE_SCENE_FACTOR } from "./socialExpression";

/**
 * Issue #118: 乖離場面(本心と対外表現がずれた発言)用の、本心(thought)と建前(speech)を
 * 対比させた文言テンプレート集と、その決定的な選択ロジック。
 *
 * 責務と境界(重要):
 * - これは**表示専用**のテンプレート層である。`SimulationState`・`Agent`・rngのいずれも変更せず、
 *   本体の`SeededRandom`列を一切消費しない(バリエーション選択は`seed`/`tick`/`agentId`/場面/
 *   アーキタイプ/プリセットから決定的に導くハッシュのみ。Phase 1の表現専用rngパターンを踏襲)。
 * - 文言の追加・変更はシミュレーション結果(状態系列・最終結果・PRNG消費)に一切影響しない
 *   (この関数群はengine/stepSimulationのどこからも呼ばれず、UI等の表示側からのみ参照される)。
 * - 乖離判定ロジック自体は変更しない(`classifyDivergenceScene`が#114/#115の乖離結果を読むだけ)。
 *
 * 1件の乖離場面に対して、本心と建前が**同一の選択インデックス**で対になった`DivergencePair`を返す
 * ことで、「同一tick・同一エージェントの thought と speech の文言差から乖離要因が読み取れる」ことを
 * 保証する。プリセット(5シナリオ)・性格アーキタイプ(designated leader / observerJoiner /
 * cliqueメンバー / 一般)ごとの文言バリエーションを持つ。
 *
 * 対応しない範囲(#118): 乖離判定ロジックの変更、UI(吹き出しレイアウト、#119)、新intent。
 * 詳細は`docs/divergence-templates-model.md`参照。
 */

/** 性格アーキタイプ。テンプレートの語調・内容を変える単位(`Agent`から決定的に分類する) */
export type TemplateArchetype = "designatedLeader" | "observerJoiner" | "cliqueMember" | "general";

/**
 * `Agent`から表示テンプレート用のアーキタイプを決定的に分類する。
 * designated leaderは生成時に`initiative`が0.7〜0.95(model.ts)で、一般エージェント(0.1〜0.45)と
 * 常に区別できるため`initiative >= 0.5`で判定する(専用フラグは持たないため)。
 * `cliqueId`を持つ非リーダーはcliqueメンバー、それ以外は一般。
 */
export function classifyTemplateArchetype(agent: Agent): TemplateArchetype {
  if (agent.isObserverJoiner) return "observerJoiner";
  if (agent.initiative >= 0.5) return "designatedLeader";
  if (agent.cliqueId !== undefined) return "cliqueMember";
  return "general";
}

/** 本心(thought)と建前(speech)を対にした1バリエーション。両者の文言差で乖離要因が読み取れる */
export type DivergencePair = {
  /** 本心(観察者だけに見える「心の声」相当)。乖離場面での真意 */
  thought: string;
  /** 建前(実際に発せられる発言)。対外表現側の文言 */
  speech: string;
};

type ArchetypePairs = {
  general: readonly DivergencePair[];
  designatedLeader?: readonly DivergencePair[];
  observerJoiner?: readonly DivergencePair[];
  cliqueMember?: readonly DivergencePair[];
};

type SceneTemplate = {
  byArchetype: ArchetypePairs;
  /** プリセット(シナリオ)固有の文言バリエーション。該当プリセットではアーキタイプ別候補に追加される */
  byPreset?: Partial<Record<string, readonly DivergencePair[]>>;
};

/**
 * 乖離場面ごとの本心/建前テンプレート。`byArchetype.general`は必ず1件以上持つ(フォールバック元)。
 * アーキタイプ上書きは語調が変わる場面にのみ設ける。`byPreset`は場面がシナリオで色付くものに設ける。
 */
const DIVERGENCE_TEMPLATES: Record<DivergenceScene, SceneTemplate> = {
  // 遠慮: 誘いたい本心を、押しつけを避けて控えめな声がけへ軟化させた(invite -> greet)
  reservedSoftening: {
    byArchetype: {
      general: [
        { thought: "本当はぜひ来てほしいんだけど…", speech: "もしよかったら、くらいで大丈夫" },
        { thought: "誘いたい。でも押しつけたくないな", speech: "無理にとは言わないけど、どう?" },
      ],
      designatedLeader: [
        { thought: "皆を誘いたいが、仕切りすぎたくない", speech: "行ける人だけで、ゆるくどう?" },
      ],
      observerJoiner: [
        { thought: "誘いたいけど、自分が場を動かすのは気が引ける", speech: "もし気が向いたら、くらいで…" },
      ],
      cliqueMember: [
        { thought: "いつもの皆で行きたいんだけどな", speech: "よかったら一緒にどう、くらいの感じで" },
      ],
    },
    byPreset: {
      "strong-leader": [
        { thought: "リーダーがいるし、自分から強くは誘えない", speech: "行けたら行こう、くらいの温度感で" },
      ],
      "ambiguous-dissolve": [
        { thought: "このままだと流れそう…本当は誘いたいのに", speech: "まだ行けるなら、ゆるく行かない?" },
      ],
    },
  },
  // 同調(建前の歓迎): 本心は乗り気でないまま、周囲に合わせて歓迎を述べる
  obligatoryWelcome: {
    byArchetype: {
      general: [
        { thought: "正直そんなに乗り気じゃないけど…", speech: "どうぞどうぞ、歓迎するよ!" },
        { thought: "内心は微妙だけど、断りにくいな", speech: "もちろん、こっちおいでよ" },
      ],
      designatedLeader: [
        { thought: "本音は人数を絞りたいが、場の手前…", speech: "歓迎するよ、どんどん来て!" },
      ],
      observerJoiner: [
        { thought: "気は進まないけど、雰囲気的に頷いておくか", speech: "あ、うん、こっちどうぞ" },
      ],
      cliqueMember: [
        { thought: "内輪でいたい気もするけど…", speech: "いいよいいよ、一緒にどうぞ" },
      ],
    },
    byPreset: {
      "strong-leader": [
        { thought: "リーダーの手前、歓迎しておくか…", speech: "もちろん歓迎、こっちこっち" },
      ],
      "leftover-free-grouping": [
        { thought: "誰でも大歓迎ってわけじゃないけど…", speech: "空いてるよ、どうぞ入って" },
      ],
    },
  },
  // 社交辞令の辞退: 本心は参加希望のまま、辞退を告げる(observerJoinerの典型)
  politeDecline: {
    byArchetype: {
      general: [
        { thought: "本当はまだ行きたいんだけどな…", speech: "今日はここで帰るね、また今度!" },
        { thought: "行きたい気持ちはあるのに…", speech: "そろそろ失礼するよ、楽しんで!" },
      ],
      designatedLeader: [
        { thought: "まだ場を締めたくはないが…", speech: "自分はここで失礼するよ、あとは頼んだ" },
      ],
      observerJoiner: [
        { thought: "本当は行きたかったのに、言い出せなかった…", speech: "今日はこの辺で。また誘ってね" },
      ],
      cliqueMember: [
        { thought: "みんなともう少しいたいけど…", speech: "うちらはここで抜けるね、また今度!" },
      ],
    },
    byPreset: {
      "ambiguous-dissolve": [
        { thought: "決まらないまま…本当は行きたいのに", speech: "うーん、今日はもう解散かな。おつかれさま" },
      ],
      "late-join-culture": [
        { thought: "後から行けるとはいえ、今は言い出しにくい…", speech: "いったん抜けるね、追いつけたら合流するかも" },
      ],
    },
  },
};

/**
 * 文字列から決定的な非負ハッシュ値を作る表示専用の純粋関数(`expression.ts`の同名関数と同一アルゴリズム。
 * テンプレート層をexpression.tsから独立させるため複製している)。本体PRNGを一切消費しない。
 */
function hashString(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** 乖離場面のテンプレート解決に必要な入力。すべて読み取り専用で、いずれも変更しない */
export type DivergenceTemplateContext = {
  /** 発話時点の乖離スナップショット(`SpeechEvent.expression`) */
  link: SpeechExpressionLink;
  /** 実際に発せられたintent(`SpeechEvent.intent`) */
  intent: SpeechIntent;
  /** 話者。アーキタイプ分類に使う(変更しない) */
  agent: Agent;
  /** シナリオ別バリエーション選択に使うプリセットID */
  presetId: string;
  /** 決定的バリエーション選択の種(本体`SeededRandom`とは独立) */
  seed: number;
  /** 発話tick */
  tick: number;
};

/** 乖離場面の本心/建前ペア解決結果。`variantIndex`で本心と建前が同一の選択に紐づくことを示す */
export type DivergentExpressionResolution = {
  scene: DivergenceScene;
  factor: DivergenceFactor;
  archetype: TemplateArchetype;
  /** 選択されたバリエーションのインデックス(thought/speechで共通=対の整合性の担保) */
  variantIndex: number;
  /** 本心(心の声)側の文言 */
  thought: string;
  /** 建前(発言)側の文言 */
  speech: string;
};

/**
 * 乖離場面の本心/建前ペアを決定的に解決する純関数。
 * `classifyDivergenceScene`が乖離場面を返さない(非乖離、または3場面に該当しない)場合はundefinedを返し、
 * 呼び出し側は従来の非乖離テンプレートへフォールバックする。
 *
 * バリエーション候補は「アーキタイプ別の文言 + そのプリセット固有の文言」を連結した集合で、
 * `seed:tick:agentId:scene:archetype:presetId`のハッシュでインデックスを選ぶ。これにより:
 * - 同一seed・同一設定なら常に同じ文言が選ばれる(再現性)。
 * - プリセット/アーキタイプが変われば選択(集合・インデックスの双方)が変わりうる(場面・性格別の変化)。
 * - 本心(thought)と建前(speech)は同一の`variantIndex`から取り出すため、必ず対応する対になる。
 */
export function resolveDivergentExpression(ctx: DivergenceTemplateContext): DivergentExpressionResolution | undefined {
  const scene = classifyDivergenceScene(ctx.link, ctx.intent);
  if (!scene) return undefined;

  const archetype = classifyTemplateArchetype(ctx.agent);
  const template = DIVERGENCE_TEMPLATES[scene];
  const archetypePairs = template.byArchetype[archetype] ?? template.byArchetype.general;
  const presetPairs = template.byPreset?.[ctx.presetId] ?? [];
  const pool = [...archetypePairs, ...presetPairs];

  const key = `${ctx.seed}:${ctx.tick}:${ctx.agent.id}:${scene}:${archetype}:${ctx.presetId}`;
  const variantIndex = hashString(key) % pool.length;
  const pair = pool[variantIndex];

  return {
    scene,
    factor: DIVERGENCE_SCENE_FACTOR[scene],
    archetype,
    variantIndex,
    thought: pair.thought,
    speech: pair.speech,
  };
}
