/**
 * engine-log-storage-full.ts — 引擎日志「存储已满」回调的前端处理（2026-11-16）。
 *
 * 日志器配额耗尽后已自行停写（`engine-logger.ts` 的 `handleWriteError`）。这里把设置里的
 * 开关同步关掉，让界面状态与实际一致：settings-store 的 watch 随即推
 * `configureEngineLogger({ enabled: false })`；用户导出并清空后重新打开开关即恢复记录。
 *
 * 依赖经参数注入，单测不必拉起 Pinia / main.ts。
 */

const ENGINE_LOG_STORAGE_FULL_MESSAGE =
  '存储已满，完整运行日志已自动关闭；请到开发者设置导出并清空后重新开启';

interface EngineLogStorageFullDeps {
  /** 设置对象（settings-store 的响应式 settings） */
  settings: { engineLogEnabled?: boolean };
  toast(message: string, type: 'error', duration: number): void;
}

export function handleEngineLogStorageFull(deps: EngineLogStorageFullDeps): void {
  deps.settings.engineLogEnabled = false;
  // 不自动消失：日志已经停了，用户需要知道
  deps.toast(ENGINE_LOG_STORAGE_FULL_MESSAGE, 'error', 0);
}
