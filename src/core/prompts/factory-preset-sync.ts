/**
 * 出厂预设同步计划（纯函数，无 I/O、不读时钟、不调 crypto —— 时间与新 id 由调用方注入）。
 *
 * 背景（2026-11-17）：此前播种对「库里已有同 id」的出厂预设只同步 name、不同步 prompts，
 * 内容仓更新出厂预设后玩家库里的旧行永远不更新，API 请求一直发旧预设。自 #148 起出厂预设
 * 在界面上只读，但旧版 app 可能留下就地改过的行 —— 不能静默丢掉。
 *
 * 做法：出厂行上记「播种指纹」`ChatPreset.factorySeedHash`（= 写入时的出厂内容指纹）。
 * 逐 id 规则（rowHash = 行内容指纹，seed = 行上指纹，fac = 出厂指纹）：
 *   1. 库里没有 → 写出厂行并盖 fac；
 *   2. rowHash == fac → 内容已是最新，至多补盖指纹（不动内容与时间戳，不留副本）；
 *   3. rowHash != fac 且 seed 存在且 rowHash == seed → 玩家没改过，静默覆盖并盖 fac；
 *   4. 其余（无指纹的遗留行，或内容与指纹不符 = 被就地改过）→ 先另存玩家副本
 *      （新 id、名字加「（更新前备份）」、不带指纹），再覆盖并盖 fac。
 */
import type { ChatPreset } from '../types/types';
import type { PresetScope } from './preset-resolution';
// 🔴 content-source ↔ content-pack-plan 之间有运行时环：这里导入的东西只在函数体内使用，
//    绝不在模块顶层求值（否则加载顺序一变就拿到 undefined）。
import { hashContentDeterministic } from '../content/content-source';
import { stableSerialize } from '../content/content-pack-plan';

/** 副本名后缀 */
export const FACTORY_PRESET_BACKUP_SUFFIX = '（更新前备份）';

/** 不算「内容」的字段：时间戳是运行时戳，指纹本身不能参与指纹 */
const NON_CONTENT_KEYS = new Set(['createdAt', 'updatedAt', 'factorySeedHash']);

/**
 * 预设内容指纹：去掉 createdAt / updatedAt / factorySeedHash 后键稳定序列化再 hash。
 * 覆盖 name / description / scope / settings（数组顺序是语义的一部分，参与指纹）。
 */
export function factoryPresetFingerprint(preset: ChatPreset): string {
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(preset)) {
    if (!NON_CONTENT_KEYS.has(key)) content[key] = value;
  }
  return hashContentDeterministic(JSON.stringify(stableSerialize(content)));
}

function clonePreset(preset: ChatPreset): ChatPreset {
  return JSON.parse(JSON.stringify(preset)) as ChatPreset;
}

/** 给出厂预设盖上（重算的）播种指纹；返回新对象，不改入参 */
export function stampFactoryPreset(preset: ChatPreset): ChatPreset {
  const stamped = clonePreset(preset);
  stamped.factorySeedHash = factoryPresetFingerprint(stamped);
  return stamped;
}

export interface FactoryPresetBackup {
  factoryId: string;
  factoryName: string;
  backupId: string;
  backupName: string;
}

export interface PlanFactoryPresetSyncInput {
  /** 出厂预设（同 id 只认第一条） */
  factory: readonly ChatPreset[];
  /** 库里现有的行 */
  existing: readonly ChatPreset[];
  /** 目录对某出厂 id 的生成方式判定（副本沿用它，免得副本出现在不该出现的地方） */
  scopeOf: (factoryId: string) => PresetScope | undefined;
  /** 生成副本 id（调用方注入，通常是 `crypto.randomUUID`） */
  newId: () => string;
  /** 当前时间戳（副本的 createdAt/updatedAt 与覆盖行的 updatedAt） */
  now: number;
}

export interface FactoryPresetSyncPlan {
  /** 要写入的行（副本在前、覆盖行在后，调用方一次 bulkPut 落库） */
  writes: ChatPreset[];
  /** 规则 4 另存的副本 */
  backups: FactoryPresetBackup[];
}

export function planFactoryPresetSync(input: PlanFactoryPresetSyncInput): FactoryPresetSyncPlan {
  const byId = new Map(input.existing.map((row) => [row.id, row] as const));
  const writes: ChatPreset[] = [];
  const backups: FactoryPresetBackup[] = [];
  const seen = new Set<string>();

  for (const factory of input.factory) {
    if (!factory || !factory.id || seen.has(factory.id)) continue;
    seen.add(factory.id);
    const stamped = stampFactoryPreset(factory);
    const fac = stamped.factorySeedHash as string;
    const row = byId.get(factory.id);

    // 规则 1：库里没有
    if (!row) {
      writes.push(stamped);
      continue;
    }

    const rowHash = factoryPresetFingerprint(row);
    // 规则 2：内容已是最新 —— 只补指纹，时间戳与内容原样
    if (rowHash === fac) {
      if (row.factorySeedHash !== fac) writes.push({ ...clonePreset(row), factorySeedHash: fac });
      continue;
    }

    // 规则 4：无指纹的遗留行，或内容与指纹不符 → 先另存副本
    const pristine = row.factorySeedHash !== undefined && rowHash === row.factorySeedHash;
    if (!pristine) {
      const backup = clonePreset(row);
      delete backup.factorySeedHash;
      backup.id = input.newId();
      backup.name = `${row.name}${FACTORY_PRESET_BACKUP_SUFFIX}`;
      backup.createdAt = input.now;
      backup.updatedAt = input.now;
      const scope = input.scopeOf(factory.id);
      if (scope) backup.scope = scope;
      else delete backup.scope;
      writes.push(backup);
      backups.push({
        factoryId: factory.id,
        factoryName: stamped.name,
        backupId: backup.id,
        backupName: backup.name,
      });
    }

    // 规则 3 / 4：覆盖成出厂内容并盖 fac（保留原 createdAt）
    writes.push({ ...stamped, createdAt: row.createdAt, updatedAt: input.now });
  }

  return { writes, backups };
}
