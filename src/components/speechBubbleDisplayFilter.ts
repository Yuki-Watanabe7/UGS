/**
 * 発言吹き出しの表示設定。心の声側(`expressionDisplayFilter.ts`)とは独立した状態として持つ
 * (Issue #82の受け入れ条件「心の声だけ表示/発言だけ表示/両方表示/両方非表示」の4通りは、
 * 2つの独立したON/OFFの組み合わせとして自然に表現できるため、両者を1つの設定にまとめない)。
 * 表示対象・密度の絞り込みは現時点では要求されておらず、ON/OFFのみを持つ最小限の設定とする。
 */
export type SpeechBubbleDisplaySettingsState = {
  enabled: boolean;
};

export const DEFAULT_SPEECH_BUBBLE_DISPLAY_SETTINGS: SpeechBubbleDisplaySettingsState = {
  enabled: true,
};
