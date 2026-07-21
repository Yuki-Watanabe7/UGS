# 学校向け介入の実行契約(Issue #156)

この文書は、[`schoolInterventionRuntime.ts`](../src/simulation/schoolInterventionRuntime.ts)が定義する
学校向け介入(教師介入)の実行契約と、[`interventions.ts`](../src/simulation/interventions.ts)の
`InterventionApplicability`メタデータがどう連携するかをまとめる。個々の学校向け介入
(近接促進・空き枠表示・推薦・締切時強制割当等)の実装自体はこのIssueの対象外であり、
`resolveSchoolIntervention`は常に`undefined`を返す(=登録済み介入なし)。ここでは
**後続Issueが個別介入のロジックだけを実装できる土台**の設計面に焦点を当てる。

## なぜこの境界が存在するか

[`formationPolicy.ts`](formation-policy-model.md)が「グループ形成・終了ルール」を`engine.ts`本体の
分岐から切り離したのと同じ理由で、学校向け介入(近接促進・推薦・締切強制割当…)を
`engine.ts`内の`interventionId`分岐として素朴に実装すると、介入が増えるたびに対象選択・
乱数消費・イベント記録の実装方式がばらつき、`engine.ts`全体に分岐が散らばる。

二次会向け6介入(`interventions.ts`の`explicit-meeting-point`等)は既に`engine.ts`内の
`interventionId`分岐として実装済みだが、これは**既存挙動を維持するためあえて変更していない**
(受入条件: 既存二次会介入の意味変更をしない)。学校向け介入は、この契約を新たに導入する
ことで最初から`engine.ts`の巨大分岐を避ける。

## 適用可能範囲メタデータ(`interventions.ts`)

`InterventionScenario.applicability`(`InterventionApplicability`型)が、介入1件ごとに以下を持つ:

| フィールド | 意味 |
| --- | --- |
| `scenarios` | 選択可能な`FormationScenarioId`一覧 |
| `audience` | `"none"` \| `"afterParty"` \| `"school"` |
| `hooks` | 実際に使う学校向け実行フック(afterParty向け介入は常に`[]`) |
| `configKeys` | 参照する設定キー(人間向けメモ) |
| `implemented` | engine側の実装が存在し実行可能か |

