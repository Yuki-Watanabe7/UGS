# Phase 3: 性格・関係性・現在状態に基づく受け手別の発言解釈モデル

Issue #95 の受入条件に対応する設計文書。`src/simulation/speechEffects.ts`の
`deriveSpeechInterpretations`が`SpeechReceptionEvent`(`heard: true`のみ)から
`SpeechInterpretationEvent`を導出する際の、決定的な数値モデルの設計意図をまとめる。

## 1. 重要な前提

**これは実在の人間の受け止め方を断定的に分類・予測するモデルではない。** 性格パラメータ
(`conformity`/`influenceAvoidance`)・関係性(`existingTieStrength`・同一clique)・現在の
`stress`/`state`から決定的に導かれる、シミュレーション内の数値ルールに過ぎない。可変の
「信頼学習」(発言を重ねるほど信頼が変化する等)・本心と建前の不一致・発言の真実性判定・
LLMによる文章解釈は対応しない範囲(現在の関係性から一意に導出する固定値のみを使う)。

## 2. intentごとの基礎的な意味と作用方向(`INTENT_BASE`)

| intent | 方向 | 基礎magnitude | 意味 |
| --- | --- | --- | --- |
| invite | 正 | 0.6 | 接近可能性・安心感を上げる方向 |
| welcome | 正 | 0.6 | 同上 |
| greet | 正 | 0.35 | 周囲の社会的手がかりを補強する方向(invite/welcomeより控えめ) |
| decline | 負 | 0.5 | 対象の輪の魅力度を下げ、曖昧さ/stressを上げうる方向 |

`magnitude`は他要因による減衰前の上限値。実際の`intensity`はここから各係数(0〜1程度、
一部は1を超えうる)を乗算して決まり、最終的に`[0, 1]`へclampする。

## 3. 解釈係数(乗算的モデル)

`intensity = clamp(magnitude * conformity係数 * influenceAvoidance係数 * relationshipTrust * stress係数 * state関連度 * relation係数 * strength係数, 0, 1)`

| 要因 | 入力 | 効果 |
| --- | --- | --- |
| `conformity` | 受け手の`conformity`(0〜1) | 高いほど場の方向性を強く受け止める(`0.5 + 0.5 * conformity`) |
| `influenceAvoidance` | 受け手の`influenceAvoidance`(0〜1)、`relation` | 高いほど弱く受け止める。名指し(`target`)されるほど減衰が大きい(重み0.6 vs nearby 0.25) |
| `relationshipTrust`(話者への基礎信頼) | 同一cliqueか否か、`existingTieStrength` | 同一cliqueなら既存関係性が強いほど信頼が上がり(`0.5 + 0.5 * tie`)、そうでなければ既存関係性が強い場ほど部外者への基礎信頼が下がる(`0.5 - 0.4 * tie`)。`engine.ts`の`attractiveness()`が使うoutsiderPenaltyと同じ非対称性 |
| `stress`係数 | 受け手の現在`stress`(0〜1) | 正方向の発言は素直に受け止めにくくなり(`1 - stress * 0.4`)、負方向の発言はより強く受け止めてしまう(`1 + stress * 0.5`) |
| `state`関連度 | 受け手の現在`state` | 既に決着へ進んでいるほど関連度が下がる(`undecided: 1` 〜 `left: 0`) |
| `relation`係数 | `target` / `audience`(nearby) | 名指しされた発言は周囲向けより強く受け止められる(`target: 1`, `audience: 0.7`) |
| `strength`係数 | `SpeechEvent.strength` | そのまま倍率として使う。`[0, 2]`へclamp(NaN/Infinityは1にフォールバック) |

`intensity`が`NEUTRAL_INTENSITY_THRESHOLD`(0.05)未満まで弱まった場合は、基礎方向によらず
`valence: "neutral"`として扱う(「ほぼ何も感じなかった」を方向なしに丸める)。

## 4. factor breakdown

`SpeechInterpretationEvent.factors`は上記8要因(`intentBase`を含む)それぞれについて、
`rawValue`(正規化前の生値)・`normalizedValue`(0〜1へ丸めた値)・`contribution`(実際に
乗算された係数)を固定順で保持する。これにより「なぜその強度になったか」をどのイベントからでも
遡って説明できる。

## 5. 決定性・有限範囲・非介入性

- `deriveSpeechInterpretations`は`SimulationState`・`Agent`・rngのいずれも参照/変更しない純粋関数。
  受け取るのは前段の`SpeechReceptionEvent[]`・元の`SpeechEvent[]`・受け手/話者の最小限の情報
  (`SpeechInterpreterCandidate[]`)・`existingTieStrength`のみ。
- すべての中間値・最終値は`clamp`により有限範囲に収める。`strengthFactor`はNaN/Infinityを
  検出した場合1にフォールバックする。同一入力からは常に同一の出力(順序依存なし)。
- 生成した`SpeechInterpretationEvent`をAgent.stress等の状態変数へ実際に適用する処理・
  複数発言の集約・UI表示はこのissueの対応しない範囲(`deriveSpeechEffects`は引き続き
  構造化された記録を生成するだけで、実適用はPhase 4以降)。

## 6. 参照

- Issue #95(本文書が対応するissue)、親ロードマップ #61。Depends on #93, #94
- `docs/speech-effects-phase3-boundary.md`(Issue #93、3段パイプラインの全体設計)
- `docs/speech-reception-distance-model.md`(Issue #94、`deriveSpeechReceptions`の距離モデル)
- `src/simulation/speechEffects.ts`, `src/simulation/speechEffects.test.ts`
