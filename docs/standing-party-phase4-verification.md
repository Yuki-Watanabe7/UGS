# standingParty Phase 4: 会話履歴・接触ネットワーク・統計可視化の統合検証 (Issue #218)

Parent Roadmap: #172。Depends on: #211(ADR)、#212(履歴)、#213(接触network)、#214(統計)、
#215(timeline)、#216(network graph)、#217(dashboard/export)。

本Issueは新しいシミュレーション挙動を追加する目的の作業ではない。#211〜#217で実装済みの
standingParty Phase 4 分析層(会話履歴・接触ネットワーク・記述統計・timeline / network /
dashboard / JSON・CSV export)について、実データ較正前の仮説段階のモデルであることを前提に、
issueが列挙する12領域を実際にどこまで満たしているか棚卸しし、見つかった不足分だけを追加した。
`docs/standing-party-phase3-verification.md`(#203)と同じ立場を取る。

> **命名の注意**: Roadmap #61 の「Phase 4」(社会的表現・発話信頼・関係性補正)とは**別物**。
> 本検証の対象は Roadmap #172 の「会話履歴・接触ネットワーク・統計可視化」である。
> 契約の正本は [`standing-party-analysis-phase4-model.md`](standing-party-analysis-phase4-model.md)。

## 0. 棚卸しの結果: 大半は#212〜#217が実装と同時に満たしていた

事前の棚卸しにより、issue #218が列挙する12領域のうち次はすでに個別Issueのテストで満たされている
ことを確認した(詳細な根拠は各テストファイル自体のコメントを参照):

- 1節の断片的fixture・2節の履歴不変条件の一部・3節のcontact不変条件の一部 —
  `standingPartyAnalysis.test.ts` / `contactNetwork.test.ts`
- 4節の統計性質の大部分 — `standingPartyStatistics.test.ts`
- 7節の性能スモークの一部(200tick) — `standingPartyStatistics.test.ts`
- 8節のcomponent単位テスト — `ConversationHistoryTimeline.test.ts` /
  `ContactNetworkGraph.test.ts` / `StandingPartyAnalyticsDashboard.test.ts`
- 10節のexport schema・escaping・決定性 — `analysisExport.test.ts`
- 11節の既存シナリオ回帰の大部分 — 各機能の非干渉テスト + Phase 3 E2E
- 12節の設計文書 — ADR(`standing-party-analysis-phase4-model.md`) + README #212〜#217節

見つかった不足分は次であり、本Issueではこれだけを追加した(要件にない新機能・リファクタは
行っていない)。

## 1. 決定的履歴fixture (issue 1節)

`standingPartyAnalysisPhase4Verification.test.ts`に、確率0/1ではなく**固定log列**で次を再現する
fixtureを追加した:

```text
cluster A形成(Gap Bでfounder episode開始)
→ agent 2・3がjoinし3pair contactへ増加
→ agent 1が自発離脱しtargeted transitionを開始(episode/contact終了)
→ cluster B形成 → agent 1がBへjoinし新episode開始
→ Aが最小人数割れで残存memberを強制release
→ observation horizon到達時にBのepisode/contactがcensoredのまま残る
```

各段階でepisode / membership / contact / lifetime / transition / 統計件数を照合する。

## 2. 履歴・contact・統計の横断不変条件 (issue 2〜4節)

`standingPartyAnalysisInvariants.ts`の`assertStandingPartyAnalysisInvariants`へ集約した:

- 1agentのopen episodeは最大1件、membershipはepisodeと1:1
- dwellTicksが半開区間規約と一致、endedAtTick >= startedAtTick
- active/censoredを完了分布へ混ぜない件数整合
- pair key正規化・self-edge禁止・edge集約ticks = interval和
- empty分布でNaNを返さない、成功率の分母0はrate undefined

ロングランでは50tickごとにこのassertを呼ぶ。

## 3. event cross-check (issue 5節)

同一fixture上で、`state.log`の`eventType`/`metadata`だけから:

- join系イベントのepisodeIdと履歴レコード
- Gap B founder episodeの存在
- `clusterDepartureCompleted` ↔ `voluntaryDeparture`/`targetedTransition`
- `clusterMemberReleased` ↔ `memberReleased`
- `clusterTransitionTargetSelected`/`Completed` ↔ transition result

を突合する。`message`文字列は参照しない。加えて同一episodeIdの
`agentJoined`+`observerJoinedConfirmed`二重が1件に畳まれ`duplicateEpisodeStart`診断を残すことも
固定した。

## 4. seed再現性・長時間安定性・分析非介入 (issue 6節)

- Phase 3有効プリセット(`standing-party-outward-interest` /
  `standing-party-current-circle`)×3seed×1000tickで、runtime不変条件
  (`assertStandingPartyInvariants`)に加え分析層不変条件を検証
- speechEffects / socialExpression / speechTrust / relationshipTie をApp.tsxと同じくON
- 毎tick analysis導出あり/なしで状態系列・event列・PRNG消費が完全一致
  (「analysis表示ON/OFFでsimが変わらない」の直接証明)
- pause/resume(150tick停止→再開)後の最終exportが連続実行と一致

## 5. 性能基準 (issue 7節)

1000tick実行後のhistory + network + statistics + JSON/CSV一式が**1回の導出で5秒未満**で
完了することをソフト上限として固定した。絶対時間を脆いunitに硬固定せず、著しい
`O(tick × agent² × render)`退化だけを落とす。ローカルでの再測定手順:

```bash
npx vitest run src/simulation/standingPartyAnalysisPhase4Verification.test.ts -t "性能スモーク"
```

## 6. component integration (issue 8節)

`standingPartyAnalysisUiIntegration.test.ts`:

- Timeline / Network / Dashboardへ共通の`selectedAgentId`/`selectedClusterId`/tick窓を渡し、
  markupに反映されること
- 3パネルSSR mount前後でanalysis/exportがbyte一致
- dashboard overviewの表示数値がexport statisticsと一致
- empty/single-nodeでも崩れたmarkupを出さない

## 7. Playwright E2E (issue 9節)

既存のPlaywright基盤(`playwright.config.ts`、port 5174)を拡張:

- `e2e/standingPartyPhase4.desktop.spec.ts` — 1440x900。standingParty直アクセス → 固定seed実行 →
  timeline / network(weight切替) / dashboard → export download → pause/resume/reset →
  scenario切替で分析UI消滅
- `e2e/standingPartyPhase4.mobile.spec.ts` — iPhone相当幅 + 320px。横スクロールなし、
  主要panel・filter・export到達性

Phase 3 E2Eと同様、URL隠しseed注入は使わずUIのSeed入力を操作する。

## 8. export検証の追加 (issue 10節)

既存`analysisExport.test.ts`に加え、決定的fixture上で:

- UI統計 = export statistics
- JSON決定的serialize
- CSV行数(空行除外) = episode件数
- presentation情報(`selectedAgentId`等)を含めない

を統合検証ファイルでも確認する。

## 9. 文書・利用上の注意 (issue 12節)

### 定義の要約(ADR準拠)

| 概念 | 意味 | 含めないもの |
| --- | --- | --- |
| Conversation episode | 1agentの1回の`joined`〜終了 | approachingのみ、forming核のみ |
| Contact interval | 2agentが同一clusterに同時`joined` | 空間近接、clique一致、trust/tie更新 |
| Contact network | contact intervalの無向集約 | 好意・信頼・人気の評価 |
| Statistics | 記述統計(分布・件数・比率) | 因果・優劣・実データ較正 |

- **active**: 観測中の未完了区間。**censored**: horizon到達などで打切り。**completed**: 終了理由付き。
  完了分布へactive/censoredを混ぜない。
- contactは**同席事実**であり、好意・信頼・人気ではない(UI disclaimer / ADR §3)。
- schema version: 分析`STANDING_PARTY_ANALYSIS_SCHEMA_VERSION = 1`、
  export`standing-party-analysis-export/1`。
- CSV列は`analysisExport.ts`の各`*ToCsv`が正本(episode / contact interval / edge /
  agent statistics / cluster statistics / transition)。

### UIの使い方

1. シナリオ選択で立食パーティーを開く
2. シミュレーションを進め、右サイドの「統計ダッシュボード」「接触ネットワーク」
   「会話履歴タイムライン」を展開
3. agent / cluster / tick filterはApp.tsxの共通stateで3画面が連携する
4. dashboardのJSON / CSVボタンで現在runをダウンロード(layout座標・DOM状態は含まない)

### Phase 5境界

話題・情報伝播・口コミ拡散を追加する際は、本分析層の履歴/contact/統計を**観測入力**として
再利用してよいが、意思決定へ循環依存させない(ADR §2.1 / §6.4と同じ境界)。

### 仮説的simulationであることの明示

本モデルは現実データによる妥当性証明前の仮説的simulationである。exportされた統計を
現場の対人関係や人気の指標として解釈してはならない。

## 受入条件チェックリスト

| 受入条件 | 状態 |
| --- | --- |
| 決定的fixtureでjoin〜contact〜離脱〜target移動〜強制release〜active打切りを再現できる | 済(本Issue) |
| history/membership/contact/network/statisticsの不変条件が自動テスト化される | 済(本Issueで横断assert追加、個別は#212〜#214) |
| event件数・IDとのcross-checkで二重計上・欠落を検出できる | 済(本Issue) |
| 同一seed/config/horizonでanalysis・exportが再現される | 済(本Issue + 既存決定性テスト) |
| 1000tick・複数seedで孤児record、重複ID、NaN、負durationが発生しない | 済(本Issue) |
| analysis表示ON/OFFでsimulation state・event列・PRNG系列が変わらない | 済(本Issue) |
| Timeline/Network/Dashboardのfilter・selectionが統合される | 済(App配線は#215〜#217、integration testは本Issue) |
| desktop/iPhone相当幅の主要flowがPlaywrightでCI実行される | 済(本Issue) |
| JSON/CSV exportがschema・escaping・UI数値との一致を自動検証される | 済(#217 + 本Issue) |
| afterParty/classroomPairおよびPhase 1〜3へ回帰がない | 済(既存テスト継続、本Issueは分析read-onlyのみ追加) |
| README・設計・検証文書が実装と一致する | 済(本文書、README追記) |
| `npm run lint` / `npm run test` / `npm run build` / `npm run typecheck:e2e` / `npm run test:e2e` が成功する | 本PRで確認 |

## 対象外・注意点(issueの記載を踏襲)

- 現実データによる妥当性証明
- 過去runのserver保存・共有
- 高度network分析(中心性の社会的価値づけ等)
- 話題・情報伝播・口コミ拡散(Phase 5)
- simulation replay / 巻き戻し
- 大規模population向けworker / GPU最適化(重大な性能問題は別Issue化)