`resolveAvailableInterventionIds(scenarioId)`が`implemented && scenarios.includes(scenarioId)`で
`INTERVENTION_SCENARIOS`をフィルタし、定義順のまま返す。
[`scenarioPresentation.ts`](../src/presentation/scenarioPresentation.ts)の
`AFTER_PARTY_PRESENTATION`/`CLASSROOM_PRESENTATION`の`availableInterventionIds`はこの関数の
戻り値をそのまま使うため、**適用可能シナリオとpresentation許可リストは常に整合する**
(新しい学校向け介入を追加し`implemented: true`にした瞬間、presentationにも自動的に現れる)。
`normalizeInterventionForPresentation`(既存、Issue #148)がこの許可リストに無いIDを`"none"`へ
正規化する経路は変更していない。

## 実行コンテキスト(`SchoolInterventionContext`)

介入は`SimulationState`を直接参照・mutationしない。`engine.ts`が各hook呼び出し時点のスナップショットを
組み立てて渡す:

```ts
type SchoolInterventionContext = {
  hook: SchoolInterventionHook;
  tick: number;
  agents: readonly Agent[];
  groupCandidates: readonly GroupCandidate[];
  formationPolicy: FormationPolicy;      // resolveGroupCapacity等はここ経由で参照する
  params: SimParams;
  deadlineTick?: number;                 // classroomPair系のみ定義される
  recentEvents: readonly { eventType?: SimulationEventType; metadata?: SimulationEventMetadata }[];
  runSeed: number;                       // 本体SeededRandomとは独立。介入専用rngの導出元
  runId: string;                         // createRunIdで導出、UI/ログ相関用
  runtimeState: InterventionRuntimeState;
};
```

## 6つの実行フック

`SchoolInterventionHook`(`interventions.ts`)と`SCHOOL_INTERVENTION_HOOK_ORDER`が固定の実行順序を定義する。
`engine.ts`は`createInitialState`/`stepSimulation`内の対応する箇所で`fireIntervention(hook)`を呼ぶ:

| # | hook | engine.ts内の発火位置 | 想定する用途の例 |
| --- | --- | --- | --- |
| 1 | `initialState` | `createInitialState`で初期状態を組み立てた直後 | 初期の空き枠表示、教師の開始アナウンス |
| 2 | `beforeTick` | `stepSimulation`冒頭、核形成(step 1)より前 | 低圧な後押し(毎tick判定するタイプ) |
| 3 | `beforeApproachDecision` | 接近判定(step 2)の直前 | 近接促進(接近確率への一時補正) |
| 4 | `afterStateTransition` | このtickの通常の状態遷移が全て完了した後 | 状態変化を見てからの推薦更新 |
| 5 | `beforeDeadline` | 締切判定(`finishReason`計算)の直前。`deadlineTick`が定義されている(=classroomPair系)tickのみ | 締切が近いことの通知 |
| 6 | `atDeadline` | 締切到達(`finishReason === "deadlineReached"`)が確定した直後、未割当確定ループの前 | 締切時強制割当 |

全ての介入が全フックを実装する必要はない。`SchoolIntervention`の対応するプロパティ
(`onInitialState`等)を実装したフックだけが呼ばれ、未実装のフックは`runSchoolInterventionHook`が
自動的に空の結果(no-op)として扱う。「教師強制割当だけが`atDeadline`/`beforeDeadline`を使い、
低圧介入は`beforeTick`/`beforeApproachDecision`だけを使う」という責務の分離は、
実装するプロパティを選ぶだけで表現できる。

## 結果の返し方(3種類、`SimulationState`を直接書き換えない)

- **`InterventionEffect`**: engineの判断式(接近確率/魅力度/ストレス蓄積率/離脱しきい値)への
  一時的な加算補正。`speechEffects.ts`の`SpeechActiveEffect`と同じ設計(`dimension`/`agentId`/`value`/
  `startedAtTick`/`expiresAtTick`)。`sumInterventionEffectValue`/`advanceInterventionEffects`で
  集計・失効させる。**現時点では`engine.ts`のどの判断式もこれを消費していない**(登録済み介入が
  存在しないため消費先が無い)。最初の実効的な学校向け介入がこの値を返すようになった時点で、
  `speechEffects.ts`の`sumActiveEffectValue`の使われ方(接近確率/ストレス増分/離脱しきい値への
  加算)を参考に、対応する箇所へ`sumInterventionEffectValue`の呼び出しを追加する。
- **`InterventionAction`**: 状態を直接書き換える必要がある結果。`assignToGroup`/`markUnassigned`の
  2種類を`engine.ts`の`applyInterventionActions`が汎用的に適用する(介入IDごとの分岐なし)。
  締切時強制割当のような介入は、`atDeadline`フックで`assignToGroup`を返すことで、未割当確定
  ループより先に割当を成立させられる。
- **`InterventionEvent`**: 構造化ログ(`SimulationEventType.schoolInterventionTriggered`)として
  `state.log`へ記録する結果。表示用`message`とは別に、`SimulationEventMetadata`へ
  `interventionCategory`/`sourceAgentId`/`isTeacherSource`/`triggerReason`/`effectStartedAtTick`/
  `effectExpiresAtTick`/`outcome`(`SchoolInterventionOutcome`)を載せられるため、後続の集計は
  表示文言の解析に依存しない。

## 決定的な対象選択と乱数分離

- `createInterventionRandom(runSeed, interventionId, tick, salt)`が、本体`SeededRandom`とは独立の
  介入専用rngを`runSeed`・介入ID・tick・`salt`(対象候補ID等)から決定的に導出する。介入の対象選択に
  乱数が必要な場合は、必ずこの関数で得たrngだけを使い、`engine.ts`が保持する本体`rng`
  (`stepSimulation`の引数)を一切読み書きしてはならない。
- rngすら不要な決定的選択(例: 「stress最大のagentを選ぶ」)には`stableSortById`(id昇順の安定ソート)
  を使う。
- この分離により、介入が実際に対象を選んでも本体`rng`の消費列(=`agents`の移動・接近判定等の
  行動決定)は一切ずれない。`schoolInterventionEngineWiring.test.ts`が、学校向け介入が1つも
  登録されていない現状で、hookの結線自体が既存の`classroomPair`挙動(agent座標・候補・ログ・
  fall backパターン)に一切影響しないことを回帰テストしている。介入が実際に登録された後は、
  「介入なしのrun」と「発火条件を満たさず何もしなかった介入run」で本体`rng`消費列(=agentsの
  移動・状態遷移の系列)が一致することを、同じ形式のテストとして追加する。

## `InterventionRuntimeState`(複数tickにまたがる進行状態)

```ts
type InterventionRuntimeState = {
  intervenedAgentIds: string[];
  intervenedGroupIds: string[];
  lastTriggeredAtTick: Record<string, number>;
  temporaryEffectExpiryByAgentId: Record<string, number>;
  recommendedGroupIdByAgentId: Record<string, string>;
  anonymouslyNotifiedAgentIds: string[];
  forcedAssignmentApplied: boolean;
};
```

`Agent`本体へ介入ごとの任意フィールドを増やし続けず、可能な限りここへ集約する方針。
既存の`Agent.invitedAtTick`(`light-observer-invitation`用)は後方互換のため維持しており、
移行は必須ではない。`SimulationState.interventionRuntimeState`は`interventionId`と同じ
fall backパターン(呼び出し側が引き継ぎ忘れても直前の設定を維持する)で扱われ、
Reset・seed変更・プリセット変更・シナリオ遷移はいずれも`createInitialState`の再呼び出しを経由する
既存の経路のため、この状態も自動的に空(`createInitialInterventionRuntimeState()`)へ初期化される。

## 新しい学校向け介入を追加する手順(将来のIssue向け)

1. `interventions.ts`に新しい`InterventionScenarioId`を追加し、`applicability`を
   `{ scenarios: ["classroomPair"], audience: "school", hooks: [...], configKeys: [...], implemented: true }`
   のように設定する。`implemented: true`にした時点で`resolveAvailableInterventionIds("classroomPair")`
   経由でpresentationに自動的に現れる。
2. `schoolInterventionRuntime.ts`の`SCHOOL_INTERVENTION_POLICIES`へ、`SchoolIntervention`実装
   (使うフックのプロパティだけ)を登録する。
3. 対象選択に乱数が必要なら`createInterventionRandom`(または`stableSortById`)だけを使い、
   `engine.ts`の本体`rng`には触れない。
4. 判断式への一時補正が必要なら`InterventionEffect`を返し、`engine.ts`側の該当箇所
   (`speechEffects.ts`の`sumActiveEffectValue`と同じパターン)へ`sumInterventionEffectValue`の
   呼び出しを追加する。状態を直接書き換える必要があるなら`InterventionAction`を返す
   (`applyInterventionActions`が汎用的に適用する)。
5. 構造化ログには`schoolInterventionTriggered`イベントを使い、`SimulationEventMetadata`の
   Issue #156追加フィールドで結果を表現する(表示用`message`の文字列解析に依存する集計を
   追加しない)。
