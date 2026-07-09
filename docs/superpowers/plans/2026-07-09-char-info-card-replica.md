# CharGenSystemCard 原版复刻 — 实现计划

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this plan task-by-task.
> 原版参考文件：`E:/code/fated_poem_independent/temp_char_info_v3.html`（804行，Vue 3 + Pinia，8 Tab 角色查看器）

**Goal:** 将 CharGenSystemCard 从"自创骨架"改造为原版 char_info v3.0.2 风格的嵌入式角色卡片，在 ChatFlow 中呈现原版角色查看器的视觉风格

**Architecture:** 单文件 Vue 3 SFC，无新依赖。复刻原版的色彩体系（种族色映射、层级色映射、品质色发光）、卡片骨架（层级色左边框+发光）、区段组织（五维旗标→标签→势力→职业→背景→技能→装备→登神），省略全屏专属的粒子Canvas和SVG边框装饰

**Tech Stack:** Vue 3 + TypeScript + scoped CSS + Font Awesome 6 Free + 已有 CSS 变量体系

## 原版参考数据（精确值）

### 层级色
T1=`#57595D` T2=`#50C878` T3=`#2196F3` T4=`#9932CC` T5=`#FFD700` T6=`#DC143C` T7=`#00FFFF`

### 品质色（含 glow）
| 品质 | 色值 | 文字发光 |
|------|------|---------|
| 普通 | `#c4cad3` | 无 |
| 优良 | `#7be495` | rgba(123,228,149,0.28) |
| 稀有 | `#62bbff` | rgba(98,187,255,0.3) |
| 史诗 | `#cf95ff` | rgba(207,149,255,0.3) |
| 传说 | `#ffc46b` | rgba(255,196,107,0.3) |
| 神话 | `#ff78c5` | rgba(255,120,197,0.3) |

### 种族色（原版 50+ 种族映射）
神祗=#FFF 龙族=#FFD700 龙裔=#FFA500 血族=#DC143C 亡灵=#32CD32 翼民=#00BFFF 堕羽民=#9370DB 女妖=#FF1493 人类=#FFDAB9 矮人=#D2691E 精灵=#00FF7F 妖精=#FF0F 兽族=#FF4500 黑角民=#00CED1 蛇女=#00FF7F 人鱼=#0FF 深渊魔族=#9400D3 魔物=#8A2BE2 构装体=#00CED1 元素生物=#F00 植物生物=#0F0 其他=#E0E0E0 ...

## 全局约束
- 用原版精确色值（hex），存入组件内常量
- 不要粒子 Canvas、不要 SVG 边框装饰（那是全屏专属）
- 品质色 glow 必须加 text-shadow
- 层级色驱动左边框色和 tier badge 色
- 种族色驱动身份标签和区段标题的装饰色
- 五维属性用小图标，不用五边形 clip-path（卡片空间不够）
- 技能/装备显示参照原版 card 结构：card-header（名字+品质）+ card-body（tags/类型/消耗/效果/描述）

---

## Task 1: 写 CharGenSystemCard 完整重写

**Files:**
- Modify: `src/ui/components/game/cards/CharGenSystemCard.vue` — 完全重写
- Create: `tests/ui/components/CharGenSystemCard.test.ts` — 更新测试

**Interfaces:**
- Props: `{ event: CharGenSystemEvent }`
- 无 emit

### 重写内容

#### 1. 色彩常量（组件内 script）

