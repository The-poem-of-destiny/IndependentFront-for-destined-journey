/**
 * 引擎侧读设置的**唯一入口**（Q-06）。
 *
 * 起因：设置曾有两个真源。前端设置住在 localStorage（`settings-store` 的
 * `fated-poem-settings`），而引擎侧 `createSnapshot` 读的是 Dexie `settings` 表 ——
 * 一份由 `initializeDatabase` 播种、之后再没人写全的**影子配置**。
 * 两侧靠 `game-pipeline.syncSnapshotSettings` 搭桥，那座桥只搬两个字段，
 * 且以 `catch { console.warn }` 静默失败。
 *
 * 于是 `AppSettings` 几十个字段里只有两个是活的：引擎侧任何新增的「读 settings」
 * 都会读到永远停在 `DEFAULT_SETTINGS` 的那份，症状是**「设置页明明改了、引擎行为没变」**，
 * 而且桥断了用户完全无感。
 *
 * ---
 *
 * **裁定：真源在前端（localStorage），引擎侧通过本注入缝读。**
 *
 * 为什么不是反过来把设置搬进 Dexie：按 AGENTS.md，应用 localStorage 现在**只**存
 * 无密钥的设置元数据（API Key 早已迁进 Dexie `apiEndpoints`），那正是它该待的地方。
 * 引擎要的是「当前生效的设置」这个**能力**，不是「某张表」这个位置 —— 所以给缝，
 * 不搬家。缝也让引擎在无 UI 的场合（测试 / 未来的 headless 跑批）自带可用缺省。
 *
 * `main.ts` 启动时用 settings-store 注册 provider。没注册时返回 `DEFAULT_SETTINGS`
 * 的对应字段 —— 与注册前的行为一致，不是新的降级路径。
 */
import { DEFAULT_SETTINGS } from './types';

/**
 * 引擎真正会读的设置字段。
 *
 * 刻意**只列引擎用得上的**，不是整个 `AppSettings`：这个类型就是「引擎与 UI 之间
 * 的设置契约」，列全等于把两侧重新绑死，加个纯 UI 字段又要动引擎。
 * 引擎新要读一个字段时，在这里加一项 —— 那一次改动是有意义的。
 */
export interface EngineSettings {
  /** 每个存档保留的快照上限 */
  maxSnapshotsPerSave: number;
  /** 快照保留模式：tiered = 分层稀疏保留，dense = 一律保留最近 N 张 */
  snapshotRetentionMode: 'tiered' | 'dense';
  /**
   * 随机事件总开关（随机事件系统 v1 / 裁定 §13-4）。
   * 关 = 调度整段 no-op（**保留 flags 不清**）+ 注入空串 + marker 忽略。
   */
  randomEventsEnabled: boolean;
  /** 随机事件频率系数（0.5 / 1 / 2），乘进每次 MTTH 掷骰的权重 */
  randomEventsFrequency: number;
}

/**
 * 随机事件两项的缺省值**写在这里而不是取自 `DEFAULT_SETTINGS`**（与上面两项刻意不同）。
 *
 * 理由：这两项的真源是前端 localStorage 的 `UiSettings`（裁定 §13-4「口味开关」，不进
 * `AppSettings`、不进存档、零迁移）。往 `AppSettings` 里加两个引擎唯一消费方的字段，
 * 等于把「设置有两个真源」那个刚拆掉的坑再挖一次（本文件头就是那次事故的记录）。
 *
 * 🔴 **默认必须是「开」**：provider 由 `main.ts` 在 W3 才接上，在那之前（以及任何 headless
 *    跑批 / 测试场合）这两个值就是系统的实际行为。默认 `false` 的症状是整个子系统装好了、
 *    测试全绿、真机一个事件都不起，而没有任何一处会报错。
 */
const RANDOM_EVENTS_ENABLED_DEFAULT = true;
const RANDOM_EVENTS_FREQUENCY_DEFAULT = 1;

const FALLBACK: EngineSettings = {
  maxSnapshotsPerSave: DEFAULT_SETTINGS.maxSnapshotsPerSave,
  snapshotRetentionMode: DEFAULT_SETTINGS.snapshotRetentionMode,
  randomEventsEnabled: RANDOM_EVENTS_ENABLED_DEFAULT,
  randomEventsFrequency: RANDOM_EVENTS_FREQUENCY_DEFAULT,
};

type Provider = () => Partial<EngineSettings> | undefined;

let provider: Provider | undefined;

/**
 * 注册设置来源。由 `main.ts` 在应用启动时接上 settings-store。
 *
 * 传 `undefined` 撤销注册（测试用），此后回到缺省值。
 */
export function setEngineSettingsProvider(fn: Provider | undefined): void {
  provider = fn;
}

/**
 * 取当前生效的引擎设置。**同步**——调用点大多在写库路径上，不该为读几个数字再等一次 IO。
 *
 * provider 抛错时按缺省值继续：设置读不到不该让存档写入失败，
 * 但会打一条 error（与旧实现的静默 warn 不同——那正是让桥断了没人发现的原因）。
 */
export function getEngineSettings(): EngineSettings {
  if (!provider) return { ...FALLBACK };
  try {
    const partial = provider() ?? {};
    return {
      maxSnapshotsPerSave: partial.maxSnapshotsPerSave ?? FALLBACK.maxSnapshotsPerSave,
      snapshotRetentionMode: partial.snapshotRetentionMode ?? FALLBACK.snapshotRetentionMode,
      randomEventsEnabled: partial.randomEventsEnabled ?? FALLBACK.randomEventsEnabled,
      randomEventsFrequency: partial.randomEventsFrequency ?? FALLBACK.randomEventsFrequency,
    };
  } catch (err) {
    console.error('[engine-settings] provider 抛异常，按缺省值继续:', err);
    return { ...FALLBACK };
  }
}