6. テストは`schoolInterventionRuntime.test.ts`(hookの契約自体)と
   `schoolInterventionEngineWiring.test.ts`(engine結線)の両方に、新しい介入固有のケースを追加する。
   特に「介入なしのrun」と「発火条件を満たさなかったrun」で本体`rng`消費列が一致することの
   回帰テストは必須(受入条件)。

## 実装済みの学校向け介入(Issue #157)

Issue #157で、この契約上に最初の2件の低圧介入を実装した(`SCHOOL_INTERVENTION_POLICIES`へ登録済み)。
いずれも教師が組み合わせを決定せず、確率・attractivenessへの一時補正だけを通じて自律形成を支援する。

- **`nearby-peer-prompt`**(`src/simulation/schoolInterventions/nearbyPeerPrompt.ts`): 近くの未決定者
  (再探索中を含む)同士へ声かけを促す。`onBeforeApproachDecision`フックのみを使い、距離最小・id順の
  完全に決定的な選択(rng不使用)で1組ずつ対象を選び、接近確率・attractivenessへ一時的な加算補正を
  与える。対象2人を直接同じ`GroupCandidate`へ所属させることはしない。
- **`open-group-signal`**(`src/simulation/schoolInterventions/openGroupSignal.ts`): 空きのある
  forming/可変定員confirmed候補を毎tick洗い出し、`onAfterStateTransition`フックで表示開始/終了を
  記録しつつ、未決定者からその候補へのattractivenessを一時的に底上げする(targetGroupId指定)。
  表示自体は`SimulationCanvas`の候補ステータス欄(既存、全候補について常時表示)を再利用し、
  この介入固有のCanvas UIは追加していない。

両介入とも`ctx.formationPolicy.id !== "classroomPair"`なら明示的にno-opにする(afterPartyへ
誤って選択されても既存挙動を変えないための防御)。

## 意図的にこの契約の外側に置いているもの

- 上記2件以外の個別の学校向け介入ロジック(推薦候補選択式、締切時強制割当アルゴリズム等)。
  Issue #157でも対象外であり、後続Issueが`SCHOOL_INTERVENTION_POLICIES`へ実装を追加する。
- 介入比較UI・Monte Carlo指標。Issue #156の対象外。
- 二次会向け6介入(`interventions.ts`の`interventionId`分岐)の挙動・意味の変更。この契約は
  二次会向け介入を一切参照しない(`applicability.hooks`が常に`[]`であることからも分かるとおり)。
