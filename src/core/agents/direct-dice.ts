/** 直出骰池：按骰面分组，模型以 (sides, index) 定位并消费其中一颗 */
interface DirectDiceGroup {
  sides: number;
  values: number[];
}

export type DirectDicePool = DirectDiceGroup[];

/** 各骰面的数量；顺序即骰池分组顺序 */
const DIRECT_DICE_COUNTS: ReadonlyArray<readonly [sides: number, count: number]> = [
  [4, 10],
  [6, 10],
  [8, 10],
  [10, 10],
  [12, 10],
  [20, 20],
  [100, 10],
];

/** 拒绝采样掷一颗 1..sides 的骰，避免取模偏差 */
function rollDie(sides: number): number {
  const limit = Math.floor(0x100000000 / sides) * sides;
  let n: number;
  do {
    n = crypto.getRandomValues(new Uint32Array(1))[0];
  } while (n >= limit);
  return (n % sides) + 1;
}

export function rollDirectDice(): DirectDicePool {
  return DIRECT_DICE_COUNTS.map(([sides, count]) => ({
    sides,
    values: Array.from({ length: count }, () => rollDie(sides)),
  }));
}

/** 每组一行：`d20: {7, 13, …}`；非缓存尾部与缓存 turn_context 共用同一份文本 */
export function formatDirectDicePool(pool: DirectDicePool): string[] {
  return pool.map(({ sides, values }) => `d${sides}: {${values.join(', ')}}`);
}

/** 骰池总颗数 */
export function countDirectDice(pool: DirectDicePool): number {
  return pool.reduce((sum, group) => sum + group.values.length, 0);
}
