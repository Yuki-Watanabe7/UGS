# Phase 3: 発言効果をstress・attractiveness・参加/離脱判断へ持続・減衰付きで適用する

Issue #96 の受入条件に対応する設計文書。`src/simulation/speechEffects.ts`の`SpeechEffectEvent`
(構造化された記録)を、実際に`engine.ts`の判断式へ持続・減衰付きで適用する`SpeechActiveEffect`と、
それを生成・参照・破棄する仕組みをまとめる。前段の3型(`SpeechReceptionEvent`/
`SpeechInterpretationEvent`/`SpeechEffectEvent`)の設計は`docs/speech-effects-phase3-boundary.md`、
解釈モデルの詳細は`docs/speech-interpretation-model.md`を参照。

## 1. `SpeechActiveEffect`とは何か

`SpeechEffectEvent`は「どの状態次元へ・どの強度/期間で作用しうるか」を保持するだけの構造化された
記録であり、それ単体ではAgentの判断に一切影響しない(`docs/speech-effects-phase3-boundary.md`が
定めた境界)。`SpeechActiveEffect`(`speechEffects.ts`)は、`SpeechEffectEvent`1件につき1件生成される、
**実際に`engine.ts`の計算式へ加算される持続効果**である。

```ts
type SpeechActiveEffect = {
  id: string;
  speechEffectEventId: string;      // 生成元のSpeechEffectEvent.id
  receiverId: string;
  dimension: SpeechEffectDimension; // "stress" | "attractiveness" | "approachProbability" | "leaveThreshold"
  targetGroupId?: string;           // dimension === "attractiveness" のときのみ設定
  startedAtTick: number;
  expiresAtTick: number;
  initialStrength: number;          // 符号付きの実際の適用値(0〜1に正規化された強度ではない)
  currentStrength: number;          // tick単位で線形減衰させた値。engine.tsが毎tick更新する
  decay: "linear";
};
```

`initialStrength`/`currentStrength`はdimensionごとに単位が異なる符号付きの実際の値であり
(例: `approachProbability`なら確率への加算量、`leaveThreshold`ならしきい値への加算量)、
「0〜1の強度」ではない。`willingness`/`conformity`/`influenceAvoidance`等の恒常的なpersonality値、
および`agent.leaveThreshold`本体は一切変更されない — 常に一時的な補正としてのみ計算式に加算される。

## 2. intentごとの作用対象・方向・基礎強度(固定表)

Issue #96の受入条件「invite/welcome/greet/declineごとに、作用対象・方向・基礎強度を明示する」に
対応し、intentごとに作用する次元を1つに固定する(`INTENT_DIMENSION`)。作用方向は既存の
`INTENT_BASE[intent].direction`(`valence`に反映済み)をそのまま使う。

| intent | 次元(dimension) | 作用対象 | 方向 | 基礎強度(intensity=1時) | 継続tick数 |
| --- | --- | --- | --- | --- | --- |
| invite | `approachProbability` | 発言を聞いた周囲のundecided全員 | 正: 接近確率を後押し | 0.25 | 5 |
| welcome | `attractiveness` | 受け手が今まさに近づいている輪(受け手の`joinedGroupId`スナップショット) | 正: その輪の魅力度を後押し | 0.35 | 8 |
| greet | `stress` | 発言を聞いた周囲のundecided全員 | 正の発言ほどstress蓄積率を緩和(符号反転) | 0.03 | 6 |
| decline | `leaveThreshold` | 発言を聞いた周囲のundecided全員 | 負: 実効leaveThresholdを引き下げ、離脱の伝染を後押し | 0.15 | 10 |

`stress`次元のみ符号を反転させる(`dimensionSignedValue`): positive valence(歓迎ムード)は
stress"蓄積率"を**下げる**方向(=負の補正)に効くため。他の3次元はvalenceの符号をそのまま使う。

`valence === "neutral"`(解釈強度が閾値未満まで弱まった場合)は`SpeechEffectEvent`/
`SpeechActiveEffect`のいずれも生成しない。

## 3. 減衰式(線形固定)

Issue #96の受入条件「初期実装の減衰式（線形または指数）を1種類に固定し、tick単位で決定的に計算する」
に対応し、全次元共通で線形減衰のみを採用する(`activeEffectStrengthAtTick`):

```
remaining(tick) = clamp(1 - (tick - startedAtTick) / (expiresAtTick - startedAtTick), 0, 1)
strength(tick)  = initialStrength * remaining(tick)
```

`tick >= expiresAtTick`では常に0。`tick`のみの純粋関数でrngは一切使わない(受入条件:
「効果ON/OFF時に同じ本体PRNG列を保ち、追加の乱数消費を発生させない」)。

## 4. engineのtick順序

Issue #96の受入条件が明文化を求める、1tickあたりの処理順序:

```
1. SpeechEvent生成       (step 1/1bで直接生成 + tick末尾のderiveSpeechEventsで導出)
2. 認知                  (deriveSpeechReceptions)
3. 解釈                  (deriveSpeechInterpretations)
4. 効果登録/更新          (deriveSpeechEffects -> deriveSpeechActiveEffects、nextState.activeSpeechEffectsへ登録)
5. 状態・行動判断への参照  (※次tick以降。advanceActiveSpeechEffectsで減衰させた値をstep 2/7が読む)
6. 期限切れ効果の破棄     (advanceActiveSpeechEffects、tick >= expiresAtTickのものを除去)
```

