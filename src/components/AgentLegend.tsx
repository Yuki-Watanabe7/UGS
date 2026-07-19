const ITEMS: Array<{ color: string; label: string }> = [
  { color: "#9ca3af", label: "gray: 未定 / 締切時点で未割当" },
  { color: "#3b82f6", label: "blue: 二次会に向かう意思が強まりつつある" },
  { color: "#22c55e", label: "green: 輪/グループに合流済み(形成中の輪 or 成立済みグループ)" },
  { color: "#ef4444", label: "red: 帰宅方向" },
  { color: "#a855f7", label: "purple: 主導者・核を作っている人" },
  { color: "#f97316", label: "orange: observerJoiner型(注目対象)" },
];

export function AgentLegend() {
  return (
    <div className="panel legend">
      <h2>凡例</h2>
      <ul>
        {ITEMS.map((item) => (
          <li key={item.label}>
            <span className="dot" style={{ backgroundColor: item.color }} />
            {item.label}
          </li>
        ))}
      </ul>
      <p className="legend-note">
        円が大きいほど主導性が高い人です。オレンジの太枠は observerJoiner
        型(行きたいが自分の意思で場を動かしたくない人)を示します。
      </p>
    </div>
  );
}
