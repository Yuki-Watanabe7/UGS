# シナリオ別表示語彙と内部モデルの境界

## 目的

UGSは、二次会のグループ形成と教室のペア形成で同じ内部モデルの多くを共有する。一方、画面上で
`groupConfirmSize`や`observerJoiner`といった内部識別子をそのまま説明に使うと、利用者が別場面の意味で
状態を解釈してしまう。この文書は、シミュレーションの状態・イベントと、シナリオ別の表示語彙の境界を
定める。

## 責務の分離

| 層 | 主な責務 | シナリオ別文言を持つか |
| --- | --- | --- |
| `simulation/*` | 状態遷移、確率、構造化イベント、集計値、PRNG消費 | 原則として持たない。既存ログの`message`は後方互換の記録として残す |
| `presentation/scenarioPresentation.ts` | 操作項目、発言、心の声、状態名、Canvas、凡例、集計、介入可否の表示契約 | 持つ |
| `components/*` / `hooks/*` | presentation設定を受け取り、構造化データを画面へ描画する | 独自のシナリオ語彙を増やさない |

`FormationScenarioId`は形成・終了ルールを選ぶ内部軸であると同時に、対応するpresentation設定を引くキーに
使う。ただしpresentation側は表示を解決するだけで、`SimulationState`、`Agent`、乱数生成器を変更しない。

## 表示設定に集約する項目

`ScenarioPresentation`は少なくとも次を管理する。

- パラメータのラベル、説明、表示可否、編集可否
- 利用できる介入IDと介入UIの表示可否
- `SpeechReason`ごとの通常発言
- `ExpressionReason`ごとの心の声
- 本心と建前が乖離する場面の対になった文言
- Agent状態、Canvas候補、ARIA、凡例のラベル
- 終了サマリー、Monte Carlo、発言効果dimensionのラベルと表示可否
- 状態ログフィルターと、構造化`LogEntry`から解決するユーザー向け文言

学校シナリオではペア人数を2人固定の読み取り専用表示とし、成立済みペアへの後乗り、教室からの退出、
二次会向け介入の操作項目は表示しない。非表示にしても`SimParams`の内部キーや値は削除しない。

## テンプレート解決と非干渉性

発言・心の声・乖離文言の解決関数は、表示コンテキストとして`FormationScenarioId`を明示的に受け取る。
省略時は既存呼び出し元との後方互換のため`afterParty`表示へフォールバックする。

文言バリエーションの選択は既存どおり表示専用の決定的ハッシュを使い、本体`SeededRandom`を消費しない。
同じ構造化イベントを学校語彙で表示しても、状態系列、イベント属性、PRNG消費、集計値は変わらない。

## 状態ログ

`LogEntry.eventType`と`metadata`があるイベントは、`resolveScenarioLogMessage`が表示時に文章へ変換する。
保存済みの`LogEntry.message`は変更しないため、既存のスナップショットと集計境界を維持できる。未知または
未構造化のイベントは元の`message`へフォールバックする。新しいユーザー向けイベントを追加するときは、
学校表示へ到達し得る場合に構造化イベントを付け、同じresolverへ表示契約を追加する。

## 介入と比較UI

利用可能な介入は`availableInterventionIds`から解決する。学校向け介入が未実装の現在は`["none"]`のみで、
セレクターと介入比較パネルを表示しない。UIから不正な介入IDが渡された場合も
`normalizeInterventionForPresentation`が`none`へ正規化し、Reset、Step、連続実行、Monte Carloへ同じ値を渡す。
将来教師介入を追加するときは、内部介入ロジックを実装したうえで学校presentationの許可リストへ追加する。

## 回帰監査

`scenarioPresentation.test.ts`は学校ルートの静的レンダリングに対して、二次会固有語の禁止語監査を行う。
同じテスト群で、全`SpeechReason`・`ExpressionReason`の学校文言、固定/非表示パラメータ、介入の正規化、
構造化ログのシナリオ別解決も確認する。二次会ルートについては既存文言と介入UIが維持されることを併せて
確認する。
