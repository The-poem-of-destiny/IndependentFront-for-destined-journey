/**
 * plugin-risk-messages.ts —— 插件风险确认的全部文案（设计 §3.4）
 *
 * 安装 / 更新确认与「按存档启用」确认两个弹窗共用这里的句子，不在模板里各写一份
 * （先例 `session-import-messages.ts`）。这些句子是玩家决定「装不装、开不开」的
 * 全部依据，措辞散进组件就会两处各说各的。
 *
 * 🔴 **纯函数、零副作用、除类型外零依赖。**
 *
 * 🔴 固定风险说明对**每个**插件都显示，不看是否声明了 `network`：没声明域名的插件
 *    照样能经 WebRTC 把数据发到公网对端（§4.3），所以空声明一律写「未声明联网域名」，
 *    绝不写成「离线」一类的保证。
 *
 * 已裁定的两条残余风险必须写进文案（见设计 §10）：
 * - Q2：即使没声明域名，插件也能借 WebRTC / preconnect 探测本机和局域网里哪些主机在线；
 * - Q8：玩家亲手交给插件的文件（选取、拖入、粘贴）插件都能读取并发出去。
 */

import type { PluginManifest } from '@engine/types/types-plugin';

/** 弹窗用到的 manifest 切面：只读这几项，调用方不必凑齐整份 manifest */
export type PluginRiskManifest = Pick<
  PluginManifest,
  'name' | 'version' | 'author' | 'network' | 'capabilities'
>;

/** 两种确认：安装 / 更新（完整版）与按存档启用（短版） */
export type PluginRiskVariant = 'install' | 'save';

/**
 * 安装 / 更新确认里的包信息（§3.4「来源、文件数与体积」）。
 * 都是可选项：缺哪项就不显示哪行，不编造数字。短版（按存档启用）不显示。
 */
export interface PluginRiskPackageInfo {
  source?: 'local' | 'workshop';
  fileCount?: number;
  totalBytes?: number;
}

/** 一条联网域名；`added` = 本次更新新增，弹窗要高亮 */
interface PluginRiskDomain {
  host: string;
  added: boolean;
}

/** 一个必须亲手勾上的确认项；全部勾上之前「确认」不可点 */
interface PluginRiskCheckbox {
  id: 'risks' | 'network';
  label: string;
}

/** 弹窗渲染所需的全部结构化内容 */
export interface PluginRiskContent {
  title: string;
  /** 插件身份：名称、版本、作者；完整版另有来源、文件数、体积（有值才列） */
  identity: { label: string; value: string }[];
  network: {
    /** 域名为空时显示的说明（「未声明联网域名」），有域名时为 null */
    emptyText: string | null;
    domains: PluginRiskDomain[];
    /** 更新新增了域名时的提示句，否则 null */
    addedNotice: string | null;
  };
  /** 固定风险说明：完整版八条，短版取前三条 */
  warnings: string[];
  /** 声明的宿主能力摘要；短版为空数组 */
  capabilitySummary: string[];
  /** 免责声明；短版为 null */
  disclaimer: string | null;
  checkboxes: PluginRiskCheckbox[];
}

/** 空声明的唯一措辞 —— 不是「离线」，WebRTC 拦不住（§4.3） */
const NETWORK_EMPTY_TEXT = '未声明联网域名';

/** 短版（按存档启用）只显示前几条 */
const SHORT_WARNING_COUNT = 3;

/**
 * 固定风险说明，逐条成句，顺序即重要性（短版取前三条）。
 * 第 4 条是 Q2，第 7 条是 Q8 —— 两条都是已裁定接受的残余，必须照实告知。
 */
const FIXED_WARNINGS: readonly string[] = [
  '这是第三方插件，本项目没有审核过它。',
  '它可以任意修改启用了它的存档。',
  '它可以把你的存档和聊天内容发到网上：声明了联网域名的，会发到上面列出的服务器；没声明也能经 WebRTC 发给公网上的对端，浏览器拦不住。',
  '即使没有声明联网域名，它也可能借 WebRTC 或预连接（preconnect）探测你的电脑和局域网里有哪些设备、端口在线，但无法向它们下达指令。',
  '它可能从网上加载代码，行为可能在你不知情时改变。',
  '插件窗口里的内容由插件绘制。本应用绝不会在插件窗口里要你输入 API Key 或密码，看到就是假的。',
  '你亲手交给插件的文件（选取、拖入、粘贴）它都能读取，并可以发到网上。绝不要把完整备份或含密钥的文件交给插件。',
  '插件给的链接本应用只让你复制，不替你打开。你自己粘贴到浏览器里打开的页面不受插件沙盒约束，能访问你的电脑和局域网上的服务。',
];