```typescript
import { ref, computed } from 'vue'
import type { CharGenSystemEvent } from '@engine/types'
import { qualityVar } from '../../../lib/quality-colors'

// 层级色映射（原版精确值）
const TIER_COLORS: Record<number, string> = {
  1: '#57595D', 2: '#50C878', 3: '#2196F3',
  4: '#9932CC', 5: '#FFD700', 6: '#DC143C', 7: '#00FFFF',
}

// 种族色映射（原版精确值，50+ 条目）
const RACE_COLORS: Record<string, string> = {
  '人类': '#FFDAB9', '矮人': '#D2691E', '精灵': '#00FF7F',
  '极北精灵': '#00FF7F', '暗夜精灵': '#9370DB', '半精灵': '#90EE90',
  '龙族': '#FFD700', '龙姬': '#FFD700', '龙裔': '#FFA500', '巨龙': '#FFD700',
  '古龙': '#FFD700', '亚龙': '#FFAE42', '半龙人': '#FFAE42',
  '血姬': '#FF0000', '血族': '#DC143C',
  '兽族': '#FF4500', '半兽人': '#FF8C00', '半人马': '#FF8C00',
  '翼民': '#00BFFF', '翼族': '#00BFFF', '堕羽民': '#9370DB',
  '人鱼': '#00FFFF', '蛇女': '#00FF7F', '汐海妖精': '#00FFFF', '宁芙': '#FF00FF',
  '妖精': '#FF00FF', '光翅妖精': '#FFFF00',
  '地精': '#32CD32', '半身人': '#FFD700',
  '黑角民': '#00CED1', '女妖': '#FF1493',
  '亡灵种族': '#32CD32', '不死生物': '#32CD32',
  '深渊魔族': '#9400D3', '魔物': '#8A2BE2',
  '巨人': '#D2691E', '半巨人': '#D2691E', '小巨人': '#D2691E',
  '霜巨人': '#00BFFF', '山妖': '#DAA520', '食人魔': '#7CFC00', '巨魔': '#7CFC00',
  '雪怪': '#E0FFFF',
  '神祗': '#FFFFFF', '英灵': '#00BFFF', '从者': '#00BFFF', '诗灵': '#EE82EE',
  '构装体': '#00CED1', '人造生物': '#00FF7F',
  '元素生物': '#FF0000', '植物生物': '#00FF00', '不定形生物': '#7CFC00',
  '异域生物': '#FF00FF', '泰坦人族': '#FFD700',
}

// 种族色查找（支持模糊匹配）
function getRaceColor(race: string): string {
  for (const [key, color] of Object.entries(RACE_COLORS)) {
    if (race.includes(key)) return color
  }
  return '#E0E0E0' // 默认灰
}

// 层级色
function getTierColor(tier: number): string {
  return TIER_COLORS[tier] ?? '#57595D'
}

// 品质 → CSS 类名（含 glow）
function qualityGlowClass(quality?: string): string {
  if (!quality) return ''
  const q = quality.toLowerCase()
  if (q.includes('神话')) return 'ql-mythic'
  if (q.includes('传说')) return 'ql-legendary'
  if (q.includes('史诗')) return 'ql-epic'
  if (q.includes('稀有')) return 'ql-rare'
  if (q.includes('优良')) return 'ql-uncommon'
  if (q.includes('普通')) return 'ql-common'
  return ''
}

// 五维属性图标
const ATTR_ICONS: Record<string, string> = {
  str: 'fa-solid fa-dumbbell',
  dex: 'fa-solid fa-bolt',
  con: 'fa-solid fa-shield-heart',
  int: 'fa-solid fa-brain',
  spi: 'fa-solid fa-star',
}
const ATTR_COLORS: Record<string, string> = {
  str: '#fc8181', dex: '#68d391', con: '#f6ad55',
  int: '#63b3ed', spi: '#b794f4',
}
```

#### 2. HTML 结构

参照原版 char_info 的 card-wrapper 风格，但适配为卡片尺寸：

