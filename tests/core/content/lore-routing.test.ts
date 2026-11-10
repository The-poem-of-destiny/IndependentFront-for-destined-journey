import { describe, it, expect } from 'vitest';
import type { WorldBook } from '../../../src/core/types/types';
import {
  collectLoreRoutingIssues,
  routeLoreEntriesForAgent,
  resolveLoreDependenciesForAgent,
} from '../../../src/core/content/lore-routing';
import { getEntriesForAgent } from '../../../src/core/content/worldbook-loader';

const uid = (slug: string) => `fated:world_setting/${slug}`;
const book = (): WorldBook => ({
  id: 'test',
  name: '合成书',
  partition: 'world_setting',
  entries: [
    {
      uid: uid('one'),
      name: 'one',
      content: '合成资料',
      enabled: true,
      order: 1,
      position: 0,
      key: [],
      keysecondary: [],
      selectiveLogic: 0,
      extra: { lore: { audiences: ['story'] } },
    },
  ],
});

describe('lore routing', () => {
  it('旧缓存直出声明只归入共享主生成身份，不扩大其他 Agent 或空范围权限', () => {
    const b = book();
    b.entries[0].extra = {
      lore: { audiences: ['direct_cached'], dependsOn: [uid('dependency')] },
    };
    b.entries.push(
      {
        ...b.entries[0],
        uid: uid('dependency'),
        extra: { lore: { audiences: ['direct_main', 'direct_cached'] } },
      },
      { ...b.entries[0], uid: uid('closed'), extra: { lore: { audiences: [] } } },
      { ...b.entries[0], uid: uid('story'), extra: { lore: { audiences: ['story'] } } },
      { ...b.entries[0], uid: uid('character'), extra: { lore: { audiences: ['char_gen'] } } },
    );
    const before = structuredClone(b);
    expect(getEntriesForAgent('direct_main', [b]).map((entry) => entry.uid)).toEqual([
      uid('one'),
      uid('dependency'),
    ]);
    expect(getEntriesForAgent('story', [b]).map((entry) => entry.uid)).toEqual([uid('story')]);
    expect(getEntriesForAgent('char_gen', [b]).map((entry) => entry.uid)).toEqual([
      uid('character'),
    ]);
    expect(collectLoreRoutingIssues([b], ['direct_main', 'story', 'char_gen'])).toEqual([]);
    expect(b).toEqual(before);
  });

  it('读取范围只认条目声明：未声明即关闭，显式空列表也各自生效', () => {
    const undeclared: WorldBook = {
      ...book(),
      entries: [{ ...book().entries[0], extra: undefined }],
    };
    expect(routeLoreEntriesForAgent('story', [undeclared])).toEqual([]);
    expect(collectLoreRoutingIssues([undeclared]).map((i) => i.kind)).toEqual(['no-audiences']);

    const b = book();
    b.entries.push(
      { ...b.entries[0], uid: uid('two'), extra: { lore: { audiences: ['char_gen'] } } },
      { ...b.entries[0], uid: uid('three'), extra: { lore: { audiences: [] } } },
    );
    expect(getEntriesForAgent('story', [b]).map((e) => e.uid)).toEqual([uid('one')]);
    expect(getEntriesForAgent('char_gen', [b]).map((e) => e.uid)).toEqual([uid('two')]);
  });

  it('diagnoses duplicate UIDs, missing/unreadable dependencies and unknown agents', () => {
    const b = book();
    b.entries[0].extra = {
      lore: { audiences: ['story', 'invalid'], dependsOn: [uid('two'), uid('missing')] },
    };
    b.entries.push(
      { ...b.entries[0], uid: uid('two'), extra: { lore: { audiences: ['char_gen'] } } },
      { ...b.entries[0] },
    );
    const kinds = collectLoreRoutingIssues([b], ['story', 'char_gen']).map((i) => i.kind);
    expect(kinds).toContain('unknown-agent');
    expect(kinds).toContain('duplicate-key');
    expect(kinds).toContain('missing-dependency');
    expect(kinds).toContain('dependency-not-readable');
  });

  it.each(['disabled', 'missing', 'not-readable', 'excluded', 'cycle', 'duplicate-key'])(
    '公共读取拒绝 %s 依赖的根和传递依赖，保留确定性诊断',
    (reason) => {
      const b = book();
      const make = (name: string, dependsOn: string[] = []) => ({
        ...b.entries[0],
        uid: uid(name),
        name,
        extra: { lore: { audiences: ['story'], dependsOn: dependsOn.map(uid) } },
      });
      b.entries = [make('root', ['dep']), make('ancestor', ['root']), make('dep'), make('good')];
      if (reason === 'disabled') b.entries[2].enabled = false;
      if (reason === 'missing') b.entries.splice(2, 1);
      if (reason === 'not-readable') b.entries[2].extra!.lore!.audiences = ['char_gen'];
      if (reason === 'excluded')
        b.entries[2].extra!.lore!.activation = { excludeKeywords: ['stop'] };
      if (reason === 'cycle') b.entries[2].extra!.lore!.dependsOn = [uid('root')];
      if (reason === 'duplicate-key') b.entries.push(make('dep'));
      const input = JSON.stringify(b);
      const result = resolveLoreDependenciesForAgent('story', [b], 'stop');
      expect(result.entries.map((r) => r.key)).toEqual([uid('good')]);
      expect(result.rejectedRoots).toContainEqual({
        key: uid('root'),
        dependencyKey: uid(reason === 'cycle' ? 'root' : 'dep'),
        reason,
      });
      expect(result.rejectedRoots.some((r) => r.key === uid('ancestor'))).toBe(true);
      expect(getEntriesForAgent('story', [b], 'stop').map((e) => e.name)).toEqual(['good']);
      expect(JSON.stringify(b)).toBe(input);
      expect(resolveLoreDependenciesForAgent('story', [b], 'stop')).toEqual(result);
    },
  );

  it('有效跨书依赖闭包去重但不扩大权限，修复依赖后根重新可读', () => {
    const root = book(),
      dep = book();
    root.entries[0].uid = uid('root');
    root.entries[0].extra = {
      lore: { audiences: ['story'], dependsOn: [uid('dep'), uid('dep')] },
    };
    dep.id = 'dep-book';
    dep.entries[0].uid = uid('dep');
    dep.entries[0].extra = { lore: { audiences: ['story'] } };
    const result = resolveLoreDependenciesForAgent('story', [root, dep]);
    expect(result.closures.get(uid('root'))?.map((r) => r.key)).toEqual([uid('dep'), uid('root')]);
    expect(result.blockedDependencyKeys).toEqual([]);
    dep.entries[0].enabled = false;
    expect(getEntriesForAgent('story', [root, dep])).toEqual([]);
    dep.entries[0].enabled = true;
    expect(getEntriesForAgent('story', [root, dep])).toHaveLength(2);
  });

  it('old-mode entry reads enforce hard exclusions without requiring selection or section metadata', () => {
    const b = book();
    b.entries[0].extra = {
      lore: {
        audiences: ['story'],
        section: 'region',
        activation: { locations: ['elsewhere'], excludeKeywords: ['禁止'] },
      },
    };
    expect(getEntriesForAgent('story', [b], '继续')).toHaveLength(1);
    expect(getEntriesForAgent('story', [b], '禁止')).toEqual([]);
  });
});
