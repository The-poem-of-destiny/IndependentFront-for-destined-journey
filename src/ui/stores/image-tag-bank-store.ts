/**
 * image-tag-bank-store.ts — 标签词库（图像 v1.4）的 Dexie 唯一读写口
 *
 * 词库是**用户导入**的中文→danbooru 映射（几千条量级），供 `image_prompt` 侧链
 * 经 `get_image_tags` / `search_image_tags` 两个工具查询。检索模型是
 * **AI 看目录 → 调工具 → 拿标签 → 自己组装**（用户裁定，2026-08-05）。
 *
 * 三条与 `image-preset-store` 同源的约定:
 *
 * 1. **全局，不随存档隔离** —— `deleteSaveSlot` 不碰这张表。词库是参考资料，
 *    删一个存档不该让另一个存档的出图突然失去词汇。
 * 2. IndexedDB 不可用时降级成空库，不抛 —— 没有词库只是让 AI 自己写标签，
 *    不该把整条出图路径拖垮（对齐 asset-store / image-preset-store）。
 * 3. 转换逻辑**一行都不在这里**：`parseTagBankLorebook` 是引擎层的纯函数，
 *    本 store 只负责「拿到计划 → 落库 → 刷新内存」。于是几千条的解析在测试里
 *    是一次函数调用，不需要 fake-indexeddb。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { TagBank, TagBankEntry, TagBankImportPlan } from '@engine/types-image';
import { parseTagBankLorebook } from '@engine/image-tag-bank-import';
import { collectEnabledEntries, formatTagBankCatalogue } from '@engine/image-tag-bank';
import { deleteTagBank, getTagBanks, saveTagBank } from '@engine/database';
import { detach } from './db-write';
import { mutationFail, mutationOk, type MutationResult } from './store-result';

/** 导入一份文件的结果：落库的那本 + 给用户看的报告 */
export interface TagBankImportOutcome {
  bank: TagBank;
  plan: TagBankImportPlan;
}

export const useImageTagBankStore = defineStore('imageTagBank', () => {
  const banks = ref<TagBank[]>([]);
  const loading = ref(false);
  let initialized = false;

  async function refresh(): Promise<void> {
    try {
      banks.value = await getTagBanks();
    } catch {
      banks.value = [];
    }
  }

  /** 幂等；设置页 onMounted / 出图前调 */
  async function init(): Promise<void> {
    if (initialized) return;
    initialized = true;
    loading.value = true;
    try {
      await refresh();
    } finally {
      loading.value = false;
    }
  }

  /**
   * 真正生效的条目 —— **出图链路只该读这一个**。
   *
   * 两层开关（整本 / 条目）都在 `collectEnabledEntries` 里过，各处自己 filter 一遍
   * 就是漂移的来路：一边算目录、一边算工具数据源，两者不一致时模型会看见一个
   * 查不到标签的名字，而这不会有任何报错。
   */
  const enabledEntries = computed<TagBankEntry[]>(() => collectEnabledEntries(banks.value));

  /** 目录字符数 —— 设置页拿它告诉用户「这本每张图要多花多少」 */
  const catalogueChars = computed<number>(() =>
    enabledEntries.value.length === 0 ? 0 : formatTagBankCatalogue(enabledEntries.value).length,
  );

  const totalEntries = computed<number>(() =>
    banks.value.reduce((sum, b) => sum + b.entries.length, 0),
  );

  function syncLocal(row: TagBank): void {
    const i = banks.value.findIndex((b) => b.id === row.id);
    if (i >= 0) banks.value.splice(i, 1, row);
    else banks.value.push(row);
  }

  /**
   * 导入一个 ST 世界书 JSON。
   *
   * 🔴 **一条都读不出来时不落库**：落一本空的进去，用户在列表里看到「0 条」，
   *    却没有任何线索说明为什么 —— 直接失败并把报告给他更诚实。
   *    读出来了但有跳过项则照常落库（报告里带着那些项，见 `plan.notes`）。
   */
  async function importFromJson(
    raw: unknown,
    name: string,
    sourceFile?: string,
  ): Promise<MutationResult<TagBankImportOutcome>> {
    const id = `tagbank-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let plan: TagBankImportPlan;
    try {
      plan = parseTagBankLorebook(raw, { bankId: id });
    } catch (e) {
      // 转换器契约上不抛（几千条里总有没见过的写法，抛错等于一条毁一本），
      // 真抛了就是它自己的 bug —— 照实报出来，别装作是空词库
      return mutationFail('failed', `解析失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (plan.entries.length === 0) {
      return mutationFail(
        'failed',
        `这个文件里没读出任何标签条目（共 ${plan.stats.total} 条）。确认它是「[分类]：名字 / - 名字：tag, tag」那种格式的世界书。`,
      );
    }

    const now = Date.now();
    const bank: TagBank = {
      id,
      name: name.trim() === '' ? '未命名词库' : name.trim(),
      ...(sourceFile ? { sourceFile } : {}),
      entries: plan.entries,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await saveTagBank(detach(bank));
    } catch (e) {
      return mutationFail('failed', `写入失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    syncLocal(bank);
    return mutationOk({ bank, plan });
  }

  /** 整本启用/停用 —— 不必删就能试 */
  async function setEnabled(id: string, enabled: boolean): Promise<MutationResult<TagBank>> {
    const current = banks.value.find((b) => b.id === id);
    if (!current) return mutationFail('not-found', '这本词库已经不在了。');
    // 🔴 `current` 来自 `banks.value`，是 Vue 代理 —— 展开之后 `entries[]` 仍是代理，
    //    直接交给 Dexie 会抛 `DataCloneError`（structured clone 不认代理）。
    //    这条不变式**类型系统完全看不见**：不 detach 一样能编译过。
    const next: TagBank = detach({ ...current, enabled, updatedAt: Date.now() });
    try {
      await saveTagBank(next);
    } catch (e) {
      return mutationFail('failed', `写入失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    syncLocal(next);
    return mutationOk(next);
  }

  async function rename(id: string, name: string): Promise<MutationResult<TagBank>> {
    const trimmed = name.trim();
    if (trimmed === '') return mutationFail('failed', '名字不能为空。');
    const current = banks.value.find((b) => b.id === id);
    if (!current) return mutationFail('not-found', '这本词库已经不在了。');
    const next: TagBank = detach({ ...current, name: trimmed, updatedAt: Date.now() });
    try {
      await saveTagBank(next);
    } catch (e) {
      return mutationFail('failed', `写入失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    syncLocal(next);
    return mutationOk(next);
  }

  async function remove(id: string): Promise<MutationResult> {
    const i = banks.value.findIndex((b) => b.id === id);
    if (i < 0) return mutationFail('not-found', '这本词库已经不在了。');
    try {
      await deleteTagBank(id);
    } catch (e) {
      return mutationFail('failed', `删除失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    banks.value.splice(i, 1);
    return mutationOk();
  }

  return {
    banks: computed(() => banks.value),
    loading: computed(() => loading.value),
    enabledEntries,
    catalogueChars,
    totalEntries,
    init,
    refresh,
    importFromJson,
    setEnabled,
    rename,
    remove,
  };
});
