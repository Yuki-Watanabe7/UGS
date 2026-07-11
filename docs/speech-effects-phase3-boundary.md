# Phase 3: 発言の認知・解釈・効果を追跡する因果イベントモデル

Issue #93 の受入条件に対応する設計文書。`src/simulation/speechEffects.ts`で導入した
`SpeechReceptionEvent` / `SpeechInterpretationEvent` / `SpeechEffectEvent`の3型と、それらを
生成する3つのpure関数(`deriveSpeechReceptions` / `deriveSpeechInterpretations` /
`deriveSpeechEffects`)の設計意図・責務境界をまとめる。

## 1. 責務差の一覧

| 型 | 定義場所 | 責務 | 他エージェントの判断に使われるか |
| --- | --- | --- | --- |
| `ExpressionEvent` | `expression.ts` | 観察者にのみ見える非介入の演出データ(「心の声」)。`SimulationState`には保持されない | 使われない |
| `SpeechEvent` | `speech.ts` | 実際に発せられ他エージェントが認知しうる発言そのもの。`speechLog`に蓄積 | Phase 2時点では使われない(生成・記録・表示のみ) |
| `LogEntry` | `types.ts` | 人間可読な出来事の記録・集計(Monte Carlo等)用の文字列+構造化メタデータ | 使われない(意思決定の入力にしないという既存原則を維持) |
| `SpeechReceptionEvent` | `speechEffects.ts` | `SpeechEvent`1件につき、認知対象になった受け手ごとの「聞こえたか」の記録 | 使われない(Phase 3は記録のみ) |
| `SpeechInterpretationEvent` | `speechEffects.ts` | `SpeechReceptionEvent`1件につき、受け手がどの入力要因(`intent`)でどう解釈した(`valence`)かの記録 | 使われない |
| `SpeechEffectEvent` | `speechEffects.ts` | `SpeechInterpretationEvent`1件につき、どの状態次元(`dimension`)へどの強度・期間で作用しうるかの記録 | 使われない(Agent.stress等への実適用はPhase 4以降) |

## 2. 一方向のpure処理境界

```
SpeechEvent --(deriveSpeechReceptions)--> SpeechReceptionEvent
           --(deriveSpeechInterpretations)--> SpeechInterpretationEvent
           --(deriveSpeechEffects)--> SpeechEffectEvent
```

- 3関数はいずれも`SimulationState`・`Agent`・`SeededRandom`のいずれも参照/変更しない。
  入力は前段の配列(および元の`SpeechEvent[]`)と`SpeechEffectsConfig`のみ。
- 各段は`id`で前段と関連付けられる: `SpeechInterpretationEvent.receptionEventId` →
  `SpeechReceptionEvent.id`、`SpeechEffectEvent.interpretationEventId` →
  `SpeechInterpretationEvent.id`。全段が`speechEventId`(元の発言のid)と`receiverId`
  (誰にとっての記録か)も保持するため、どの段からでも元の発言・対象者を直接参照できる。
- `engine.ts`の`stepSimulation`は、このtickで新しく生成された`SpeechEvent[]`
  (`speechEvents`直接生成分 + `deriveSpeechEvents`導出分)を1回だけこのパイプラインに通し、
  結果を`state.speechReceptionLog`/`speechInterpretationLog`/`speechEffectLog`に
  明示的に積み上げる(`speechLog`と同じ「tick単位で生成→蓄積」の形)。

## 3. 対応した範囲・対応しなかった範囲

対応した範囲(このissueのスコープ):

- 3段階の型と、それぞれをつなぐpure関数境界
- `speechEventId`/`receiverId`によるID一貫性(前段のidも保持し、後段から常に遡れる)
- 発生tick(`tick`/`occurredTick`)・適用tick(`appliedTick`)・`reason`・入力要因
  (`inputFactors`)・出力値(`outputValue`)・継続期間(`durationTicks`)の構造化保持
- 同一tick内の処理順序の決定性(`speechEvents`の生成順 → その中でのreceiverIdsの順)
- `SpeechEffectsConfig`(`enabled`のみ)による有効/無効の設定境界。デフォルト`false`で、
  既存の`SimParams`/`InterventionRuntimeOptions`とは独立した後方互換の追加設定
- 型・生成境界のユニットテスト(`speechEffects.test.ts`)とengine結線テスト
  (`speechEffectsWiring.test.ts`)

対応しなかった範囲(意図的に対応しない、issue記載の対応しない範囲そのまま):

- **距離に基づく具体的な認知判定**: `deriveSpeechReceptions`はPhase 2までの`target`/
  `audience: "nearby"`という二値モデルをそのまま使う。座標・範囲は一切見ない
  (`docs/speech-event-intervention-boundary.md`の4節で予告されていた拡張点)。
- **性格・関係性に基づく解釈式**: `deriveSpeechInterpretations`は発言の`intent`のみを
  入力要因とする固定の対応表(`INTENT_VALENCE`)で解釈する。受け手の`willingness`/
  `influenceAvoidance`等の性格パラメータや`cliqueId`(既存関係性)は一切参照しない。
- **stressや参加判断への効果適用**: `deriveSpeechEffects`が生成する`outputValue`/
  `durationTicks`は「作用しうる値」の構造化された記録に留まり、実際に`Agent.stress`や
  `attractiveness()`・接近確率等へ適用する処理はどこにも存在しない。`engine.ts`は
  この3関数の結果を`state`の新しいログフィールドに書き込むだけで、既存の状態遷移ロジック
  (核形成・接近・stress蓄積・グループ成立判定)からは一切参照されない。
- UI表示・Monte Carlo指標: 新しい型はUIコンポーネントからは一切参照されず、
  `monteCarlo.ts`の集計にも含まれない。
- 本心と建前、信頼学習: 対応表(`INTENT_VALENCE`/`VALENCE_STRESS_EFFECT`)は固定値であり、
  学習・状態保持は行わない。

## 4. 後方互換性・非介入性の保証

- `SpeechEffectsConfig.enabled`のデフォルトは`false`。`createInitialState`/`stepSimulation`に
  第4引数を渡さない既存の全呼び出し箇所(`monteCarlo.ts`、`App.tsx`、既存テスト群)は
  今まで通り動作し、`speechReceptionLog`/`speechInterpretationLog`/`speechEffectLog`は
  常に空配列になる(`speechEffectsWiring.test.ts`で検証)。
- `enabled: true`にした場合でも、`agents`/`groupCandidates`/`log`/`speechLog`および
  rngの消費量は`enabled: false`の場合と完全に一致する(同テストで検証)。これは3関数が
  `SimulationState`/`Agent`/rngのいずれも参照/変更しない純粋関数であることの直接的な帰結。
- `interventionId`と同様、`stepSimulation`は呼び出し側が`speechEffects`引数を渡し忘れても
  `state.speechEffectsEnabled`にfall backし、途中のtickで無効化状態に戻ってしまうことを防ぐ。

## 5. 参照

- Issue #93(本文書が対応するissue)、親ロードマップ #61
- `docs/speech-event-intervention-boundary.md`(Issue #84、Phase 2時点の責務境界。4節「Phase 3
  への拡張点」が本issueの出発点)
- `src/simulation/speechEffects.ts`, `src/simulation/speech.ts`, `src/simulation/engine.ts`,
  `src/simulation/types.ts`
- `src/simulation/speechEffects.test.ts`, `src/simulation/speechEffectsWiring.test.ts`
