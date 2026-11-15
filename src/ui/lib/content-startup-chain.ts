/**
 * 启动期内容链：世界书 → 工坊项目元数据 → 远程素材同步（App.vue 启动时踢一脚）。
 *
 * 🔴 三步顺序是契约（见 src/ui/AGENTS.md「启动链」）：远程素材的声明有一半住在世界书
 *    条目正文里（含工坊装进来的书），所以同步必须排在前两步之后。
 * 🔴 工坊这一步**单独兜底**：`workshop.init()` 读库失败时会 reject（不再自吞），
 *    若与后面串在同一条 `.then` 链上，一次工坊读失败就会让远程素材同步整个不跑。
 *    工坊元数据缺失时工坊规则保持关闭，不影响素材同步与普通正文，所以吞掉继续。
 * 整条链永不 reject、永不阻塞启动。
 */
export interface ContentStartupDeps {
  worldbooks: { init: () => Promise<unknown> };
  workshop: { init: () => Promise<unknown> };
  assets: { syncRemoteAssets: () => Promise<unknown> };
}

export async function runContentStartupChain(deps: ContentStartupDeps): Promise<void> {
  try {
    await deps.worldbooks.init();
    try {
      await deps.workshop.init();
    } catch (err) {
      console.warn('[startup] 工坊项目元数据载入失败，工坊规则暂不生效:', err);
    }
    await deps.assets.syncRemoteAssets();
  } catch {
    /* 迁移例程内部永不抛；这里兜 hydrate/内置合并的意外，不该拦住应用启动 */
  }
}
