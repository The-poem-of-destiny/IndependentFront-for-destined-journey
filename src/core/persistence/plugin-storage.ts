/**
 * 插件系统的 Dexie 读写入口（v34 三张表：`plugins` / `pluginFiles` / `pluginKv`）。
 * 设计见 docs/planning/2026-11-15-plugin-system-design.md §3.5、§5.6。
 *
 * `src/core/plugins/**` 保持纯函数，所有落库都在这里。
 */
import { getDatabase } from './database';
import { PLUGIN_LIMITS } from '../plugins/plugin-surface';
import type {
  PluginConsent,
  PluginFileRecord,
  PluginKvRecord,
  PluginRecord,
  PluginResult,
} from '../types/types-plugin';

/** 全部已安装插件，按 id 排序 */
export async function listPluginRecords(): Promise<PluginRecord[]> {
  return getDatabase().plugins.toArray();
}

export async function getPluginRecord(id: string): Promise<PluginRecord | undefined> {
  return getDatabase().plugins.get(id);
}

/** 某插件的全部包文件，按路径排序 */
export async function getPluginFiles(id: string): Promise<PluginFileRecord[]> {
  const rows = await getDatabase().pluginFiles.where('pluginId').equals(id).toArray();
  return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * 安装或更新：一个事务内删掉该插件的旧文件、写入新文件集、写入安装记录。
 * 任何一步失败整体回滚，不会留下新旧混杂的文件集。
 * 🔴 文件行的 `pluginId` 必须等于 `record.id`，否则直接抛（调用方的 bug，不是玩家输入）。
 */
export async function putPluginInstall(
  record: PluginRecord,
  files: readonly PluginFileRecord[],
): Promise<void> {
  for (const file of files) {
    if (file.pluginId !== record.id) {
      throw new Error(`插件文件归属不一致：${file.path} 属于 ${file.pluginId}，不是 ${record.id}`);
    }
  }
  const db = getDatabase();
  await db.transaction('rw', db.plugins, db.pluginFiles, async () => {
    await db.pluginFiles.where('pluginId').equals(record.id).delete();
    if (files.length > 0) await db.pluginFiles.bulkPut([...files]);
    await db.plugins.put(record);
  });
}

/**
 * 卸载：删安装记录、包文件与该插件的全局数据（`pluginKv`）。
 * 各存档里的 `worldFlags.plugins[id]` 不动，重装后可续用（§6.4）。
 */
export async function deletePluginInstall(id: string): Promise<void> {
  const db = getDatabase();
  await db.transaction('rw', db.plugins, db.pluginFiles, db.pluginKv, async () => {
    await db.pluginFiles.where('pluginId').equals(id).delete();
    await db.pluginKv.where('pluginId').equals(id).delete();
    await db.plugins.delete(id);
  });
}

/**
 * 写入或撤销某存档的本机确认（`consent === null` 即撤销）。
 * 插件未安装时返回 `false`、什么也不写。
 */
export async function setPluginSaveConsent(
  id: string,
  saveId: string,
  consent: PluginConsent | null,
): Promise<boolean> {
  const db = getDatabase();
  return db.transaction('rw', db.plugins, async () => {
    const record = await db.plugins.get(id);
    if (!record) return false;
    const saveConsents = { ...record.saveConsents };
    if (consent === null) delete saveConsents[saveId];
    else saveConsents[saveId] = consent;
    await db.plugins.put({ ...record, saveConsents });
    return true;
  });
}

// ─── 全局 KV（host.storage.global） ───

const utf8 = new TextEncoder();

function invalid(message: string): PluginResult<unknown> {
  return { ok: false, code: 'INVALID', message };
}

function checkKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0;
}

/** 读一个键；不存在时 `value` 为 `undefined` */
export async function pluginKvGet(pluginId: string, key: string): Promise<PluginResult<unknown>> {
  if (!checkKey(key)) return invalid('键必须是非空字符串');
  const row = await getDatabase().pluginKv.get([pluginId, key]);
  return { ok: true, value: row?.value };
}

/**
 * 写一个键。值必须能 JSON 序列化，落库的是 JSON 往返后的规整值。
 * 键与值的 UTF-8 字节数计入每插件 1MB 配额，超出返回 `QUOTA`（覆盖同键时按新值重算）。
 */
export async function pluginKvSet(
  pluginId: string,
  key: string,
  value: unknown,
): Promise<PluginResult<unknown>> {
  if (!checkKey(key)) return invalid('键必须是非空字符串');
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return invalid('值必须能 JSON 序列化');
  }
  if (json === undefined) return invalid('值必须能 JSON 序列化');
  const bytes = utf8.encode(key).length + utf8.encode(json).length;
  const row: PluginKvRecord = { pluginId, key, value: JSON.parse(json), bytes };

  const db = getDatabase();
  return db.transaction('rw', db.pluginKv, async (): Promise<PluginResult<unknown>> => {
    let used = 0;
    await db.pluginKv
      .where('pluginId')
      .equals(pluginId)
      .each((r) => {
        if (r.key !== key) used += r.bytes;
      });
    if (used + bytes > PLUGIN_LIMITS.globalBytes) {
      return {
        ok: false,
        code: 'QUOTA',
        message: `全局存储超出配额（${PLUGIN_LIMITS.globalBytes} 字节）`,
      };
    }
    await db.pluginKv.put(row);
    return { ok: true };
  });
}

/** 删一个键；键不存在也算成功 */
export async function pluginKvRemove(
  pluginId: string,
  key: string,
): Promise<PluginResult<unknown>> {
  if (!checkKey(key)) return invalid('键必须是非空字符串');
  await getDatabase().pluginKv.delete([pluginId, key]);
  return { ok: true };
}