```html
<div class="ci-card" :style="{ borderColor: tierColor }">
  <!-- ═══ Header: 名字 + 等级 + 层级 ─ 参照原版 sheet-header ═══ -->
  <div class="ci-header" @click="expanded = !expanded">
    <div class="ci-header-main">
      <span v-if="event.details.level" class="ci-level-badge" :style="{ borderColor: tierColor, color: tierColor }">
        Lv.{{ event.details.level }}
      </span>
      <span class="ci-name">{{ event.characterName }}</span>
    </div>
    <div class="ci-header-meta">
      <span class="ci-race" :style="{ color: raceColor }">{{ event.race }}</span>
      <span class="ci-tier-badge" :style="{ background: tierColor }">T{{ event.tier }}</span>
      <i class="fa-solid ci-chevron" :class="expanded ? 'fa-chevron-up' : 'fa-chevron-down'" />
    </div>
  </div>

  <!-- ═══ Body: 展开后显示 ═══ -->
  <div v-show="expanded" class="ci-body">
    <!-- A. 五维属性 — 参照原版 attributes-grid -->
    <div v-if="event.details.attributes" class="ci-attrs">
      <div v-for="(val, key) in event.details.attributes" :key="key" class="ci-attr" :style="{ color: ATTR_COLORS[key] ?? '#fff' }">
        <i :class="ATTR_ICONS[key] ?? 'fa-solid fa-circle'" class="ci-attr-icon" />
        <span class="ci-attr-name">{{ key.toUpperCase() }}</span>
        <span class="ci-attr-val">{{ val }}</span>
      </div>
    </div>

    <!-- B. 身份标签 — 参照原版 card-tags -->
    <div v-if="event.details.identity?.length" class="ci-section">
      <div class="ci-chips">
        <span v-for="tag in event.details.identity" :key="tag" class="ci-chip ci-chip-id" :style="{ borderColor: raceColor, color: raceColor }">
          {{ tag }}
        </span>
      </div>
    </div>

    <!-- C. 势力（如果有） -->
    <div v-if="event.details.faction" class="ci-section ci-section-divider">
      <div class="ci-kv">
        <span class="ci-kv-label">势力</span>
        <span class="ci-kv-value">{{ event.details.faction }}</span>
      </div>
    </div>

    <!-- D. 职业标签 -->
    <div v-if="event.details.occupation?.length" class="ci-section ci-section-divider">
      <div class="ci-chips">
        <span v-for="occ in event.details.occupation" :key="occ" class="ci-chip ci-chip-occ">{{ occ }}</span>
      </div>
    </div>

    <!-- E. 背景故事 — 参照原版 story panel -->
    <div v-if="event.details.background" class="ci-section ci-section-divider">
      <p class="ci-bg">{{ event.details.background.slice(0, 250) }}{{ event.details.background.length > 250 ? '…' : '' }}</p>
    </div>

    <!-- F. 技能列表 — 参照原版 card 结构 -->
    <div v-if="event.details.skills?.length" class="ci-section ci-section-divider">
      <h4 class="ci-sec-title" :style="{ borderColor: raceColor }">技能</h4>
      <div v-for="sk in event.details.skills" :key="sk.name" class="ci-item-card" :style="{ borderColor: raceColor }">
        <div class="ci-item-header">
          <span class="ci-item-name" :class="qualityGlowClass(sk.effects ? '稀有' : undefined)">{{ sk.name }}</span>
          <span class="ci-item-type-badge">{{ sk.type === 'active' ? '主动' : '被动' }}</span>
        </div>
        <div class="ci-item-body">
          <span v-if="sk.cost" class="ci-cost">消耗 {{ sk.cost.type }} {{ sk.cost.amount }}</span>
          <span v-if="sk.cooldown" class="ci-cool">CD {{ sk.cooldown }}回合</span>
          <p class="ci-item-desc">{{ sk.description?.slice(0, 150) }}</p>
        </div>
      </div>
    </div>

    <!-- G. 装备列表 -->
    <div v-if="event.details.equipment?.length" class="ci-section ci-section-divider">
      <h4 class="ci-sec-title" :style="{ borderColor: raceColor }">装备</h4>
      <div v-for="eq in event.details.equipment" :key="eq.name" class="ci-item-card ci-equip" :style="{ borderColor: raceColor }">
        <div class="ci-item-header">
          <span class="ci-equip-slot">{{ eq.slot }}</span>
          <span class="ci-item-name" :class="qualityGlowClass(eq.quality)">{{ eq.name }}</span>
        </div>
        <div class="ci-item-body">
          <p class="ci-item-desc">{{ eq.description?.slice(0, 120) }}</p>
          <div v-if="eq.stats && Object.keys(eq.stats).length" class="ci-stats">
            <span v-for="(v, k) in eq.stats" :key="k" class="ci-stat">{{ k }}+{{ v }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- H. 登神长阶 — 参照原版 divinity-card -->
    <div v-if="event.details.ascension?.enabled && event.details.ascension?.path" class="ci-section ci-section-divider">
      <h4 class="ci-sec-title ci-sec-dao" :style="{ borderColor: tierColor, color: tierColor }">登神长阶</h4>
      <p class="ci-dao-path">{{ event.details.ascension.path }}</p>
      <p v-if="event.details.ascension.description" class="ci-item-desc">{{ event.details.ascension.description.slice(0, 150) }}</p>
    </div>
  </div>
</div>
```

