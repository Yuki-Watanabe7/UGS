# 会話クラスタモデルの設計方針 (Issue #173, Phase 1 spike)

Parent Roadmap: #172。Blocks: 立食パーティーシナリオの動的グループ形成実装。

この文書は、`GroupCandidate`が現在担っている「永続的・終端的な成立グループ」と、立食パーティー
シナリオが必要とする「一時的・可変的な会話クラスタ(成立後も増減・縮小・解散・再形成する単位)」の
概念境界をどう引くかの設計判断(ADR)である。**本Issueでは実装しない**(既存挙動は一切変更しない)。
後続Issueが同じ語彙・不変条件で実装できるよう、採用方針・型定義案・状態遷移・移行手順を残す。

`FormationPolicy`(Issue #130、[formation-policy-model.md](formation-policy-model.md))が確立した
「シナリオ固有ルールは`engine.ts`へ分岐を書かず、ポリシー実装を1つ追加する」という拡張パターンを、
本Issueの検討でも判断基準の軸として使う。

## 1. 現行モデルの責務棚卸し

### `GroupCandidate` / `GroupCandidateStatus`

`GroupCandidate`(`types.ts`)は「形成中の輪」と「成立済みグループ」を同じ型・同じ`status`列挙で
表す。`status`の5値(`forming` / `confirmed` / `dissolving` / `dissolved` / `expired`)のうち、
`confirmed`は二次会・教室シナリオの両方で**終端状態**として扱われている。根拠は`engine.ts`のtick
ループ内、未成立候補のライフサイクル処理の直前:

```ts
if (candidate.status === "confirmed") continue; // engine.ts 付近(候補の掃除ループ)
```

`confirmed`になった候補はその後二度と状態が変わらない。`memberIds`も、参加(join)による追加はあり得る
が(`isJoinable`は`forming`と`confirmed`の両方を対象とする)、**減ることは一切ない**(離脱経路が存在
しない)。

### `Agent.joinedGroupId` / `AgentState`

`AgentState`の`joined`は「未確定の輪への合流」と「成立済みグループへの参加」の両方を指し、
`joinedGroupId`が指す`GroupCandidate.status`で事後的に判別する(コメント参照: `types.ts`の
`AgentState`定義)。`leaving`/`left`は「グループから離れて別の輪を探す」のではなく「会場そのものから
退出する」ための状態で、CLAUDE.mdに明文化された既存ルールのとおり**stressは`undecided`の間しか
蓄積しない**。つまり一度`joined`になったエージェントには、以後の状態を変える経路が構造的に存在しない
(会場を出るための`leaving`に至る道すらない)。立食パーティーが必要とする「会話クラスタから離れて
別の会話クラスタを探す」という動きは、現行の`AgentState`の値の組にも遷移規則にも存在しない。

### `FormationPolicy`の成立・容量・解散・終了判定

8責務(`formation-policy-model.md`)はいずれも「成立に至るまで」の判定に閉じている:
候補作成・接近確率・成立判定・未成立候補の解散/期限切れ・退出可否・stress蓄積・シミュレーション終了・
容量解決・参加失敗stress。「成立**後**のクラスタの生死」を判定する責務は1つも存在しない。
`resolveGroupCapacity`はforming/confirmedを問わず容量を返せるが、参照している側(`isCandidateFull`/
`isJoinable`)は「増員」だけを制御し、「減員」を扱う経路自体がない。

### `engine.ts`の核形成・接近・合流・退出・候補掃除

tickループは概ね次の順で進む(コメント番号は`engine.ts`内の既存ステップ番号):

1. 核形成(`forming`候補の新規作成/既存候補への合流)
2. 接近判断(`undecided` → `approaching`)
3. 移動・到着による合流(`approaching` → `joined`、`candidate.memberIds`へ追加)
4. `forming`/`joined`のjitter移動
5. `undecided`の徘徊
6. (6) `undecided`のみを対象にしたstress蓄積・`leaving`判定
7. `leaving`の移動・`left`確定
8. 候補の成立判定・未成立候補のライフサイクル処理(`confirmed`はスキップ、上記参照)
9. `joinedGroupId`の整合性再検証(`nearestCandidate`除外・失敗時`undecided`へ戻す、Issue #133)

Issue #133で追加された「参加失敗による再探索」(`searchRestartCount`/`lastFailedCandidateId`)は、
**`approaching`段階で候補が消滅/満員になった場合**にのみ`undecided`へ戻す経路であり、`joined`(合流
済み)からの離脱は対象外。つまり既存の「クールダウン付き再探索」の仕組みは、立食パーティーが必要とする
「合流済みクラスタからの離脱→再探索」にほぼそのまま転用できる形をしている(合流前 vs 合流後という
違いのみ)。

### 構造化イベント、状態ログ、Inspector、Canvas、集計

- `SimulationEventType`の`groupConfirmed`/`groupDissolved`/`groupExpired`は一回限りの遷移イベントとして
  設計されており、「同じクラスタが縮小して再度confirmed相当に戻る」ような往復は想定されていない。
- `SimulationSummary.confirmedGroupCount`は「累計で何回成立したか」を意味し、「現在アクティブな
  クラスタ数」ではない。
- `ObserverJoinerInspection`/`ObserverJoinerRunSummary`の`joinedGroupId`/`joinedGroupStatus`/
  `leaveStartedTick`/`leftTick`は、一度確定したら変化しない前提で設計されている(例:
  `lateJoinSucceeded`の判定は`finalState === "joined"`を前提にした一回性の判定)。
- Canvas/凡例は`GroupCandidateStatus`の5値をそのまま色分けに使っており、「増減を繰り返すアクティブな
  クラスタ」という第6の見え方は現状表現できない。

### 学校シナリオの固定/可変定員と二次会シナリオの成立済みグループ

`classroomPair`(`createClassroomGroupPolicy`)は`confirmed`を「先生の指示に従ってペア/班が確定した」
という強い終端の意味で使っており、`canLeave`が常に`false`であることと合わせて「一度決まったら変わら
ない」という前提を二重に守っている。二次会シナリオの`confirmed`は「二次会に行くメンバーが確定した」
という別の終端概念。**両者とも「確定 = 変化しない」で一致しているからこそ、同じ`status`値を共有しても
これまで問題にならなかった**。立食パーティーの「一時的な会話クラスタ」は、この前提そのものを崩す
唯一のシナリオになる。

## 2. 設計案の比較

| 観点 | 案1: 既存`GroupCandidate`拡張 | 案2: `InteractionCluster`分離 | 案3: 共通基底+シナリオ別ライフサイクル |
| --- | --- | --- | --- |
| 型安全性・用語の明確さ | 低い。`confirmed`が「終端」と「進行中」の二重の意味を持ち、型では区別できない | 高い。型名自体が「一時的な相互作用単位」であることを表す | 中〜高。構造(型)は共有しつつ、**意味論はポリシーが持つ**ため、コード上「このシナリオでconfirmedが終端かどうか」を問い合わせる形になり、型だけを見て誤読するリスクは残るが局所化できる |
| `engine.ts`のscenario分岐量 | 増える方向のリスクが高い。「confirmed後も動かす」ために`if (formationScenarioId === "standingParty")`のような分岐を足したくなる誘惑が強い(Issue #130が排除した分岐が復活しかねない) | 増えない。ループ自体を型ごとに分離すれば分岐は不要だが、そのために**ループの二重化**が必要 | 増えない。既存の`FormationPolicy`責務(8個)に**新しい責務を追加**するだけで、`engine.ts`は変わらずポリシー呼び出しのみ行う(Issue #130〜#157で実証済みのパターンをそのまま延長) |
| membership整合性の保証しやすさ | 現状維持(join/leaveの原子性は呼び出し側の規律に依存、これは案によらず共通の課題) | 型が分かれても整合性保証の仕組み自体は変わらない(むしろ2つの型の同期が新たな整合性問題になり得る) | 既存パターンと同じ。共通ヘルパー関数化(3節で後述)により案1と同等以上に保証しやすい |
| 既存テスト・UI・集計への影響 | 最小。`GroupCandidateStatus`/`joinedGroupId`はそのまま。`classroomPairInvariants.test.ts`等の前提を壊さない | 甚大。`SimulationCanvas`/`EventLog`/`Inspector`/`monteCarlo.ts`/`summary.ts`/`assignmentOrigin.ts`など`GroupCandidate`を読む全消費者に、新型への対応かアダプタ層が必要 | 最小。型はGroupCandidateのまま(構造体としての形は変えない)ため、既存消費者は無改修で動く。新しいライフサイクル分岐は「新シナリオを選んだときだけ」発現する |
| 接触履歴・情報伝播・話題モデルへの拡張性 | 弱い。「現在の所属」と「過去の所属履歴」を同じフィールドで表現しがちになる | 強い。新型なので設計時点で履歴用フィールドを分離しやすい | 強い。`speechLog`(Phase 2)が確立した「現在状態を汚さない、生成専用の時系列ログを別途持つ」パターンをそのまま流用できる(4節で後述) |
| 段階的移行の容易さ | 容易(型変更なし)だが、**確定後も変化するクラスタ**を表現するには結局`status`の意味を割ったポリシー分岐が要るため、実質的に案3へ収束する | 困難。本Issueの対象外である「大規模な型置換」に該当する | 容易。`FormationPolicy`への責務追加は`classroomPair`(#132)や可変定員化(#154)で既に3回実施されており、追加コストが実績として見積もれる |

### 却下理由

- **案1(既存拡張のみ)を単独では採用しない**: `confirmed`に「終端」(afterParty/classroomPair)と
  「進行中」(standingParty)という相反する意味を持たせたまま`engine.ts`側で吸収しようとすると、
  結局`formationScenarioId`や`status`を見た条件分岐が`engine.ts`に生えてくる。これはIssue #130が
  明示的に排除した「engine内のシナリオ分岐」を再導入することになり、本Issueの背景で名指しされている
  「`confirmed`、`joinedGroupId`、`leaving`等の意味が混在する」問題をそのまま温存する。
- **案2(型分離)を単独では採用しない**: 型として最もクリーンだが、`engine.ts`の核形成→接近→合流→
  stress→掃除という一連のtickループ(現状500行超)を2つの型に対して二重化するか、両者を相互変換する
  アダプタ層が必要になる。UI(`SimulationCanvas`/`AgentLegend`/`EventLog`)・集計(`summary.ts`/
  `monteCarlo.ts`/`assignmentOrigin.ts`)・Inspector(`inspection.ts`)まで含めた消費者の数を考えると、
  これは受入条件が明示的に対象外とする「大規模な型置換・全面リファクタリング」に該当する。

## 3. 採用方針: 案3(共通基底 + シナリオ別ライフサイクル)

**型としての`GroupCandidate`は変更しない(少なくとも本Issueでは)。ライフサイクルの意味論を
`FormationPolicy`の新しい責務として切り出し、シナリオごとに委譲する。**

具体的には、`FormationPolicy`の既存8責務(責務1〜8)に加えて、次の2つの新責務を追加する
(後続Issueで実装、本Issueでは型シグネチャ案のみ提示):

- **責務9: 成立後のクラスタ離脱判定** (仮称`evaluateClusterDeparture`)
  `joined`なエージェントが、そのクラスタから離れて`undecided`へ戻り再探索してよいかを判定する。
  `afterParty`/`classroomPair`は常に「離脱なし」を返すことで、既存挙動を完全に維持する
  (既存の`classroomPairInvariants.test.ts`等が無改修で通ることが、この責務が既存挙動に影響しない
  ことの回帰確認になる)。
- **責務10: 確定後ライフサイクルの継続可否** (仮称`resolvePostConfirmationLifecycle`)
  `engine.ts`の`if (candidate.status === "confirmed") continue;`を置き換える。`afterParty`/
  `classroomPair`は「常にcontinue(何もしない)」を返し、standingPartyは人数減少・最小人数割れ・
  0人化を判定して`dissolving`/`dissolved`への遷移を返す。

この2責務により、`engine.ts`は**シナリオを問わず同じコード**のまま、「合流後は何も変わらない
シナリオ」と「合流後も増減するシナリオ」の両方を表現できる。`formation-policy-model.md`が示す
「新シナリオはFormationPolicy実装を1つ追加するだけで済む」という既存パターンの単純な延長であり、
`classroomPair`(#132)・可変定員化(#154)・学校向け介入(#156/#157)が繰り返し実証してきた拡張経路と
同じである。

`GroupCandidate`という型名は「候補」であることを強調しすぎており、成立後も変化するクラスタの説明には
やや不適切だが、**改名(`InteractionCluster`等へのリネーム)は型の意味論変更を伴わない純粋な名称変更
として、影響範囲が確定した後続Issueで独立に検討する**(本Issueでは決定しない。3.4節参照)。

### 3.1 型定義案

```ts
// formationPolicy.ts への追加案(本Issueでは型シグネチャのみ提示、実装しない)

/** 責務9: 合流済みエージェントがクラスタを離れて再探索してよいかの判定結果 */
export type ClusterDepartureDecision = {
  /** このtickでクラスタを離れるか(rng判定の対象になるかどうか) */
  eligible: boolean;
  /** eligibleな場合の離脱確率 */
  probability: number;
};

export interface FormationPolicy {
  // ...既存責務1〜8は変更しない...

  /**
   * 責務9(新規): 合流済み(state === "joined")のエージェントが、このクラスタから離れて
   * undecidedへ戻り再探索してよいかを判定する。afterParty/classroomPairは常に
   * { eligible: false, probability: 0 } を返し、既存挙動を変えない。
   */
  evaluateClusterDeparture(
    agent: Agent,
    candidate: GroupCandidate,
    ctx: ClusterDepartureContext,
  ): ClusterDepartureDecision;

  /**
   * 責務10(新規): confirmed状態の候補が、その後も人数変化やライフサイクル遷移の対象で
   * あり続けるか。afterParty/classroomPairは常にfalse(現行の`continue`と等価)を返す。
   */
  readonly confirmedClusterIsMutable: boolean;

  /**
   * 責務10(新規): confirmedClusterIsMutableがtrueの場合のみ呼ばれる。人数減少後の
   * dissolving/dissolved判定を、責務3の未成立候補向けライフサイクル判定と同じ形で返す。
   */
  evaluatePostConfirmationLifecycle(
    candidate: GroupCandidate,
    ctx: UnconfirmedCandidateLifecycleContext,
  ): UnconfirmedCandidateLifecycleOutcome;
}
```

`GroupCandidate`自体への型追加は最小限に留める(構造上の必要が生じた場合のみ):

```ts
// types.ts への追加候補(本Issueでは決定しない、後続Issueで要否を再判断する)
export type GroupCandidate = {
  // ...既存フィールドは変更なし...

  /**
   * (検討中) このクラスタが過去に一度でもminGroupSizeへ到達したことがあるか。
   * standingPartyの「一度confirmed相当になった後、人数が割れても`forming`には戻さず
   * `dissolving`へ向かわせる」判定に使う候補。既存の`status`だけで表現できないか
   * (例: confirmedのまま人数だけ変動させ、statusをdissolvingへ進めるのはmemberIds減少時のみ)
   * を後続Issueでまず検証すること。
   */
  everConfirmed?: boolean;
};
```

### 3.2 状態遷移表(standingParty想定、後続Issueでの実装対象)

| 現在の状態 | イベント | 次の状態 | 備考 |
| --- | --- | --- | --- |
| `forming` | `computeConfirmationCount >= minGroupSize` | `confirmed` | 既存(責務3) |
| `forming` | 反応薄+`weakResponseAge`超過 | `dissolving` | 既存(責務3) |
| `forming` | `maxAge`超過 | `expired` | 既存(責務3) |
| `confirmed` | 新規agentが合流(容量に空きあり) | `confirmed`(継続) | 既存(責務6/`isJoinable`、変更なし) |
| `confirmed` | 責務9によりmemberが離脱、`memberIds.length >= minGroupSize`のまま | `confirmed`(継続) | **新規**。人数が減っても最小人数以上なら継続 |
| `confirmed` | 責務9によりmemberが離脱、`memberIds.length < minGroupSize` | `dissolving` | **新規**。責務10の`evaluatePostConfirmationLifecycle` |
| `confirmed` | `memberIds.length === 0` | `dissolved` | **新規**。空クラスタは即終端(猶予なし) |
| `dissolving` | 猶予tick内に新規合流で`minGroupSize`回復 | `confirmed` | **新規**(再形成)。3.3節の「IDを維持する条件」参照 |
| `dissolving` | 猶予tick超過、または`memberIds.length === 0` | `dissolved` | 既存の`dissolving`→`dissolved`遷移(掃除タイミング)を流用 |
| `joined`(agent側) | 責務9で離脱判定 | `undecided` | **新規**。Issue #133の再探索クールダウン機構(`lastFailedCandidateId`等)を合流後離脱にも転用する案(3.4節) |

### 3.3 必須意味論・不変条件

1. **1エージェントが同時に所属できる会話クラスタ数: 1**。`Agent.joinedGroupId`は単一の
   `string | undefined`のまま変更しない。複数クラスタに同時に「片足を置く」ような表現は本Issueの
   対象外とし、必要になった時点で独立した不変条件の再検討として扱う(既存の全消費者コードが単一
   membership前提であるため、複数化は事実上の全面改修になる)。
2. **join/leave時のagent側・cluster側の原子的更新**: 現状も`agent.joinedGroupId = candidate.id`と
   `candidate.memberIds`への追加は同一ループ内で隣接して実行されているが、共有ヘルパー関数として
   明文化されていない。後続Issueで`assignAgentToCandidate`/`detachAgentFromCandidate`のような
   共通関数へ揃え、新設する責務9由来の離脱パスも同じ関数を通す(既存の合流パスと離脱パスが同じ
   原子性を持つことを保証する)。
3. **`forming`/`confirmed`/`dissolving`/`dissolved`/`expired`の意味**: `status`列挙自体は追加しない
   (5値のまま)。`confirmed`が「終端」か「継続する」かは`FormationPolicy.confirmedClusterIsMutable`
   が決め、`engine.ts`・型定義には一切ハードコードしない。`expired`は「一度もconfirmedに到達しない
   まま時間切れ」を表す既存の意味を維持し、confirmed後の人数割れには使わない(`dissolving`/
   `dissolved`のみを使う)。
4. **成立後の人数増減・最小人数未満・最後の1人・空クラスタ**: 3.2節の状態遷移表のとおり。
   「最後の1人」を特別扱いする専用状態は設けず、「`minGroupSize`未満」の一般ルールに合流させる
   (`minGroupSize`が2なら1人はすでにこのルールに含まれる)。空(0人)は猶予なしで即`dissolved`。
5. **クラスタIDを維持する条件/新規クラスタとして再生成する条件**: `memberIds.length > 0`である限り
   同一IDを維持する(縮小・再形成を繰り返しても、途中で0人にならなければIDは変わらない)。新規IDが
   発行されるのは、(a) 既存クラスタが`dissolved`/`expired`になった後で新しい核形成が起きた場合、
   (b) 誰も所属していない状態から新規founderが現れた場合のみ。1つのクラスタが2つに分裂する
   (スプリット)動きは本Issueの対象外とし、既存の`candidateMergeRadius`による近接マージ判定は
   変更しない。
6. **「会話クラスタから離脱」と「会場自体から退出」の区別**: 前者は責務9(`joined` → `undecided`、
   再探索プールに戻る)、後者は既存の責務4(`undecided` → `leaving` → `left`、会場からの退出)。
   両者は独立した2段階の遷移として合成され、「クラスタを離れてすぐ会場も出る」という動きは
   「クラスタ離脱→(undecidedとしてstress蓄積を再開)→一定確率でleaving」という**既存の仕組みの
   組み合わせ**でそのまま表現できる(CLAUDE.mdに明文化された「stressはundecidedの間のみ蓄積する」
   ルールと自然に整合する)。新しい第3の状態を`AgentState`へ追加する必要はない。
7. **過去所属・接触履歴を現状態から分離して保持する方針**: `joinedGroupId`/`memberIds`を履歴で
   汚さない。Phase 2の`speech.ts`が確立した「生成専用・意思決定には一切使わない時系列ログを
   `SimulationState`へ追加する」パターン(`speechLog`)をそのまま踏襲し、`ClusterMembershipEvent`
   (`{ agentId, clusterId, tick, kind: "joined" | "departed" }`)のような追記専用ログを新設する案を
   後続Issue(情報伝播・接触ネットワーク)向けに残す。**本Issueではこのログ自体を実装しない**
   (対象外: 情報伝播・接触ネットワークの本実装)。

### 3.4 未決定事項として後続Issueへ引き継ぐ論点

- `everConfirmed`のような追加フィールドが本当に必要か、それとも`status`と`memberIds.length`の組み
  合わせだけで表現しきれるかは、責務9/10の実装(follow-up A/B、下記4節)で最初に検証する。
- Issue #133の「参加失敗による再探索」(`searchRestartCount`/`lastFailedCandidateId`/クールダウン
  判定)は「合流前」の失敗を前提に設計されている。責務9の「合流後離脱」に同じフィールド・同じ
  クールダウン機構を転用してよいか、専用のカウンタ(`clusterDepartureCount`等)を新設すべきかは
  follow-up Aで判断する。
- `GroupCandidate`の改名(`InteractionCluster`等)は、責務9/10の実装で「型としての`GroupCandidate`
  のままで表現しきれる」ことが確認できた場合は行わない。もし実装過程で型の意味論的な無理が判明した
  場合のみ、影響範囲(3.1節の消費者一覧)を再調査したうえで、名称変更のみを行う独立Issueとして
  切り出す(型の構造・フィールドは変えず、識別子だけを変える変更に限定する)。

## 4. 成果物と移行順序

### 採用方針(要約)

`GroupCandidate`型は維持し、`FormationPolicy`(Issue #130の拡張点)に責務9(クラスタ離脱判定)・
責務10(確定後ライフサイクル継続可否)を追加する。`engine.ts`のシナリオ分岐は増やさない。
`afterParty`/`classroomPair`は両責務とも「既存挙動を変えない」値を返すことで後方互換を保つ。

### 後続Issueへの分解(依存関係順)

1. **Follow-up A: 責務9(クラスタ離脱判定)の型・engineへの結線**
   `FormationPolicy`インターフェースへ`evaluateClusterDeparture`を追加し、`engine.ts`のtickループ
   (step 4「joined jitter」の直後が候補)へ呼び出しを挿入する。`afterParty`/`classroomPair`は
   常に離脱なしを返す実装のみ追加し、`afterPartyRegression.test.ts`/`classroomPairInvariants.test.ts`
   が無改修で通ることを回帰確認とする。
2. **Follow-up B: 責務10(確定後ライフサイクル)の型・engineへの結線**
   `confirmedClusterIsMutable`/`evaluatePostConfirmationLifecycle`を追加し、`engine.ts`の
   `if (candidate.status === "confirmed") continue;`をポリシー呼び出しに置き換える。
   `afterParty`/`classroomPair`は`confirmedClusterIsMutable: false`で、既存の`continue`と
   byte-identicalな挙動になることを確認する(依存: A不要、Bのみ独立して着手可能)。
3. **Follow-up C: `standingPartyPolicy`(新`FormationScenarioId`)の実装**
   A・B完了後、3.2節の状態遷移表を実装する新しい`FormationPolicy`。`presets.ts`への新プリセット
   追加、`scenarioPresentation.ts`への語彙追加(`scenario-presentation-boundary.md`のパターンに
   従う)を含む。依存: A, B。
4. **Follow-up D: `ClusterMembershipEvent`(接触履歴ログ)**
   3.3節7の追記専用ログ。情報伝播・接触ネットワークのモデル化に着手する段階で必要になるため、
   C完了後、実際にその要求が具体化してから着手する(先行実装しない)。

### 既存シナリオへの影響範囲

Follow-up A/Bはいずれも`FormationPolicy`インターフェースへのメソッド追加のみで、`afterParty`/
`classroomPair`向けの値は「既存の`continue`/`false`と等価」に固定するため、**型シグネチャの追加を
除き、`afterParty`/`classroomPair`の実行時挙動・PRNG消費順序は一切変わらない**。これは
`formationPolicy.ts`が既に3回(Issue #132/#154/#157)実証している「新しい責務・新しいシナリオを
追加しても既存シナリオはbyte-identicalに保たれる」設計方針の延長であり、新規性はない。

### 後続Issueが守るべき不変条件・回帰テスト一覧

- 1エージェント1クラスタ(3.3節1)。
- join/leaveの原子性(3.3節2、共有ヘルパー関数経由)。
- `confirmed`の意味は`FormationPolicy`が決め、`engine.ts`・型コメントにシナリオ名をハードコード
  しない(3.3節3)。
- 「クラスタ離脱」と「会場退出」は別の遷移として合成する。新しい`AgentState`値を追加しない
  (3.3節6)。
- 履歴は現状態(`joinedGroupId`/`memberIds`)を汚さず、別ログに分離する(3.3節7)。
- 回帰テスト: `afterPartyRegression.test.ts`・`classroomPairInvariants.test.ts`・
  `joinedGroupIntegrity.test.ts`・`nonInterference.test.ts`が、Follow-up A/B適用後も無改修のまま
  通過すること。新シナリオ(Follow-up C)には、`classroomPairInvariants.test.ts`と同じパターン
  (複数seed × 複数人数での不変条件チェック、容量境界、同一tick競合)に加え、「縮小→最小人数割れ→
  再形成」「0人化→dissolved」「合流後離脱→再探索→別クラスタへ合流」の3系列を新規に追加する。
