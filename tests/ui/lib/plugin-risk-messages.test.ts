/**
 * plugin-risk-messages —— 插件风险确认文案（设计 §3.4）
 *
 * 钉住：八条固定风险对每个插件都显示（不看 network）；空声明写「未声明联网域名」、
 * 任何地方都不出现「不联网」；Q2 / Q8 两条残余风险照实写进文案；短版只取前三条；
 * 更新新增的域名被标出。
 */
import { describe, expect, it } from 'vitest';
import {
  buildPluginRiskContent,
  formatPluginBytes,
  type PluginRiskManifest,
} from '../../../src/ui/lib/plugin-risk-messages';

function manifest(over: Partial<PluginRiskManifest> = {}): PluginRiskManifest {
  return {
    name: '测试插件',
    version: '1.2.0',
    author: '作者甲',
    network: [],
    capabilities: { read: [], commands: [], events: [], ai: [], storage: [] },
    ...over,
  };
}

const NETWORKED = manifest({ network: ['api.example.com', 'cdn.example.org'] });

describe('buildPluginRiskContent', () => {
  it('完整版对未联网与联网插件都显示同样的八条固定风险', () => {
    const offline = buildPluginRiskContent('install', manifest());
    const online = buildPluginRiskContent('install', NETWORKED);
    expect(offline.warnings).toHaveLength(8);
    expect(online.warnings).toEqual(offline.warnings);
  });

  it('未声明域名时写「未声明联网域名」，任何输出里都没有「不联网」', () => {
    for (const variant of ['install', 'save'] as const) {
      for (const m of [manifest(), NETWORKED]) {
        const c = buildPluginRiskContent(variant, m);
        expect(JSON.stringify(c)).not.toContain('不联网');
      }
      const empty = buildPluginRiskContent(variant, manifest());
      expect(empty.network.emptyText).toBe('未声明联网域名');
      expect(empty.network.domains).toEqual([]);
    }
    expect(buildPluginRiskContent('install', NETWORKED).network.emptyText).toBeNull();
  });

  it('包含 Q2（WebRTC / preconnect 探测本机与局域网）与 Q8（亲手交出的文件、完整备份）两条', () => {
    const { warnings } = buildPluginRiskContent('install', manifest());
    const q2 = warnings.find((w) => w.includes('preconnect'));
    expect(q2).toBeDefined();
    expect(q2).toContain('WebRTC');
    expect(q2).toContain('即使没有声明联网域名');
    expect(q2).toContain('局域网');
    const q8 = warnings.find((w) => w.includes('完整备份'));
    expect(q8).toBeDefined();
    for (const word of ['选取', '拖入', '粘贴', '读取', '发到网上']) expect(q8).toContain(word);
  });

  it('短版（按存档启用）只给前三条风险、一个勾选框，不带能力摘要与免责声明', () => {
    const full = buildPluginRiskContent('install', NETWORKED);
    const short = buildPluginRiskContent('save', NETWORKED);
    expect(short.warnings).toEqual(full.warnings.slice(0, 3));
    expect(short.checkboxes).toHaveLength(1);
    expect(short.checkboxes[0]!.label).toContain('2 个域名');
    expect(short.capabilitySummary).toEqual([]);
    expect(short.disclaimer).toBeNull();
    expect(short.title).toContain('测试插件');
  });

  it('完整版：联网插件多一个「允许连接 N 个域名」勾选框，未联网只有一个', () => {
    expect(buildPluginRiskContent('install', manifest()).checkboxes.map((c) => c.id)).toEqual([
      'risks',
    ]);
    const online = buildPluginRiskContent('install', NETWORKED).checkboxes;
    expect(online.map((c) => c.id)).toEqual(['risks', 'network']);
    expect(online[1]!.label).toBe('允许该插件连接以上 2 个域名');
  });

  it('networkAdded 里的域名被标为新增（大小写不敏感），并给出提示句与「更新」标题', () => {
    const c = buildPluginRiskContent('install', NETWORKED, ['CDN.example.org', 'gone.example.net']);
    expect(c.network.domains).toEqual([
      { host: 'api.example.com', added: false },
      { host: 'cdn.example.org', added: true },
    ]);
    expect(c.network.addedNotice).toContain('1 个');
    expect(c.title.startsWith('更新')).toBe(true);
    const fresh = buildPluginRiskContent('install', NETWORKED);
    expect(fresh.network.addedNotice).toBeNull();
    expect(fresh.title.startsWith('安装')).toBe(true);
  });

  it('能力摘要按分组列出声明项，什么都没声明时明说', () => {
    const c = buildPluginRiskContent(
      'install',
      manifest({
        capabilities: {
          read: ['player', 'items'],
          commands: ['give_item'],
          events: [],
          ai: [],
          storage: ['save'],
        },
      }),
    );
    expect(c.capabilitySummary).toEqual([
      '读取：player、items',
      '修改存档的命令：give_item',
      '存储：save',
    ]);
    expect(buildPluginRiskContent('install', manifest()).capabilitySummary).toEqual([
      '未声明任何宿主能力',
    ]);
  });

  it('作者缺省时显示「未署名」', () => {
    const c = buildPluginRiskContent('install', manifest({ author: undefined }));
    expect(c.identity).toContainEqual({ label: '作者', value: '未署名' });
  });

  it('完整版身份区列出来源、文件数与体积（§3.4）', () => {
    const c = buildPluginRiskContent('install', manifest(), undefined, {
      source: 'local',
      fileCount: 3,
      totalBytes: 2048,
    });
    expect(c.identity).toContainEqual({ label: '来源', value: '本地文件夹' });
    expect(c.identity).toContainEqual({ label: '文件数', value: '3 个' });
    expect(c.identity).toContainEqual({ label: '体积', value: '2.0 KB' });
  });

  it('包信息缺省时不编造行；短版不显示包信息', () => {
    const plain = buildPluginRiskContent('install', manifest());
    expect(plain.identity.map((r) => r.label)).toEqual(['插件', '版本', '作者']);
    const short = buildPluginRiskContent('save', manifest(), undefined, {
      source: 'workshop',
      fileCount: 1,
      totalBytes: 1,
    });
    expect(short.identity.map((r) => r.label)).toEqual(['插件']);
  });

  it('体积按 1024 进制换算', () => {
    expect(formatPluginBytes(512)).toBe('512 B');
    expect(formatPluginBytes(1536)).toBe('1.5 KB');
    expect(formatPluginBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