#### 3. CSS — 复刻原版色彩和风格

```css
/* ═══ 卡片骨架（参照原版 card-wrapper 但更紧凑） ═══ */
.ci-card {
  border-radius: 6px;
  overflow: hidden;
  background: linear-gradient(180deg, rgba(16,21,32,0.92), rgba(10,14,23,0.95));
  border: 1px solid var(--theme-card-border);
  border-left: 4px solid; /* 层级色驱动 */
  box-shadow: 0 0 16px rgba(0,0,0,0.3),
              0 0 32px rgba(var(--tier-glow), 0.08); /* 微弱的层级色外围发光 */
}

/* ═══ Header ─ 参照原版 sheet-header ═══ */
.ci-header {
  padding: 12px 14px 10px;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.ci-header:hover { background: rgba(255,255,255,0.03); }

.ci-header-main { display: flex; align-items: baseline; gap: 8px; }
.ci-header-meta { display: flex; align-items: center; gap: 8px; }

/* 等级徽章 ─ 参照原版 level-badge */
.ci-level-badge {
  padding: 2px 8px;
  border-radius: 3px;
  border: 1px solid;
  font-size: 0.6875rem;
  font-weight: 700;
  text-shadow: 0 0 6px currentColor;
}

/* 名字 ─ 参照原版 char-name（缩小版） */
.ci-name {
  font-family: 'Cinzel', 'Noto Serif SC', serif;
  font-size: 1.0625rem;
  font-weight: 700;
  color: #fff;
  text-shadow: 0 0 10px rgba(255,255,255,0.15);
}

/* 种族 ─ 种族色文字 */
.ci-race {
  font-size: 0.75rem;
  opacity: 0.85;
  font-weight: 500;
}

/* 层级徽章 ─ 层级色背景 + 白字 */
.ci-tier-badge {
  padding: 2px 8px;
  border-radius: 3px;
  color: #fff;
  font-size: 0.6875rem;
  font-weight: 700;
}

/* Chevron */
.ci-chevron { font-size: 0.625rem; opacity: 0.4; }

/* ═══ Body ═══ */
.ci-body {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 0;
}

/* ═══ 五维属性 ─ 参照原版 attributes-grid（简化） ═══ */
.ci-attrs {
  display: flex;
  gap: 14px;
  justify-content: center;
  padding: 0 0 12px;
}
.ci-attr {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 0.8125rem;
  font-weight: 700;
}
.ci-attr-icon { font-size: 0.625rem; opacity: 0.6; width: 0.75rem; text-align: center; }
.ci-attr-name { font-size: 0.5625rem; opacity: 0.5; text-transform: uppercase; font-weight: 500; }
.ci-attr-val { min-width: 1.25rem; text-align: center; }

/* ═══ Section ─ 参照原版分割 ═══ */
.ci-section { padding: 10px 0; }
.ci-section-divider { border-top: 1px dashed rgba(255,255,255,0.08); }

/* Section 标题 ─ 参照原版 subsection-title（左下3px种族色边框） */
.ci-sec-title {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--theme-text-secondary);
  margin: 0 0 8px;
  padding-left: 8px;
  border-left: 3px solid;
}
.ci-sec-dao { color: inherit; } /* 登神标题用层级色 */

/* ═══ Chip ─ 参照原版 card-tag ═══ */
.ci-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.ci-chip {
  padding: 3px 10px;
  border-radius: 4px;
  font-size: 0.6875rem;
  font-weight: 500;
}
.ci-chip-id {
  background: rgba(255,255,255,0.04);
  border: 1px solid;
  /* borderColor 和 color 由 raceColor 动态设置 */
}
.ci-chip-occ {
  background: var(--theme-surface-muted);
  color: var(--theme-text-secondary);
  border: 1px solid var(--theme-card-border);
}

/* ═══ KV 行 ═══ */
.ci-kv { display: flex; align-items: center; gap: 8px; font-size: 0.8125rem; }
.ci-kv-label { font-weight: 600; opacity: 0.5; font-size: 0.75rem; }
.ci-kv-value { color: var(--theme-text-primary); }

/* ═══ 背景故事 ─ 参照原版 story panel ═══ */
.ci-bg {
  font-size: 0.75rem;
  line-height: 1.6;
  opacity: 0.75;
  white-space: pre-line;
  margin: 0;
  color: var(--theme-text-secondary);
}

/* ═══ 技能/装备卡片 ─ 参照原版 .card ═══ */
.ci-item-card {
  border-left: 3px solid; /* 种族色 */
  background: rgba(255,255,255,0.02);
  border-radius: 4px;
  padding: 8px 10px;
  margin-bottom: 6px;
}
.ci-item-card:last-child { margin-bottom: 0; }

/* item header ─ 参照原版 card-header */
.ci-item-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.ci-item-name {
  font-weight: 700;
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
}
/* 品质色发光 ─ 参照原版 quality-* classes */
.ql-mythic { color: #ff78c5 !important; text-shadow: 0 0 8px rgba(255,120,197,0.3); }
.ql-legendary { color: #ffc46b !important; text-shadow: 0 0 8px rgba(255,196,107,0.3); }
.ql-epic { color: #cf95ff !important; text-shadow: 0 0 8px rgba(207,149,255,0.3); }
.ql-rare { color: #62bbff !important; text-shadow: 0 0 8px rgba(98,187,255,0.3); }
.ql-uncommon { color: #7be495 !important; text-shadow: 0 0 8px rgba(123,228,149,0.28); }
.ql-common { color: #c4cad3 !important; }

/* item type badge */
.ci-item-type-badge {
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 0.625rem;
  background: var(--theme-surface-muted);
  color: var(--theme-text-muted);
  border: 1px solid var(--theme-card-border);
}

/* item body */
.ci-item-body { font-size: 0.75rem; color: var(--theme-text-secondary); }
.ci-cost, .ci-cool {
  display: inline-block;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 0.625rem;
  background: rgba(255,255,255,0.06);
  color: var(--theme-text-muted);
  margin-right: 4px;
}
.ci-item-desc { opacity: 0.65; margin: 4px 0 0; line-height: 1.5; }

/* 装备 slot ─ 参照原版 effect-name pill */
.ci-equip-slot {
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 0.625rem;
  font-weight: 600;
  background: var(--theme-primary);
  color: #fff;
}

/* 数值 stat */
.ci-stats { display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
.ci-stat {
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 0.625rem;
  background: rgba(255,255,255,0.06);
  border: 1px solid var(--theme-card-border);
  color: var(--theme-text-secondary);
  font-family: monospace;
}

/* ═══ 登神长阶 ─ 参照原版 divinity-card ═══ */
.ci-dao-path {
  font-weight: 600;
  font-size: 0.875rem;
  margin: 0 0 4px;
}
```

