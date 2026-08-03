/**
 * 落库前的取值卫生（Q-16）—— 「切断 Vue Proxy」的唯一实现。
 *
 * 起因：这条不变式此前在八处各写各的名字（`toRow` ×2、`detach`、内联在
 * `serializeSettingsForLocalStorage` 里、`game-store` 三处裸 `JSON.parse(JSON.stringify(...))`、
 * `worldbook-migration.toRows`），全仓 `JSON.parse(JSON.stringify(` 出现 30+ 次。
 *
 * 它由 Dexie 的 structured clone 强制，而**类型系统完全看不见**：
 * `db.worldBooks.put(reactiveBook)` 类型完全合法，只在运行时炸 `DataCloneError`。
 * 「忘了 detach」因此是新增写路径时最容易踩的坑，今天只靠每个 store 自己记得。
 */

/**
 * 深拷贝，切断 Vue Proxy —— 否则 structured clone 抛 `DataCloneError`。
 *
 * 🔴 **内部保持 JSON 往返，不要换成 `toRaw` + `structuredClone`**：
 * - `toRaw` 只解顶层代理，嵌套 reactive 子对象会存活，`structuredClone` 照样抛。
 * - 而且它会改变落库形状（`Date` 存成 Date 对象而非 ISO 串、`undefined` 键被保留）——
 *   那是存储格式迁移，不是重构。
 */
export function detach<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 盖 `updatedAt` 戳。与 {@link detach} 分开，因为「深拷贝」和「盖戳」是两件事 */
export function stamped<T extends { updatedAt?: number }>(row: T, now = Date.now()): T {
  return { ...row, updatedAt: now };
}

/**
 * 去掉若干运行时字段。
 *
 * 两个 store 的 `toRow` 是**刻意不同**的（一个盖时间戳、一个剥字段），所以刻意
 * **不**把它们收敛成同一个名字 —— 那才是搬错版本的温床。各自写成
 * `stamped(detach(x))` / `omit(detach(x), 'locked')`，差异就摆在调用点上。
 */
export function omit<T extends object, K extends keyof T>(row: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...row };
  for (const k of keys) delete copy[k];
  return copy;
}
