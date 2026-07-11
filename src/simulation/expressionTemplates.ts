import type { ExpressionReason } from "./expression";

/**
 * `ExpressionReason`ごとの心の声テンプレート集。文言そのものはこのモジュールでのみ保持し、
 * `expression.ts`はここから取得した`variantCount`をもとに決定的にインデックスを選ぶだけで、
 * 文言の中身には関与しない(UI側も同様、テキストの再解釈はしない)。
 *
 * `observerJoiner`はobserverJoiner専用の言い回しがある場合のみ上書きに使う。
 * 未指定ならgeneralを共有する(一般エージェントとの言い回しの区別は、必要な局面にだけ設ける)。
 *
 * 文言は状態と矛盾しないこと、断定的な性格診断に見えないことを優先し、
 * 吹き出し内で読み切れる短さに留めている。
 */
type TemplateVariants = {
  general: readonly string[];
  observerJoiner?: readonly string[];
};

const TEMPLATES: Record<ExpressionReason, TemplateVariants> = {
  initiativeFormedCore: {
    general: ["よし、声をかけてみよう", "もう一軒、誘ってみるか"],
  },
  cliqueFormedCore: {
    general: ["いつものメンバーで集まろうか", "この面子ならもう一軒行けそうだ"],
  },
  approachedFormingGroup: {
    general: ["輪が見えてきた。近づいてみようかな", "あそこの輪、行ってみよう"],
  },
  approachedConfirmedGroup: {
    general: ["もう決まってるグループに合流しよう", "あそこなら入れそうだ"],
  },
  arrivedAtFormingGroup: {
    general: ["よし、輪に加われた", "無事に合流できた"],
    observerJoiner: ["よかった、自然に入れた", "思ったより自然に加われた"],
  },
  arrivedAtConfirmedGroup: {
    general: ["グループに参加できた", "間に合ってよかった"],
    observerJoiner: ["よかった、自然に入れた", "後からでも入れてよかった"],
  },
  ambiguityStressExceeded: {
    general: ["今日はもう帰ろう", "これ以上待つのはやめておこう"],
    observerJoiner: ["今日はもう帰ろう", "やっぱり今日はやめておこう"],
  },
  reachedScreenEdge: {
    general: ["帰り道につく", "そのまま会場を後にした"],
  },
  receivedLightInvitation: {
    general: ["声をかけてもらえた", "誘ってもらえて少しほっとした"],
    observerJoiner: ["声をかけてもらえた", "誘ってもらえて少し気が楽になった"],
  },
  stressCrossedRisingThreshold: {
    general: ["まだ決まらないのか…少し疲れてきた", "そろそろ長いな、と感じ始めた"],
    observerJoiner: ["まだ決まらないのか…少し疲れてきた", "この空気、少し疲れるな"],
  },
  stressNearLeaveThreshold: {
    general: ["そろそろ帰った方がよさそうだ", "潮時かもしれない"],
    observerJoiner: ["そろそろ帰った方がよさそうだ", "そろそろ潮時かもしれない"],
  },
  nearbyGroupUnapproached: {
    general: ["行きたいけど、今入るのは少し気まずいな…", "声をかけるタイミングが難しい"],
    observerJoiner: ["行きたいけど、今入るのは少し気まずいな…", "輪はあるけど、自分から入るのは気が引ける"],
  },
  noJoinableGroupNearby: {
    general: ["近くに輪が見当たらないな", "もう少し様子を見てみよう"],
    observerJoiner: ["近くに輪が見当たらないな", "行けそうな輪がまだないから、様子を見よう"],
  },
};

/** `reason`に対応するテンプレート配列を返す。observerJoiner専用の言い回しがなければgeneralを返す */
export function resolveExpressionVariants(reason: ExpressionReason, isObserverJoiner: boolean): readonly string[] {
  const entry = TEMPLATES[reason];
  return isObserverJoiner && entry.observerJoiner ? entry.observerJoiner : entry.general;
}

/** `pickTextVariant`が決定的にインデックスを選ぶための、実際に存在するバリエーション数 */
export function getExpressionVariantCount(reason: ExpressionReason, isObserverJoiner: boolean): number {
  return resolveExpressionVariants(reason, isObserverJoiner).length;
}

/** `reason`+`variantIndex`から実際の表示文言を解決する。`ExpressionEvent.textKey`の解決に使う想定 */
export function resolveExpressionText(reason: ExpressionReason, isObserverJoiner: boolean, variantIndex: number): string {
  const variants = resolveExpressionVariants(reason, isObserverJoiner);
  return variants[variantIndex % variants.length];
}
