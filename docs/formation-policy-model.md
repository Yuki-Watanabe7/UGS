# FormationPolicy: グループ形成・終了ルールの拡張点

この文書は、[`formationPolicy.ts`](../src/simulation/formationPolicy.ts)が定義する`FormationPolicy`
インターフェースの責務と、`afterParty`(二次会)・`classroomPair`(教室ペア形成)がそれぞれをどう
実装しているかを一覧化し、将来の新シナリオ(たとえば3〜4人班分け)を追加する際にどこを実装すれば
よいかをまとめる。個々のシナリオの挙動そのものの説明は
[UGSコアモデル 6.3節](core-agent-dynamics.md#63-学校のペア形成ポリシー)および
[README「教室ペア形成プリセット」](../README.md#教室ペア形成プリセットclassroom-pair)を参照し、
ここでは**拡張のための設計面**に焦点を当てる。

## なぜこの境界が存在するか (Issue #130)

`engine.ts`の1 tickループ(核形成→接近→合流→stress→候補ライフサイクル→終了判定)自体は
シナリオを問わず共通だが、「誰が核を作れるか」「いつ成立するか」「退出できるか」「いつ終わるか」
といった個々の判定式・しきい値はシナリオごとに大きく異なる。これを`engine.ts`内の
`scenarioId === "classroomPair"`のような条件分岐で表現すると、シナリオが増えるたびに
`engine.ts`全体に分岐が散らばり、既存シナリオの可読性・テスト容易性が損なわれる。

`FormationPolicy`はこの分岐点を1つのインターフェースへ集約する。`engine.ts`は
`resolveFormationPolicy`で解決した`FormationPolicy`オブジェクトのメソッド・プロパティを呼ぶだけで、
個々の確率式・しきい値を一切知らない。新しいシナリオを追加するときは、原則として
**新しい`FormationPolicy`実装を1つ追加するだけで済み、`engine.ts`本体を変更する必要はない。**

介入シナリオ(`interventions.ts`の`InterventionScenarioId`)はこれとは独立した軸であり、
`FormationPolicy`側は一切参照しない。介入による確率・しきい値の補正は、`FormationPolicy`が
返した基礎値に対して、従来どおり`engine.ts`側で適用する。

## 8つの責務

`FormationPolicy`インターフェース(`formationPolicy.ts`)は次の8つの責務を持つ。表の「afterParty」
「classroomPair」列は、既存2実装がそれぞれどう応えているかの要約。

| # | 責務 | メソッド/プロパティ | afterParty | classroomPair |
| --- | --- | --- | --- | --- |
| 1 | 新しい候補(核)を作れるか・その基礎確率 | `evaluateCandidateInitiation` | `initiative >= 0.5`の人、またはclique近接者のみ | 全員が対象(先生の指示のため主導性で絞らない)。observerJoinerのみ除外 |
| 2 | 候補への接近確率の基礎倍率 | `approachRateMultiplier` | `0.35` | `0.5`(教室活動のため成立を急がせる) |
| 3a | 候補が成立する条件 | `shouldConfirmCandidate` | `nearbyCount >= groupConfirmSize`(可変) | `nearbyCount >= 2`(固定、`groupConfirmSize`は参照しない) |
| 3b | 未成立候補の解散/期限切れ条件 | `evaluateUnconfirmedCandidateLifecycle` + `defaultWeakResponseAge`/`defaultMaxAge` | weak=15 / max=40 | weak=10 / max=25(締切内に何度か探し直せるよう短め) |
| 4a | 退出可否 | `canLeave` | `stress > effectiveLeaveThreshold` | 常に`false`(退出という概念自体がない) |
| 4b | 未定状態のstress蓄積式 | `computeStressIncrement` | willingness/ambiguityTolerance由来 + observerJoiner追加項 | 同種の式を再利用(観察用途のみ、`canLeave`に効かない) |
| 5 | シミュレーション全体の終了条件 | `isFinished` / `finishReason` | 全員`joined`\|`left`(`allSettled`)、または`tick >= 400`(`maxTicksReached`) | 全員`joined`(`allAssigned`)、または`tick >= formationDeadlineTick`(`deadlineReached`) |
| 6 | 候補の成立最小人数・収容最大人数 | `resolveGroupCapacity` | `min = groupConfirmSize`, `max = Infinity`(実質無制限) | `min = max = 2`(固定) |
| 7 | 成立判定用の"集まった人数"の数え方 | `computeConfirmationCount` | 近接ヒューリスティック(まだ`memberIds`に加わっていない近くの人も含む) | `candidate.memberIds.length`のみ(定員厳格化のため近くの無関係者を含めない) |
| 8 | 参加失敗(満員等)による追加stress増分 | `computeJoinFailureStressIncrement` | `willingness * 0.08`(`capacityFull`時のみ) | `willingness * 0.1`(定員2固定のため「最後の1枠を逃す」頻度が高く、やや高め) |

いずれのメソッドも`Agent`/`GroupCandidate`/`SimParams`の既存フィールドだけを読み取り、
新しいエージェントフィールドを追加しない(`classroomPair`は既存の`initiative`/`influenceAvoidance`/
`conformity`/`cliqueId`/`stress`をそのまま再利用している)。新シナリオを設計する際も、まずこの
既存フィールドの組み合わせで表現できないかを検討することを推奨する。

## 実行時の解決

- `FormationScenarioId`(`"afterParty" | "classroomPair"`)は`createInitialState`/`stepSimulation`に
  `FormationRuntimeOptions`として渡す。省略時は`"afterParty"`(既存プリセットとの後方互換)。
- `SimulationState.formationScenarioId`/`formationDeadlineTick`は、呼び出し側が`stepSimulation`に
  `formation`を渡し忘れても直前のtickの設定を引き継ぐ(`interventionId`と同じfall backパターン)。
  これにより、UIループが毎tick`formation`を渡さなくてもシナリオが途中でリセットされない。
- `classroomPair`は`formationDeadlineTick`ごとに異なる`FormationPolicy`インスタンスが必要なため
  (締切tickがポリシーのクロージャに閉じ込められている)、`afterPartyPolicy`のような固定シングルトンでは
  なく`getFormationPolicyById`が毎回`createClassroomPairPolicy(formationDeadlineTick)`で組み立てる。
  新シナリオがパラメータ化されたポリシーを必要とする場合も、同じパターンに従う。

## 新シナリオ(例: 3〜4人班分け)を追加する手順

3〜4人の班分けのように、`classroomPair`と近いが定員が可変(または3〜4の範囲)なシナリオを
追加する場合を例に、実装すべき箇所を挙げる。

1. `FormationScenarioId`に新しいidを追加する(例: `"classroomGroup"`)。
2. 新しい`FormationPolicy`実装(例: `createClassroomGroupPolicy`)を追加する。多くの責務は
   `classroomPair`の実装を出発点にできる:
   - 責務6(`resolveGroupCapacity`)を`min = 3, max = 4`のように変更する。班のサイズを人口や
     パラメータに応じて可変にしたい場合は、ここでその決定ロジックを持つ。
   - 責務3a(`shouldConfirmCandidate`)を`nearbyCount >= capacity.minGroupSize`相当に変更する
     (`classroomPair`は`min = max = 2`のため定数`2`で決め打ちしているが、可変定員では
     `resolveGroupCapacity`の結果を参照する形に一般化する必要がある)。
   - 責務4a/4b・責務7・責務8は「退出不可」「memberIdsのみで数える」という`classroomPair`の設計を
     多くの場合そのまま踏襲できる。
   - 責務5(`isFinished`/`finishReason`)は`classroomPair`の`allAssigned`/`deadlineReached`パターンを
     再利用しつつ、3〜4人班特有の終了理由(例: 「最大定員に達しないまま締切に達した班がある」)を
     追加する場合は`SimulationFinishReason`(`types.ts`)に新しい値を追加する。
3. `getFormationPolicyById`に新idの分岐を追加する。
4. `presets.ts`に新しいプリセット(`formationScenarioId`指定)を追加する。
5. `engine.ts`は変更不要なはずである。もし変更が必要になった場合(例: 3人以上の候補特有の
   接近判定が既存の`nearestCandidate`ロジックで表現できない場合)、それは責務の切り分けが
   不足している可能性が高いため、新しい責務(9個目)としてこのインターフェースへ追加することを
   優先的に検討する。
6. テストは`classroomPairInvariants.test.ts`(Issue #137)と同じパターン
   (複数seed × 複数人数での不変条件チェック、境界人数、同一tick最終枠競合)を新シナリオ向けに
   複製する。特に「定員を超えない」「確定グループは`resolveGroupCapacity`の範囲内」の不変条件は
   定員が固定値でなくなる分、`classroomPair`のテストより一般化した形で書く必要がある。

## 意図的に`FormationPolicy`の外側に置いているもの

- 介入シナリオ(`interventions.ts`)による確率・しきい値の補正。`FormationPolicy`はこれを一切
  参照せず、補正は`engine.ts`側で基礎値に対して適用する。
- Phase 3/4(発言・trust・関係性)関連のロジック。これらは`FormationPolicy`とは独立した軸で、
  `speechEffects.ts`/`socialExpression.ts`等が別途`engine.ts`へ結線する。
- 表示用の文言分岐(ログメッセージ)。`formationPolicy.id`に応じた文言の出し分けは`engine.ts`側に
  残っており、`FormationPolicy`自体は文言を持たない(責務の対象外)。
