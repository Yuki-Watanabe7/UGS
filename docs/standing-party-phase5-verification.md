# standingParty Phase 5 統合検証 (Issue #235)

## 目的と範囲

Phase 5 は、Topic / canonical Claim / ClaimVariant、内容発話、受信・採用・記憶、再伝達・変容、会話満足度・
cluster 移動への限定的feedback、伝播の観察・exportを一つのrunで扱う。個別機能の実装は #229〜#234 で完了して
おり、本書はそれらを組み合わせた際の不変条件、再現性、UI到達性、性能確認の正本である。

これは仮説的なシミュレーションの内部状態を検証する資料であり、人物の知性・信頼性・影響力や、現実の情報伝播を
測定・予測・診断するものではない。

## 用語と因果境界

| 用語 | 意味 | 混同しないもの |
| --- | --- | --- |
| `heard` | carrier SpeechEventが届いた | 理解・採用・記憶 |
| `adopted` | receiverがこのrun内でclaimを採用したdecision | 真実であること |
| `remembered` | memoryStrengthが閾値を上回り再伝達候補になれる状態 | 一度も忘れていないこと |
| `retold` | 既に保持するclaim / variantを再伝達したevent | 新規variantの生成 |
| `rumor` | 未検証のsource hopを伴う流通上の分類 | `false` |
| `uncertain` | decisionまたはverificationが未確定の状態 | `false` |

`InformationClaim.originalSource`はcanonicalな起点、`SourceTrace.immediateSpeakerId`は直前の話者であり、
同じ値に潰さない。Variant lineageは canonical root からの木、複数経路を含むprovenanceはDAGとして保持する。
接触networkは分析用の同席履歴であり、runtimeの発話・採用・移動判断へは入力しない。

## 受入条件と自動検証

| 観点 | 主な検証 |
| --- | --- |
| catalog / variant lineage | `informationModel.test.ts`, `claimVariant.test.ts`, `standingPartyPhase5Verification.test.ts` |
| 内容発話→受信→採用→記憶→再伝達のID鎖 | `contentUtteranceWiring.test.ts`, `informationTransmission.test.ts`, `retellingWiring.test.ts`, `standingPartyPhase5Verification.test.ts` |
| 同一tickの集約・順序不変・重複防止 | `informationTransmission.test.ts` |
| forget / relearn・source trace・上限 | `informationTransmission.test.ts`, `informationState.test.ts`, `standingPartyPhase5Verification.test.ts` |
| topic feedbackの単調性・非公開state非参照 | `topicCompatibility.test.ts`, `alternativeClusterInterest.test.ts`, `clusterTransitionDecision.test.ts` |
| master OFF時のPhase 4互換・PRNG不変 | `informationRuntimeWiring.test.ts`, `contentUtteranceWiring.test.ts`, `retellingWiring.test.ts` |
| 同一seed/configのruntime / lineage / export再現 | `standingPartyPhase5Verification.test.ts` |
| 1,000 tick・複数seedのcap / NaN / orphan参照 | `standingPartyPhase5Verification.test.ts` |
| 分析・filter・exportの非介入 | `informationAnalysis.test.ts`, `standingPartyPhase5Verification.test.ts` |
| UIとexportの集計一致・CSV safety | `informationAnalysis.test.ts`, `analysisExport.test.ts`, `standingPartyPhase5Verification.test.ts` |
| desktop / iPhone相当幅の主要観察flow | `e2e/standingPartyPhase5.desktop.spec.ts`, `e2e/standingPartyPhase5.mobile.spec.ts` |

`standingPartyPhase5Verification.test.ts` は「口コミが変容しやすい場」で内容発話・受信・採用・
再伝達を実際に発生させ、event ID・speech ID・variant・source trace・agent stateの参照を照合する。
長時間ケースは「情報が広がりやすい交流会」と「口コミが変容しやすい場」の2 preset、2 seedを
それぞれ1,000 tick実行する。各runでvariant catalogを再validationし、source trace cap、数値の定義域、
duplicate event ID、孤児参照、adoptionの二重適用を検出する。

## 観察UIとexport

standingParty のPhase 5 preset（`standing-party-info-rich`、`standing-party-topic-segmented`、
`standing-party-rumor-mutation`、`standing-party-info-seeking`）を選び、固定Seedで Reset して実行する。
右sidebarの「情報伝播の観察・分析」から、次を同じfilter条件で確認できる。

- 状態・Inspector: claim / confidence / memory / source trace
- 伝播network: heard / adopted等の実伝播edge。灰色の接触線は別のread model
- Claim lineage: root / variant / mutation factor
- timeline: utterance → reception → adoption → memory update → retelling のID鎖
- 記述統計: 分母付き伝播率、到達、variant / source hopの分布

JSON / CSV exportは統計ダッシュボードから実行する。JSON schemaは
`standing-party-analysis-export/2`で、`informationPropagation`配下にPhase 5のcatalog、event、
read model、統計を収める。CSVは用途別に分割し、formula injectionとなり得る先頭文字をescapeする。
表示、tab切替、filter、exportはruntime state・event列・main PRNGを変更しない。

## 再現性と性能確認

通常の確認は次で行う。

```bash
npm run lint
npm run test
npm run build
npm run typecheck:e2e
npm run test:e2e
```

Phase 5だけを反復する場合は次を使う。

```bash
npm test -- src/simulation/standingPartyPhase5Verification.test.ts
npm test -- src/simulation/informationTransmission.test.ts src/simulation/retellingWiring.test.ts src/simulation/informationAnalysis.test.ts
npx playwright test e2e/standingPartyPhase5.desktop.spec.ts e2e/standingPartyPhase5.mobile.spec.ts
```

性能確認では脆い絶対時間の合否を主目的にしない。上記の1,000 tick runについて、次を比較・記録する。

1. 内容発話、reception、adoption、memory update、retelling、generated variant、source traceの件数。
2. `maxVariantsPerClaim`、`maxLineageDepth`、`maxSourceTracesPerAgentClaim`の上限が守られていること。
3. `buildInformationPropagationAnalysis`、JSON serialize、CSV生成を一回ずつ実行し、event数に対して明白な
   tick × agent × claim × render の全再計算が導入されていないこと。
4. analysis/exportを毎tick呼ぶrunと呼ばないrunのstate、event、main PRNG probeが一致すること。

実装はmemory forget scheduleとfilter済みtimelineのページングを使う。worker / GPU最適化や大規模populationの
性能保証はPhase 5の対象外である。
