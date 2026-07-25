# standingParty Phase 2: 定性的検証・統合回帰テストの構成 (Issue #190)

Parent Roadmap: #172。Depends on: #185(会話満足度・離脱の設計ADR)、#186(会話エピソード)、
#187(会話満足度の実装)、#188(離脱decisionの実装)、#189(比較プリセット・設定UI・Inspector表示)。

本Issueは新しいシミュレーション挙動を追加しない。#185〜#189で実装済みのstandingParty Phase 2
(会話満足度・会話エピソード・離脱decision・比較プリセット)について、実データ較正前の仮説段階の
モデルであることを前提に、**単調性・再現性・不変条件・プリセット間の定性的差**を自動テストで
固定するための、追加のテスト層とその設計判断を記録する。個別の数式・境界値の単体テスト自体は
すでに`conversationSatisfaction.test.ts`/`clusterDepartureDecision.test.ts`/`conversationEpisode.test.ts`
が広くカバーしている(#187/#188/#186)。本Issueで追加したのは、それらを**実際に動くシミュレーション
として組み合わせたときの集計・相互作用**の検証である。

## 1. プリセット間の定性的比較 (`standingPartyComparison.ts`)

`src/simulation/standingPartyComparison.ts`は、`state.log`の構造化イベントと`state.agents`だけから
1run分の比較指標(`StandingPartyRunSummary`)を導出する純粋関数群。既存の`pairFormation.ts`
(Issue #136)と同じ設計方針。

集計する指標:

| 指標 | 由来イベント/フィールド | 備考 |
| --- | --- | --- |
| `voluntaryDepartureCount`(agent別) | `clusterDepartureCompleted` | 責務9由来の自発的離脱のみ |
| `forcedReleaseCount`(agent別) | `clusterMemberReleased` | 責務10由来の強制release。自発離脱には**含めない** |
| `rejoinCount`(agent別) | `clusterRejoined` | 離脱後の再参加回数 |
| `distinctClusterCount`(agent別) | `nucleusCreated`/`agentJoined`/`observerJoinedForming`/`observerJoinedConfirmed`/`clusterRejoined`のgroupId | 重複を除くcluster数 |
| `episodeDwellSamples` | `clusterDepartureCompleted`/`clusterMemberReleased`の`ticksInCluster` | 完了した会話エピソード1件ごとの滞在tick(voluntary/forced両方) |
| `clusterDissolutionCount` | `activeClusterDissolved` | 重複を除くcluster数 |
| `venueExitCount` | `state.agents`のうち`state === "left"` | 会場退出人数 |
| `departureReasonCounts` | `clusterDepartureCompleted`の`departureReason` | 自発離脱の主要因別件数(強制releaseの`"clusterBelowMinimumSize"`は含めない) |

`summarizeStandingPartyRuns`は、これらを複数run(=固定seed列)にわたって平均する。

`forcedReleaseCount`と`voluntaryDepartureCount`を独立フィールドに分離しているのは、issue #190
6節の要求「cluster解散による強制releaseを自発的回遊として集計しない」に対応するため。
`engine.ts`の`departFromCluster`は責務9(自発)・責務10(強制release)の双方から呼ばれ、
`Agent.clusterDepartureCount`はその合算値であるため、正確な内訳が必要な集計はログの
`eventType`から再構成する(`clusterDepartureCompleted` = 自発、`clusterMemberReleased` = 強制)。

### 強制release由来episodeの滞在tick (`clusterMemberReleased.ticksInCluster`)

本Issueで`engine.ts`の`releaseMemberFromDissolvingCluster`に`ticksInCluster`メタデータを追加した
(既存の`clusterDepartureStarted`/`Completed`と同じフィールド名)。これにより「完了したepisodeの
滞在tick」の集計が、離脱経路(自発/強制)を問わず可能になる。シミュレーションの意思決定・確率・
PRNG消費順序には一切影響しない、観察用メタデータの追加のみ。

## 2. 比較プリセットのpaired比較テスト (`standingPartyPresetComparison.test.ts`)

標準・ネットワーキング型・懇親型(#189)を、同一seed列(`BASE_SEED`起点の15seed)・同一population
(`populationSize: 24`)・同一horizon(500tick)で実行し、`standingPartyComparison.ts`の集計値を
比較する。単一seedでは責務9の確率的な離脱判定の結果が揺れるため、複数seedにわたる平均値で
方向性を確認する(統計的有意差の証明ではない)。

検証している方向性(issue #190 5節):

- ネットワーキング型は懇親型より、agentあたりの自発cluster離脱回数・再参加回数・異なるcluster参加数が多い
- 懇親型はネットワーキング型より、完了episodeの代表滞在tick(平均・中央値)が長い
- 標準ケースの代表滞在tickは、両プリセットの間に収まる(満足度減衰を遅くしても代表滞在時間が
  短くならない、という単調な方向性の確認)
- 回遊傾向を上げても、会場退出人数はプリセット間でほぼ変わらない(再参加数だけが大きく動く)。
  会話満足度・社交的回遊傾向は責務9(cluster離脱)にのみ効き、責務4(会場退出、`leaveThreshold`
  判定・既存stressモデル)へは接続しない(`docs/conversation-satisfaction-model.md` 2.1節)ため、
  この非退化は設計上期待される性質であり、テストはそれを直接確認する

`SEED_COUNT=15`・`TICKS=500`は経験的な値であり、特定の数値そのものを現実の予測として主張する
ものではない(issue #190「対象外」節)。

## 3. cluster離脱と会場退出の相互作用 (`clusterDepartureVenueExitInteraction.test.ts`)

issue #190 6/7節に対応する、複数seed・複数プリセットにわたる相互作用の検証:

- **離脱直後の即時venue exitを強制しない**: `clusterDepartureCompleted`の同一tickで
  `state === "leaving"/"left"`になる割合が低い(閾値5%未満)ことを確認する。責務9の
  `departFromCluster`(undecidedへ戻す)と責務7のstress蓄積/`canLeave`判定は同一tick内で
  順に実行されるため理論上0%を保証できないが(離脱直前の残存stressが既に高い極端なケース)、
  「離脱すればほぼ必ず帰宅する」という退化になっていないことを確認する。
- **再接近cooldown中の他clusterへの接近**: `CLUSTER_REJOIN_COOLDOWN_TICKS`(離脱元clusterのみを
  対象とする、`engine.ts`の`cooldownExcludeIds`)未満で、離脱元とは異なるclusterへの
  `clusterRejoined`が実際に発生することを実測で確認する。
- **強制releaseと自発離脱の分離**: 実際のシミュレーション実行でも
  `StandingPartyRunSummary.forcedReleaseCount`/`voluntaryDepartureCount`が正しく分離されることを確認する。
- **会場退出後のmembership非保持**: `state === "left"`のagentは`currentEpisode`/`joinedGroupId`/
  `clusterJoinedAtTick`を保持せず、いずれの`GroupCandidate.memberIds`にも含まれない。

## 4. 長時間実行の安定性 (`standingPartyLongRunStability.test.ts`)

3プリセット×3seed×1,000tickで、毎tick次を検証する: NaN/Infinityが`x`/`y`/`stress`/
`socialCirculationTendency`/`conversationSatisfaction`に生じない、`currentEpisode`を持つのは
`joined`かつ有効なclusterに所属するagentだけである(孤児episodeがない)、
1clusterあたりのmemberIdsに重複がない、1agentが同時に複数clusterへ所属しない、
一度成立(confirmed)したclusterが0人のまま無期限にconfirmedへ残留しない。

### 本Issueで見つけて修正したバグ: 空confirmedクラスタの無期限残留

この長時間実行テストの初回実行で、次の既存バグを発見した:

`engine.ts`の責務3(近接ヒューリスティックによる会話成立判定)は、実際の`memberIds.length`が
`groupConfirmSize`未満のまま`confirmed`へ遷移させることがある(`GroupCandidate.everConfirmed`が
立たないまま)。この状態で唯一(または少数)のmemberが責務9で自発離脱すると、`memberIds.length`が
0になる。修正前の責務10ループは`if (!candidate.everConfirmed) continue;`としており、
`everConfirmed`が一度も立っていないcandidateの後始末を一切行わなかったため、
**誰も所属していない`"confirmed"`のcandidateが`groupCandidates`に無期限に残留していた**
(空clusterの残留)。

修正: `everConfirmed`が立っていない`confirmed`のcandidateが0人になった時点で、既存の
`memberCountBefore === 0`分岐と同じ表現(`activeClusterDissolved`イベント)で即座に`dissolved`へ
遷移させる。`confirmedClusterIsMutable`なポリシー(standingPartyのみ)にしか影響せず、
afterParty/classroomPairの既存挙動・stress/離脱確率の計算式には一切触れていない。

## 5. resetの不変条件 (`conversationEpisode.test.ts`)

前run(#189のUIでいう「Reset前」の状態)で会話エピソード・離脱回数が蓄積していても、
`createInitialState`を呼び直す(`App.tsx`の`resetSimulation`と同じ経路)と、新runのagentには
`currentEpisode`/`clusterJoinedAtTick`/`clusterDepartureCount`/`lastDepartedClusterId`のいずれも
残らないことを確認する。`createInitialState`は前stateを一切参照せずagentを新規生成する設計のため、
この不変条件は構造的に保証されているが、将来の変更で意図せず崩れないよう回帰テストとして固定する。

## Inspector表示・設定UIの使い方

`docs/conversation-satisfaction-model.md`(モデルの数理)と、README「設定・比較プリセット・
Inspector表示(#189、Phase 2の露出)」節(UIの使い方・詳細設定パネル・agentインスペクターの
表示項目)を参照。本Issueはこれらの表示内容自体には変更を加えていない。

## 対象外・注意点(issueの記載を踏襲)

- 実データによるパラメータ推定・統計的妥当性の証明は行わない。上記のpaired比較は「意図した方向の
  差が固定seed列で観察できる」ことのみを確認する。
- 会話満足度・社交的回遊傾向は性格診断・現実の心理測定ではない(`docs/conversation-satisfaction-model.md`
  7節)。
- 他cluster興味・ObserverJoinerの遠慮/葛藤・話題の伝播は未実装であり、本Issueのテストも対象としない。
- UI受入(Playwright等によるレスポンシブ確認、`StandingPartyAdvancedSettings.tsx`のコンポーネント
  テスト)は本Issueのスコープに含めていない。リポジトリに既存のe2eテスト基盤がなく、別途整備が
  必要なため。
