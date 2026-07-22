import type { GroupCapacity } from "./formationPolicy";

/**
 * Issue #159: `teacher-deadline-assignment`(締切時の教師強制割当)/`random-assignment-baseline`
 * (seed付きランダム割当比較基準)が共通で使う、容量制約(`GroupCapacity`)内で人口を過不足なく
 * 班へ分割する純粋関数群。`formationPolicy.ts`の`computeStructuralUnassignedFloor`(構造的に
 * どうしても割当不可能な最小人数を求めるDP)と同じ考え方を、実際の班サイズ列の復元にまで拡張する。
 *
 * 固定定員(`minGroupSize === maxGroupSize`)では、割り切れない余りを暗黙に小さい班へ変更したり
 * 班数を水増ししたりしない(受入条件: 固定4人班で10人を3・3・4へ変更しない)。可変定員では、
 * 割当可能な最大人数を過不足なく班へ分割する(受入条件: 3〜4人可変定員で分割可能な人口を全員割当できる)。
 */

export type GroupSizePlan = {
  /** 作成する班それぞれの人数(定員内、人数の多い班から決定的に並ぶ) */
  groupSizes: number[];
  /** どうしても班に組み込めない構造的な余り人数 */
  unassignedCount: number;
};

/**
 * `populationSize`人を`capacity`(min/max)の範囲内で班へ分割する計画を立てる(rng不使用、決定的)。
 * `capacity.maxGroupSize`が無制限(`Number.POSITIVE_INFINITY`)の場合は、`minGroupSize`以上いれば
 * 1班にまとめる(二次会シナリオ相当。この関数は主に学校シナリオでの容量制約付き分割を想定するが、
 * 呼び出し側の前提を狭めないためここでも扱っておく)。
 */
export function planGroupSizes(populationSize: number, capacity: GroupCapacity): GroupSizePlan {
  if (populationSize <= 0) return { groupSizes: [], unassignedCount: 0 };

  const { minGroupSize, maxGroupSize } = capacity;

  if (!Number.isFinite(maxGroupSize)) {
    return populationSize >= minGroupSize
      ? { groupSizes: [populationSize], unassignedCount: 0 }
      : { groupSizes: [], unassignedCount: populationSize };
  }

  // reachable[n] = ちょうどn人を、min..maxの班だけで(0個以上)過不足なく分割できるか
  // (`computeStructuralUnassignedFloor`と同じDP)
  const reachable = new Array<boolean>(populationSize + 1).fill(false);
  reachable[0] = true;
  for (let n = minGroupSize; n <= populationSize; n++) {
    for (let size = minGroupSize; size <= Math.min(maxGroupSize, n); size++) {
      if (reachable[n - size]) {
        reachable[n] = true;
        break;
      }
    }
  }

  let assignable = populationSize;
  while (assignable > 0 && !reachable[assignable]) assignable--;
  const unassignedCount = populationSize - assignable;

  // 分割サイズの復元: 大きい班から優先して決定的に選ぶ(同じassignableでも常に同じ班サイズ列になる)
  const groupSizes: number[] = [];
  let remaining = assignable;
  while (remaining > 0) {
    let chosen = -1;
    for (let size = Math.min(maxGroupSize, remaining); size >= minGroupSize; size--) {
      if (reachable[remaining - size]) {
        chosen = size;
        break;
      }
    }
    // assignableはreachable[assignable] === trueを満たす最大値として選ばれているため、
    // remaining > 0である限り必ずchosenが見つかる
    groupSizes.push(chosen);
    remaining -= chosen;
  }

  return { groupSizes, unassignedCount };
}

/**
 * `orderedIds`(呼び出し側が優先順位付けした順序)を`capacity`内の班へ実際に分割する。
 * 先頭側(優先順位の高い側)から班へ詰めていくため、`planGroupSizes`が返す構造的な余りは
 * 常に`orderedIds`の末尾(優先順位が最も低い側)に残る。
 */
export function partitionIntoGroups(
  orderedIds: readonly string[],
  capacity: GroupCapacity,
): { groups: string[][]; unassignedIds: string[] } {
  const plan = planGroupSizes(orderedIds.length, capacity);
  const groups: string[][] = [];
  let index = 0;
  for (const size of plan.groupSizes) {
    groups.push(orderedIds.slice(index, index + size));
    index += size;
  }
  return { groups, unassignedIds: orderedIds.slice(index) };
}
