# Phase 3.1: 発言時点の位置・対象・可聴範囲から受け手の認知を決定的に判定する

Issue #94 の受入条件に対応する設計文書。Issue #93 で導入した`SpeechReceptionEvent`
(`src/simulation/speechEffects.ts`)は`target`/`audience: "nearby"`という二値モデルのまま
「聞いた」を判定していた(`heard`は常に`true`)。本issueでは、発言時点の話者位置・到達範囲から
受け手ごとの距離を計算し、決定的に`heard`を判定するモデルへ置き換える。

## 1. `SpeechEvent`への追加フィールド

`src/simulation/speech.ts`の`SpeechEvent`に以下を追加した(後方互換: `CreateSpeechEventInput`側は
いずれも任意項目で、省略時は既定値にフォールバックする):

| フィールド | 内容 | 省略時の既定値 |
| --- | --- | --- |
| `originX`/`originY` | 発言時点の話者位置のimmutableなスナップショット | `(0, 0)` |
| `range` | 発言の基礎到達距離 | `DEFAULT_SPEECH_RANGE`(200)。ただし`reason === "lightObserverInvitation"`は`LIGHT_OBSERVER_INVITATION_RANGE`(ワールド対角線+50、約1004) |
| `strength` | 発言の強さ(`range`への倍率) | `DEFAULT_SPEECH_STRENGTH`(1) |
| `audibility` | 認知判定の実際の閾値(= `range * strength`)。生成時に一度だけ計算され、以後固定 | - |

`range`/`strength`を分けて持たせているのは、将来「叫ぶ/ささやく」のような強弱表現を`strength`側の
上書きだけで表現できる余地を残すため(本issueでは`strength`の意味的な使い分けは導入しない)。

### `light-observer-invitation`が確実に届く理由

`selectInvitationAgent`(`interventions.ts`)は近傍(`LIGHT_INVITATION_SEARCH_RADIUS`=160)に候補が
いなければ、距離を問わず最寄りの非observerJoinerにフォールバックするため、話者からobserverJoiner
までの距離はワールド対角線(`Math.hypot(WORLD_WIDTH, WORLD_HEIGHT)`、約954)近くまで離れうる。
`LIGHT_OBSERVER_INVITATION_RANGE`をこの対角線より明示的に広く取ることで、この既存介入の声かけが
常にobserverJoinerに届く(`heard: true`になる)ことを保証している。

## 2. 受け手候補の決定規則

`deriveSpeechReceptions`(`speechEffects.ts`)の入力を`receiverIds: string[]`から
`SpeechReceiverCandidate[]`(`id`/`x`/`y`/`state`を持つ、`Agent`の部分型)に変更した。

候補は以下の順で絞り込まれる:

1. **話者自身を除外**、**`state === "left"`のagentを除外**(除外された候補は`SpeechReceptionEvent`
   自体が生成されない。「話しかけようがない相手」として扱う)。
2. `target`が設定されている場合: 除外後の候補に`target`が含まれていなければ(自己宛て/left/
   存在しない)`SpeechReceptionEvent`を一切生成しない。含まれていれば、`target`は「候補を特定する
   情報」に過ぎず、実際に聞こえたか(`heard`)は3節の距離判定で別途決まる(targetだからといって
   常に`heard: true`にはならない)。
3. `audience === "nearby"`の場合: 除外後の候補全員について`SpeechReceptionEvent`を生成する。
   圏外の候補も`heard: false`として記録されるため、`speechReceptionLog`から「誰が・なぜ聞こえ
   なかったか」を遡って追跡できる。

## 3. 距離としきい値による`heard`判定

```
distance = Math.hypot(speech.originX - receiver.x, speech.originY - receiver.y)
heard    = distance <= speech.audibility   // 閾値ちょうどは「聞こえた」側(inclusive)
reason   = heard ? "withinRange" : "outOfRange"
```

`SpeechReceptionEvent`は`distance`/`threshold`(= `speech.audibility`の複製)/`heard`/`reason`を
保持する。`threshold`を複製して持たせているのは、`speechLog`側を遡らなくても
`speechReceptionLog`単体で「なぜその判定になったか」を読めるようにするため。

## 4. 決定性・非再計算性の保証

- `deriveSpeechReceptions`は`SpeechEvent[]`と`SpeechReceiverCandidate[]`のみを入力とする純粋関数
  であり、`SimulationState`全体やrngを参照しない。同一入力に対して常に同一順序・同一内容を返す。
- `engine.ts`の`stepSimulation`は、そのtickで生成された`SpeechEvent`に対して一度だけこの関数を呼び、
  結果を`state.speechReceptionLog`に追記する。一度書き込まれたレコードは以後再計算されない。
- 発言後にagentが移動しても結果が変わらないのは、(a)`speech.originX`/`originY`が発言生成時点で
  固定されたスナップショットであり、(b)受け手側の位置も`deriveSpeechReceptions`が呼ばれた時点
  (=そのtickの処理内)の値を一度だけ評価し、結果を`speechReceptionLog`に永続化するためである。
  Pause/Replay/表示ON・OFFはこの評価済みログを読むだけで、いずれも再評価をトリガーしない。

## 5. `deriveSpeechInterpretations`との整合性

`heard`が`false`になり得るようになったことに伴い、`deriveSpeechInterpretations`は
`reception.heard === false`のレコードを解釈対象から除外するよう変更した(聞いていない発言を
解釈することはできないため)。解釈の対応表(`INTENT_VALENCE`)自体や`deriveSpeechEffects`の
対応表(`VALENCE_STRESS_EFFECT`)は変更していない(意味解釈そのものはこのissueの対応しない範囲)。

## 6. 対応しない範囲(このissueで意図的に対応しない)

- 聞いた後の意味解釈そのもの(`heard`によるフィルタリングのみ追加。解釈式は変更しない)
- 遮蔽物・方向・騒音場の物理モデル(距離としきい値の比較のみ)
- 確率的な聞き漏らし(`heard`は距離から一意に決まる決定的な判定であり、rngは使わない)
- 心理状態や行動選択への効果(Agent.stress等への適用はPhase 4以降のスコープのまま)
- UI表示: `ObserverJoinerInspection.speechHistory`(`inspection.ts`)は引き続き`SpeechEvent`の
  `target`/`audience`ベースの簡略化(`audience: "nearby"`は全員が対象)を使う。Inspector表示を
  `speechReceptionLog`ベースに切り替える対応はこのissueのスコープ外。

## 7. 参照

- Issue #94(本文書が対応するissue)、親ロードマップ #61、依存元 #93
- `docs/speech-effects-phase3-boundary.md`(Issue #93。3節「対応しなかった範囲」で本issueへの
  拡張点として距離判定を挙げていた)
- `src/simulation/speech.ts`, `src/simulation/speechEffects.ts`, `src/simulation/engine.ts`
- `src/simulation/speech.test.ts`, `src/simulation/speechEffects.test.ts`
