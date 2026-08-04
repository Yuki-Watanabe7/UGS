# standingParty Phase 3: 定性的検証・統合E2Eの構成 (Issue #203)

Parent Roadmap: #172。Depends on: #197(ドメイン契約ADR)、#198(他クラスタ関心)、
#199(愛着・離脱配慮)、#200(遷移decision)、#201(目的地付き移動)、#202(比較プリセット・UI/Inspector)。

本Issueは新しいシミュレーション挙動を追加する目的の作業ではない。#197〜#202で実装済みのstandingParty
Phase 3(他クラスタ関心・現在クラスタ愛着・ObserverJoiner葛藤・目的地付き移動)について、実データ較正前の
仮説段階のモデルであることを前提に、issueが列挙する12領域を実際にどこまで満たしているか棚卸しし、
見つかった不足分だけを追加した。`docs/standing-party-phase2-verification.md`(#190)と同じ立場を取る。

## 0. 棚卸しの結果: 大半は#198〜#202が実装と同時に満たしていた

事前の棚卸しにより、issue #203が列挙する12領域のうち次はすでに個別Issueのテストで満たされていることを
確認した(詳細な根拠は各テストファイル自体のコメントを参照、ここでは再掲しない):

- 1節(他クラスタ関心の単体テスト)・2節(愛着・離脱配慮の単体テスト)・3節(遷移decisionの性質) —
  `alternativeClusterInterest.test.ts`/`currentClusterAttachment.test.ts`/`clusterTransitionDecision.test.ts`
- 4節(決定的fixtureによる葛藤・移動flow)の大部分・9節(target失敗と会場退出の相互作用)の大部分 —
  `clusterTransitionEngine.test.ts`/`pendingClusterTransitionEngine.test.ts`
- 8節(preset間のpaired比較) — `standingPartyPhase3PresetComparison.test.ts`
- 10節(既存シナリオ・機能回帰)の大部分 — 各機能のテストファイルが個別にoff/on非干渉を確認済み
- 12節(文書)の大部分 — `docs/cluster-transition-phase3-model.md`のADR、README

見つかった不足分は次の5点であり、本Issueではこれだけを追加した(要件にない新機能・リファクタは行っていない)。

## 1. ObserverJoiner不変性テストの欠落 (issue 5節)

`isObserverJoiner`はADR 1.4節により「いかなる式にも入力されない」契約だが、これを直接検証する
テスト(「連続値を固定し、`isObserverJoiner`だけを変えても結果が変わらない」)がどこにも無かった。

`observerJoinerTransitionInvariance.test.ts`を追加し、3層で固定した:

- `deriveAlternativeClusterInterests`: 同一の連続値入力(`influenceAvoidance`等)で
  `isObserverJoiner`のtrue/falseを比較し、結果が完全一致することを確認
- `computeDepartureInhibition`: 同様に、契約上そもそも`isObserverJoiner`を入力に取らないこと自体を固定
- `standingPartyPolicy.evaluateClusterDeparture`: 同一`ClusterDepartureContext`で`agent`だけを
  差し替えて比較。`evaluateClusterDeparture(_agent, ...)`が`_agent`を一切参照しない実装であることを
  直接裏付ける

## 2. Phase 3有効プリセットでの長時間実行・pause/resumeが未検証だった (issue 6/7節)

`standingPartyLongRunStability.test.ts`(#190)は3プリセットとも`transition.enabled: false`のままで
1,000tick実行しており、`pendingClusterTransition`関連フィールド(target参照・`expiresAtTick`等)は
一度も長時間実行の対象になっていなかった。pause/resumeの再現性テストも存在しなかった。

- 個々のテストファイルが再実装しがちだった不変条件チェックを`standingPartyInvariants.ts`の
  `assertStandingPartyInvariants`へ集約(既存の`standingPartyLongRunStability.test.ts`もこれを
  使うようリファクタし、リファクタ前後で挙動が変わらないことを確認済み)。pending transitionの
  exclusivity(source/targetいずれのmemberでもない)・sourceとtargetの非同一性・
  `decidedAtTick <= tick < expiresAtTick`もここで検証する。
- `standingPartyPhase3LongRunStability.test.ts`を追加。`standing-party-outward-interest`/
  `standing-party-current-circle`(#202の比較プリセット、いずれも`transition.enabled: true`)で
  1,000tick×3seed実行し、`assertStandingPartyInvariants`に加えて「実行中に最低1回は
  `pendingClusterTransition`が観測される」ことも確認する(Phase 3の分岐を一度も踏まない空振りの
  フィクスチャにならないようにするため)。同ファイルでpause/resume(250tickで一度停止し、同じ
  `SeededRandom`インスタンス・直前stateから再開した結果が、連続500tick実行と完全一致すること)も検証する。

### 本Issueで見つけて修正したバグ: 核形成がpendingClusterTransitionを無視する孤立参照

上記のPhase 3ロングランテストの初回実行で、次の既存バグを発見した:

`engine.ts`のstep 1(核形成、`state === "undecided"`なagentが主導性またはclique readyな条件を満たすと
自発的に新しいclusterを立ち上げる)は、agentが`pendingClusterTransition`(離脱時に確定した目的地付き
移動意図)を保持しているかどうかを一切考慮していなかった。このため、離脱直後で`undecided`かつ
`pendingClusterTransition`を保持しているagentが、target(#201が意図した移動先)とは無関係な新しい
clusterを自発的に立ち上げてstate `forming`へ移ることがあった。`forming`clusterが後にconfirmedすると、
全forming memberを`joined`へ一括遷移させる既存経路(責務3相当)は`pendingClusterTransition`を一切
参照・クリアしないため、**「`joined`状態なのに`pendingClusterTransition`が残る(source/targetいずれの
memberでもないclusterへ実際には所属している)」という孤立参照**が生じていた。これはissue本文が
retrogressionの例として明示する「pending transition中に別clusterへ所属して二重membershipになる」に
該当する。

修正: step 1のループ先頭に`if (agent.pendingClusterTransition) continue;`を追加し、目的地を既に
決めているagentは自発的な核形成をスキップするようにした(ADR 1.5節「生成後は再評価しない、targetを
乗り換えない」の直接の帰結)。`pendingClusterTransition`は`formationPolicy.id === "standingParty" &&
standingPartyConfig.transition.enabled`のときにしか設定されないため、この変更はafterParty/
classroomPair、およびPhase 3無効のstandingPartyには一切影響しない(全1752件の既存テストが変更なしで
green)。回帰テストは`pendingClusterTransitionEngine.test.ts`の「核形成(step 1)との相互作用」に追加した
(`rng.chance`を常時成立させるスタブRNGで、核形成条件を満たすagentが実際に新規clusterを作らないことを
直接確認する)。

## 3. speech/trust/relationshipTieとclusterTransitionの同時有効化が未検証だった (issue 10節)

各機能領域のテストは独立にoff/on非干渉を確認していたが(`speechTrust.test.ts`/`relationshipTie.test.ts`は
afterPartyプリセットのみ、standingPartyのPhase 3テストはspeech系機能を有効化しない)、両者を**同時に**
有効化した統合実行はどこにも無かった。

`standingPartyPhase3SpeechCrossFeature.test.ts`を追加。`transition.enabled: true`のプリセット2種と
`speechEffects`/`socialExpression`/`speechTrust`/`relationshipTie`(`App.tsx`が常時ONにする4設定)を
同時有効化し、400tick×3seedで`assertStandingPartyInvariants`に加えてtie補正の値域
(`MAX_TIE_CORRECTION`/`TIE_OBSERVATION_RANGE`)・`speechEventId`の参照整合性を検証する。加えて、
同一seed・同一設定での状態系列・PRNG消費の完全再現性も確認する。

## 4. target失敗後のcooldown相互作用の一部が未検証だった (issue 4節・9節)

`pendingClusterTransitionEngine.test.ts`の既存テストはtargetFull等の無効化理由の発生自体は検証していたが、
無効化後に`REAPPROACH_COOLDOWN_TICKS`(既存の参加失敗cooldown、Issue #133)が実際に適用され、かつ
「cooldown対象外の別clusterへの探索までは止めない」こと(issue 9節が明示する非退化)は検証していなかった。

同ファイルへ2テストを追加: targetFullで無効化された際に`lastFailedCandidateId`/
`lastFailedCandidateAtTick`が既存のcapacity失敗経路と同じフィールドへ正しく設定されること、および
cooldown期間中でも(失敗した元targetを除く)別clusterへの接近は妨げられないこと。

## 5. Playwright E2E基盤が存在しなかった (issue 11節・12節)

このリポジトリには2026年時点でPlaywrightの依存自体が無く(`docs/phase4-preset-contrast-verification.md`が
記録する過去の試行はネットワーク制約で失敗している)、`.claude/skills/verify/SKILL.md`が明記するとおり
「scratchpad等への都度インストール」による手動確認のみが行われていた。本Issueで`@playwright/test`を
devDependencyとして追加し、`playwright.config.ts` + `e2e/*.spec.ts`を新設した。

- `e2e/standingPartyPhase3.desktop.spec.ts` — 1440x900。standingPartyへ直接アクセス→Phase 3 preset選択
  →詳細設定を開き境界内の値へ変更→Reset反映確認→agentインスペクターでの選択→target switch開始
  (Canvas `data-transition-role`)とinterest/attachment/decision表示の観察→pause/resume/reset→
  scenario切替でstandingParty専用パネルが消えることを確認する。
- `e2e/standingPartyPhase3.mobile.spec.ts` — iPhone 14相当(390x664)+320px幅。横スクロールなし、
  Canvas/操作/設定/Inspector/ログいずれにも到達可能、`<details>`/`<select>`/range inputの操作、
  主要ボタンのタップ領域。
- 決定論的なfixture(URLクエリ等の隠しseed注入)は存在しない(意図的 — 既存のSeed入力・詳細設定
  スライダーをユーザーと同じ経路で操作する)。その代わりswitchToTargetClusterが高確率で成立する
  方向へ詳細設定を寄せたうえで、実時間(`TICK_INTERVAL_MS=250ms`)でのpollingにより発生を待つ、
  ゆるやかな統計的フィクスチャとした。
- `data-testid`(`StandingPartyAdvancedSettings`の各入力、`ObserverJoinerInspector`のtarget選択/
  pending transition/無効化banner行)と、Canvasの`data-agent-id`/`data-candidate-id`をE2E安定性のため
  最小限追加した(既存のcomponent testはこれらの属性追加後もgreenであることを確認済み)。
- `.github/workflows/ci.yml`に`e2e`ジョブを追加(`npx playwright install --with-deps chromium` →
  `npm run test:e2e`、失敗時はPlaywright HTMLレポートをartifactへアップロード)。既存の`frontend`
  ジョブ(lint/test/build)とは独立したジョブとして並列実行される。
- `tsconfig.e2e.json`で`playwright.config.ts`/`e2e/`を独立にtypecheckする(`npm run typecheck:e2e`)。
  本体の`tsc -b`(`npm run build`)には影響しない。

### 文書の誤記修正

`CLAUDE.md`が「no DOM/component tests exist or are expected here」と記載していたが、実際には
`src/components/*.test.ts`(`renderToStaticMarkup`ベース)が既に24ファイル存在していたため、事実に
合わせて修正した。あわせて`npm run test:e2e`/`npm run typecheck:e2e`をCommands節へ追記し、
Testing conventions節にcomponent test/E2Eそれぞれの位置づけを追記した。READMEの比較プリセット説明に
preset ID(`standing-party-outward-interest`/`standing-party-current-circle`)を明記した。

## 受入条件チェックリスト

| 受入条件 | 状態 |
| --- | --- |
| 関心・愛着・配慮・遷移decisionの主要単調性・境界値が自動テスト化される | 済(#198〜#200が実装時に満たす) |
| 決定的fixtureでstay葛藤・target switch成功・target invalid fallbackを再現できる | 済(#201が実装時に満たす) |
| pending transition・membership・episode・attachment不変条件を各tickで検証できる | 済(`standingPartyInvariants.ts`へ集約、本Issueで追加) |
| 同一seed・設定・horizonでtarget selection・decision・event列を再現できる | 済(既存の各テストのreproducibility節、本Issueのpause/resumeテストで追加確認) |
| 長時間・複数seedでNaN・孤児state・重複membership・無限target retryが発生しない | 済(本Issueで発見・修正したバグを含め、Phase 3有効プリセットで確認) |
| Phase 3比較presetが固定seed集合で意図した定性的差を示す | 済(#202が実装時に満たす) |
| 外部関心上昇が会場退出増加だけへ、配慮上昇が永久固定だけへ退化しない | 済(#202の`standingPartyPhase3PresetComparison.test.ts`) |
| ObserverJoinerがboolean固定分岐ではなく連続値条件に応じてstay/switchできる | 済(本Issueで不変性テストを追加、実装は#197ADR/#198〜#200が構造的に保証) |
| target失敗後に通常探索へfallbackし、sourceへ即時振動しない | 済(#201実装時 + 本Issueのcooldown相互作用テストで追加確認) |
| afterParty/classroomPair/speech/trust/relationshipに回帰がない | 済(既存の各非干渉テスト + 本Issueのクロス機能統合テストで追加確認) |
| `StandingPartyAdvancedSettings`・Inspector・Canvasのcomponent testがある | 済(#189/#202実装時から存在。本Issueでdata-testid追加に伴う既存テストの脆い属性順依存を修正) |
| desktop・iPhone相当幅の主要flowがPlaywright等でCI実行される | 済(本Issueで新規追加) |
| README・ADR・verification文書が実装と一致する | 済(本文書、CLAUDE.md修正、README追記) |
| `npm run lint` / `npm run test` / `npm run build` / E2Eが成功する | 済 |

## 対象外・注意点(issueの記載を踏襲)

- 実データによるパラメータ推定・統計的妥当性の証明は行わない。
- 長期的な人物間好感度・接触記憶、話題・情報伝播は対象外(Phase 5以降)。
  会話履歴・接触ネットワーク・統計の分析契約は Issue #211
  ([standing-party-analysis-phase4-model.md](standing-party-analysis-phase4-model.md))、
  統合検証は Issue #218
  ([standing-party-phase4-verification.md](standing-party-phase4-verification.md))。
  ※ Roadmap #61 の speech Phase 4 とは別物。
- 会場退出・stressモデルの全面再設計は行っていない(本Issueで見つけた孤立参照バグは、上記の最小限の
  修正のみで解消した)。
- E2Eはこのリポジトリの実行環境で`npx playwright install`が可能であることを前提とする。CI環境で
  ブラウザインストールがネットワーク制約により失敗する場合は、`e2e`ジョブの失敗はブロッキングにせず
  別途調査すること(`frontend`ジョブとは独立したジョブのため、失敗してもlint/test/buildの合否には
  影響しない)。