const DISCLAIMER = '使用第三方插件的后果由你自行承担。';

/** 能力分组的中文名；顺序即摘要的行序 */
const CAPABILITY_LABELS: readonly [keyof PluginManifest['capabilities'], string][] = [
  ['read', '读取'],
  ['commands', '修改存档的命令'],
  ['events', '订阅事件'],
  ['ai', 'AI 交互'],
  ['storage', '存储'],
];

const SOURCE_LABELS: Record<NonNullable<PluginRiskPackageInfo['source']>, string> = {
  local: '本地文件夹',
  workshop: '创意工坊',
};

/** 字节数 → 人读体积（1024 进制，保留一位小数） */
export function formatPluginBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildPackageRows(info: PluginRiskPackageInfo | undefined): PluginRiskContent['identity'] {
  if (!info) return [];
  const rows: PluginRiskContent['identity'] = [];
  if (info.source !== undefined) rows.push({ label: '来源', value: SOURCE_LABELS[info.source] });
  if (info.fileCount !== undefined && Number.isFinite(info.fileCount)) {
    rows.push({ label: '文件数', value: `${info.fileCount} 个` });
  }
  if (info.totalBytes !== undefined) {
    rows.push({ label: '体积', value: formatPluginBytes(info.totalBytes) });
  }
  return rows;
}

/** 域名比较按小写进行：manifest 已规整，这里只防调用方传入大小写不一的差集 */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

function buildCapabilitySummary(caps: PluginManifest['capabilities']): string[] {
  const lines: string[] = [];
  for (const [key, label] of CAPABILITY_LABELS) {
    const names = caps[key];
    if (names.length > 0) lines.push(`${label}：${names.join('、')}`);
  }
  // 什么都没声明也要说出来 —— 空白会被读成「没看到」，而不是「它什么都不要」
  return lines.length > 0 ? lines : ['未声明任何宿主能力'];
}

/**
 * 生成风险确认弹窗的内容。
 *
 * - `variant = 'install'`：安装 / 更新用的完整版（八条风险 + 能力摘要 + 免责声明）；
 *   `networkAdded` 有值即视为更新，标题随之改为「更新」，其中仍在 `network` 里的域名标为新增。
 * - `variant = 'save'`：按存档启用的短版（插件名、联网域名、前三条风险、一个勾选框）。
 * - `packageInfo`：完整版身份区追加的来源 / 文件数 / 体积（§3.4）；短版忽略。
 */
export function buildPluginRiskContent(
  variant: PluginRiskVariant,
  manifest: PluginRiskManifest,
  networkAdded?: readonly string[],
  packageInfo?: PluginRiskPackageInfo,
): PluginRiskContent {
  const addedSet = new Set((networkAdded ?? []).map(normalizeHost));
  const domains: PluginRiskDomain[] = manifest.network.map((host) => ({
    host,
    added: addedSet.has(normalizeHost(host)),
  }));
  const addedCount = domains.filter((d) => d.added).length;
  const hasNetwork = domains.length > 0;

  const network: PluginRiskContent['network'] = {
    emptyText: hasNetwork ? null : NETWORK_EMPTY_TEXT,
    domains,
    addedNotice: addedCount > 0 ? `本次更新新增了 ${addedCount} 个联网域名（已标出）。` : null,
  };

  if (variant === 'save') {
    return {
      title: `在本存档启用插件「${manifest.name}」`,
      identity: [{ label: '插件', value: manifest.name }],
      network,
      warnings: FIXED_WARNINGS.slice(0, SHORT_WARNING_COUNT),
      capabilitySummary: [],
      disclaimer: null,
      checkboxes: [
        {
          id: 'risks',
          label: hasNetwork
            ? `我已了解以上风险，允许该插件在本存档中运行并连接以上 ${domains.length} 个域名`
            : '我已了解以上风险，允许该插件在本存档中运行',
        },
      ],
    };
  }

  const isUpdate = networkAdded !== undefined;
  const checkboxes: PluginRiskCheckbox[] = [{ id: 'risks', label: '我已阅读并了解以上风险' }];
  if (hasNetwork) {
    checkboxes.push({ id: 'network', label: `允许该插件连接以上 ${domains.length} 个域名` });
  }

  return {
    title: `${isUpdate ? '更新' : '安装'}第三方插件「${manifest.name}」`,
    identity: [
      { label: '插件', value: manifest.name },
      { label: '版本', value: manifest.version },
      { label: '作者', value: manifest.author?.trim() || '未署名' },
      ...buildPackageRows(packageInfo),
    ],
    network,
    warnings: [...FIXED_WARNINGS],
    capabilitySummary: buildCapabilitySummary(manifest.capabilities),
    disclaimer: DISCLAIMER,
    checkboxes,
  };
}
