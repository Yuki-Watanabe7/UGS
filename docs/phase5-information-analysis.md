# Phase 5 情報伝播の観察・export

Issue #234で追加した「情報伝播の観察・分析」panelは、Phase 5のruntime stateと構造化eventを**読むだけ**です。表示、filter、exportはシミュレーションの状態遷移・PRNG・意思決定を変更しません。

## まず見る場所

- Canvas: 成立済みの会話の輪に、現在topicの短いIDだけを表示します。claim本文を常時表示しません。`*`はそのtickにtopicが変わったことを示します。
- 状態・Inspector: agentごとのtopic interest / fatigue、claimのaware・acceptance・confidence・memory・active variant・聞いた時刻・source trace・retell記録を確認します。claim stateが存在しない場合は「未接触」と表示し、`0`や`false`で代用しません。
- 伝播network: 灰色の背景線はPhase 4の接触（同席）、矢印は実際の内容発話を聞いた記録です。採用・rejected・uncertain・already knownを線種と色の両方で区別します。接触だけでは伝播矢印を生成しません。
- Claim lineage: canonical rootからvariantまでを深さ付きtableでたどれます。`mutated`は構造化された表現変化であり、虚偽化を意味しません。`uncertain`も誤情報の断定ではありません。
- timeline / 記述統計: `ContentUtterance → InformationReception → Adoption → MemoryUpdate → Retelling`のID連鎖、分母つきの伝播率、到達時刻、variant・lineage分布を確認します。

## 共通filter

topic、claim、variant、agent、source agent、cluster、tick範囲、受信結果、再伝達結果、ObserverJoiner、最小confidence、最小memoryを同じread modelへ適用します。timelineは80件ずつページングし、長時間runでもDOMを増やし続けません。filter後の全件はexportへ入ります。

## export

統計ダッシュボードのJSON exportとCSV一式は `standing-party-analysis-export/2` を出力します。既存のPhase 4 history / contact network / statisticsに加え、次を含みます。

- topic・claim・variant catalogとvariant lineage
- agent information snapshot / cluster topic snapshot
- content utterance、reception、adoption decision、memory update、retelling
- transmission recordとpropagation edge
- Phase 5のconfig、feature flag、記述統計

CSVは `standing-party-information-*` と `standing-party-agent-information.csv` に分割します。文字列セルはformula injectionを避けるため、`=`, `+`, `-`, `@`などで始まる値をquoteします。

## 用語上の境界

この画面の `confidence`、`memory`、`trust`、`adoption`、`retelling` はすべてシミュレーション内部の仮説的な状態です。正しさ、知性、人気、影響力、人格、現実の信用を測定・評価するものではありません。