#### 4. 测试更新

```typescript
// tests/ui/components/CharGenSystemCard.test.ts
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CharGenSystemCard from '../../../src/ui/components/game/cards/CharGenSystemCard.vue'
import type { CharGenSystemEvent } from '@engine/types'

describe('CharGenSystemCard', () => {
  const mockFull: CharGenSystemEvent = {
    type: 'char_gen',
    characterName: '艾琳·霜语', race: '极北精灵', tier: 3,
    narrative: '[新角色] 艾琳·霜语',
    details: {
      name: '艾琳·霜语', race: '极北精灵', gender: '女',
      faction: '诺斯加德联盟', tier: 3, level: 12,
      attributes: { str: 5, dex: 8, con: 4, int: 9, spi: 10 },
      identity: ['霜语者', '冰原巡行者', '龙族后裔'],
      occupation: ['元素法师', '符文工匠'],
      background: '艾琳出身于极北冰原的霜语氏族，自幼便能听见寒风中传来的古老低语...',
      appearance: '', clothing: '', personality: '', likes: '',
      ascension: { enabled: true, path: '冰霜之道 — 极寒主宰', description: '掌控绝对零度之力', elements: [], authorities: [], laws: [], deityPosition: '', divineKingdom: { name: '', description: '' } },
      skills: [
        { name: '冰霜箭矢', description: '凝聚水汽形成冰箭，造成冰霜伤害并降低目标速度。', type: 'active', cost: { type: 'MP', amount: 15 }, cooldown: 2 },
        { name: '寒冰护体', description: '被动凝聚寒气形成护盾，减免20%伤害并反弹冰霜。', type: 'passive' },
      ],
      equipment: [
        { slot: '主手', name: '霜语法杖', description: '千年冰晶法杖', stats: { int: 4, spi: 3 }, quality: '稀有' },
      ],
      inventory: [],
    },
  }

  const mockMinimal: CharGenSystemEvent = {
    type: 'char_gen',
    characterName: '无名旅者', race: '人类', tier: 1,
    narrative: '[新角色]',
    details: {
      name: '无名旅者', race: '人类', gender: '男', tier: 1, level: 1,
      attributes: { str: 3, dex: 3, con: 3, int: 3, spi: 3 },
      identity: [], occupation: [], background: '',
      appearance: '', clothing: '', personality: '', likes: '',
      ascension: { enabled: false, path: '', description: '', elements: [], authorities: [], laws: [], deityPosition: '', divineKingdom: { name: '', description: '' } },
      skills: [], equipment: [], inventory: [],
    },
  }

  // ── 基本渲染 ──
  it('renders name and race', () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } })
    expect(w.text()).toContain('艾琳·霜语')
    expect(w.text()).toContain('极北精灵')
  })
  it('renders level badge', () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } })
    expect(w.text()).toContain('Lv.12')
  })
  it('renders tier badge', () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } })
    expect(w.text()).toContain('T3')
  })

  // ── 折叠 ──
  it('starts collapsed (body hidden)', () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } })
    expect(w.find('.ci-body').isVisible()).toBe(false)
  })
  it('click header to expand', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } })
    await w.find('.ci-header').trigger('click')
    expect(w.find('.ci-body').isVisible()).toBe(true)
  })

  // ── 展开内容 ──
  it('renders all 5 attributes', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } })
    await w.find('.ci-header').trigger('click')
    expect(w.text()).toContain('5')  // STR
    expect(w.text()).toContain('10') // SPI
  })
  it('renders identity chips', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } })
    await w.find('.ci-header').trigger('click')
    expect(w.text()).toContain('霜语者')
  })
  it('renders faction', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } })
    await w.find('.ci-header').trigger('click')
    expect(w.text()).toContain('诺斯加德联盟')
  })
  it('renders background excerpt', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } })
    await w.find('.ci-header').trigger('click')
    expect(w.text()).toContain('霜语氏族')
  })
  it('renders skill names and types', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } })
    await w.find('.ci-header').trigger('click')
    expect(w.text()).toContain('冰霜箭矢')
    expect(w.text()).toContain('主动')
    expect(w.text()).toContain('寒冰护体')
    expect(w.text()).toContain('被动')
  })
  it('renders equipment slot and name', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } })
    await w.find('.ci-header').trigger('click')
    expect(w.text()).toContain('主手')
    expect(w.text()).toContain('霜语法杖')
  })
  it('renders ascension when enabled', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } })
    await w.find('.ci-header').trigger('click')
    expect(w.text()).toContain('登神长阶')
    expect(w.text()).toContain('冰霜之道')
  })

  // ── 防御性渲染 ──
  it('hides background when empty', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockMinimal } })
    await w.find('.ci-header').trigger('click')
    // background 为空不应渲染
    const bg = w.find('.ci-bg')
    expect(bg.exists()).toBe(false)
  })
  it('hides skills section when empty', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockMinimal } })
    await w.find('.ci-header').trigger('click')
    expect(w.text()).not.toContain('技能')
  })
  it('hides ascension when disabled', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockMinimal } })
    await w.find('.ci-header').trigger('click')
    expect(w.text()).not.toContain('登神长阶')
  })
})
```

### 完成后验证
```bash
npx vitest run tests/ui/components/CharGenSystemCard.test.ts  # 16 tests 通过
npm run typecheck  # 零错误
npm run test -- --run  # 全量通过
```