重要な設計判断: **あるtickに生成された発言の効果は、そのtick自身の意思決定には使われず、
次tick以降で初めて参照される。** `deriveSpeechEvents`が状態遷移の前後比較でのみ発言主体を
復元できる設計(`speech.ts`参照)であることに加え、"in-tick"適用(発言と同一tick内で効果を
参照する)を避けることで、tick内の処理順序に依存しない単純で決定的なモデルに保っている。

具体的には`stepSimulation`の冒頭で:

```ts
const activeEffects = speechEffectsConfig.enabled
  ? advanceActiveSpeechEffects(state.activeSpeechEffects ?? [], tick)
  : [];
```

を計算し(前tickまでの登録分を今回のtickの強度へ減衰・期限切れ破棄)、step 2(接近)・
step 7(ストレス蓄積とleave判定)・`attractiveness()`がこの`activeEffects`を参照する。
tick末尾で今回生成された`SpeechEffectEvent`から`deriveSpeechActiveEffects`により新規の
`SpeechActiveEffect`を作り、`nextState.activeSpeechEffects = [...activeEffects, ...tickActiveEffects]`
として次tickに引き継ぐ。

## 5. 各次元の適用先(`engine.ts`)

- **`approachProbability`**: step 2(接近)で`score * 0.35 * ...`により算出した確率に、
  `sumActiveEffectValue(activeEffects, agent.id, "approachProbability", tick)`を加算してから
  `clamp(..., 0, 0.9)`する。
- **`attractiveness`**: `attractiveness()`関数が新しい`activeEffects`引数(既定値`[]`、後方互換)を
  受け取り、`sumActiveEffectValue(activeEffects, agent.id, "attractiveness", tick, candidate.id)`を
  スコアへ加算する。`targetGroupId`が一致するcandidateにのみ効く。
- **`stress`**: step 7のstress増分(`increment`)へ`sumActiveEffectValue(..., "stress", tick)`を
  加算する(負の値になり、増分を打ち消す方向)。既存の不変条件「stressはundecided中のみ蓄積する」
  はループの対象がundecidedのみである点でそのまま維持される。
- **`leaveThreshold`**: step 7のleave判定を`agent.stress > agent.leaveThreshold`から
  `agent.stress > agent.leaveThreshold + sumActiveEffectValue(..., "leaveThreshold", tick)`に変更する。
  `agent.leaveThreshold`本体(personality値)は変更しない。

いずれも`sumActiveEffectValue`は該当する`activeEffects`を単純に合計するだけで、
複数発言由来の効果が重なった場合の優先順位づけ・競合解決は行わない(対応しない範囲、下記5節)。

## 6. 対応した範囲・対応しなかった範囲

対応した範囲(このissueのスコープ):

- 1件の解釈結果から`SpeechEffectEvent`と`SpeechActiveEffect`を生成する(`deriveSpeechEffects`→`deriveSpeechActiveEffects`)
- stress蓄積率・attractiveness・接近確率・leave判定という4次元への適用先の固定
- intentごとの作用対象・方向・基礎強度の明示(`INTENT_DIMENSION`/`DIMENSION_UNIT`)
- `startedAtTick`/`expiresAtTick`/`initialStrength`/`currentStrength`/`decay`の保持
- 線形減衰の1種類固定、tick単位の決定的計算(rng不使用)
- engineのtick順序の明文化(本文書4節)
- 効果ON/OFF時に追加のrng消費が発生しないこと(`sumActiveEffectValue`/`activeEffectStrengthAtTick`/
  `deriveSpeechActiveEffects`はいずれも`rng`を受け取らない)
- 発言なしtick・効果OFF時に従来の計算式と結果を維持すること
  (`speechEffectsWiring.test.ts`で検証。`activeSpeechEffects`が常に空配列になるため、
  `sumActiveEffectValue`は常に0を返し、既存の計算式にフォールバックする)
- 単一発言・単一受け手の統合テスト(`speechEffects.test.ts`の
  "Issue #96 integration: single speech, single receiver...")

対応しなかった範囲(意図的に対応しない、issue記載の対応しない範囲そのまま):

- 複数発言の競合・累積規則(同一受け手・同一次元への複数の`SpeechActiveEffect`は単純加算のみ)
- 永続的な性格・信頼・関係性更新(`willingness`/`conformity`/`influenceAvoidance`等、および
  `agent.leaveThreshold`本体は不変のまま)
- 新しい発言intent
- UI可視化、Monte Carlo比較(`monteCarlo.ts`は引き続き`speechEffects`引数を渡さず、常に無効)
- Phase 4の本心/建前モデル

## 7. 参照

- Issue #96(本文書が対応するissue)、親ロードマップ #61、Depends on: #93, #94, #95
- `docs/speech-effects-phase3-boundary.md`(Issue #93、3段階のイベントモデルの責務境界)
- `docs/speech-interpretation-model.md`(Issue #95、解釈モデルの詳細)
- `src/simulation/speechEffects.ts`, `src/simulation/engine.ts`, `src/simulation/types.ts`,
  `src/simulation/inspection.ts`
- `src/simulation/speechEffects.test.ts`, `src/simulation/speechEffectsWiring.test.ts`
