<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useGameStore } from '../../stores/game-store'
import { getAffectionLabel } from '@engine/affection-system'
import { qualityVar } from '../../lib/quality-colors'
import ResourceBar from '../shared/ResourceBar.vue'
import BuffChip from '../shared/BuffChip.vue'

const game = useGameStore()

// ═══ 品质推断 ═══
function inferQuality(stats?: Record<string, number>): string {
  if (!stats) return '普通'
  const total = Object.values(stats).reduce((s, v) => s + Math.abs(v), 0)
  if (total >= 50) return '传说'; if (total >= 30) return '史诗'
  if (total >= 20) return '稀有'; if (total >= 10) return '优良'
  return '普通'
}

// ═══ NPC 列表 ═══
const selectedIdx = ref(0)
const showScripts = ref(false)
const detailTab = ref<'equipment' | 'skills' | 'overview' | 'ascension' | 'status'>('overview')
const selStatusInspected = ref<string | null>(null)

const npcs = computed(() => game.npcs || [])
const fp = computed(() => game.fp)
const affections = computed(() => game.saveProfile?.affections || {})
const contracts = computed(() => game.saveProfile?.contracts || [])
const playerLoc = computed(() => game.player?.location || '')

const selected = computed(() => npcs.value[selectedIdx.value] || null)

watch(() => npcs.value.length, () => { selectedIdx.value = 0; showScripts.value = false })

// ═══ NPC 标签 ═══
function getTags(npc: any): string[] {
  const tags: string[] = []
  if (npc.location && playerLoc.value.startsWith(npc.location.split('-').slice(0, 2).join('-'))) { tags.push('在场') }
  if (contracts.value.some((c: any) => c.targetId === npc.id)) { tags.push('契约') }
  return tags
}

// ═══ 好感度 ═══
// M6 收官修: profile.affections 自 M2/M5 起按角色名 key（rename_character 随迁），UUID 索引恒 0（#15 读点收口）
function getAffection(npcName: string): number { return affections.value[npcName] ?? 0 }
function getAffectionLabelText(npcName: string): string {
  const v = getAffection(npcName)
  if (v === 0) return ''
  return getAffectionLabel(v)
}
function affectionPercent(npcName: string): number {
  const v = getAffection(npcName)
  return ((v + 100) / 200) * 100  // -100→0%, 0→50%, 100→100%
}

// ═══ 详情 Tab 数据 ═══
// M6 完整重构: 装备 = inventory 中 equippedSlot 非空的物品（规范 §3），最小适配 filter 惯用式
const selEquipment = computed(() => ((selected.value as any)?.inventory || []).filter((i: any) => i.equippedSlot))
const selSkills = computed(() => (selected.value as any)?.skills || [])
const selEffects = computed(() => {
  const tab = detailTab.value
  if (tab === 'equipment') {
    const item = selEquipment.value[0]  // show first item's effects
    return item?.effects as Record<string, string> | undefined
  }
  if (tab === 'skills') {
    const skill = selSkills.value[0]
    return skill?.effects as Record<string, string> | undefined
  }
  return undefined
})
const selScripts = computed(() => {
  const tab = detailTab.value
  if (tab === 'equipment') return (selEquipment.value[0] as any)?.scripts as Record<string, string> | undefined
  if (tab === 'skills') return (selSkills.value[0] as any)?.scripts as Record<string, string> | undefined
  return undefined
})
const hasScripts = computed(() => selScripts.value && Object.keys(selScripts.value).length > 0)
</script>

<template>
  <div class="char-panel" v-if="npcs.length > 0">
    <!-- FP 点数 -->
    <div class="fp-bar">
      <span class="fp-label">命运点数</span>
      <span class="fp-value"><i class="fa-solid fa-gem" /> {{ fp }}</span>
    </div>

    <!-- Master-Detail -->
    <div class="master-detail">
      <!-- 左: NPC 列表 -->
      <div class="npc-list">
        <div v-for="(npc, i) in npcs" :key="npc.id" class="npc-card" :class="{ selected: i === selectedIdx }" @click="selectedIdx = i; detailTab = 'overview'; showScripts = false">
          <div class="npc-avatar">{{ npc.name[0] }}</div>
          <div class="npc-info">
            <div class="npc-name">{{ npc.name }}</div>
            <div class="npc-meta">{{ npc.race }} · {{ npc.tierName }} · Lv.{{ npc.level }}</div>
            <div class="npc-loc" v-if="npc.location"><i class="fa-solid fa-location-dot" /> {{ npc.location.split('-').pop() }}</div>
            <div class="npc-tags" v-if="getTags(npc).length">
              <span v-for="t in getTags(npc)" :key="t" class="tag">{{ t }}</span>
            </div>
          </div>
          <div class="npc-affection" v-if="getAffection(npc.name) !== 0">
            <div class="aff-bar"><div class="aff-fill" :style="{ transform: `scaleX(${affectionPercent(npc.name) / 100})` }" /></div>
            <div class="aff-text" :class="{ positive: getAffection(npc.name) > 0, negative: getAffection(npc.name) < 0 }">{{ getAffectionLabelText(npc.name) }} {{ getAffection(npc.name) }}</div>
          </div>
        </div>
      </div>

      <!-- 右: 详情 -->
      <div class="detail" v-if="selected">
        <div class="d-header">
          <div class="d-avatar">{{ selected.name[0] }}</div>
          <div>
            <div class="d-name">{{ selected.name }}</div>
            <div class="d-meta">{{ selected.race }} · {{ selected.occupation?.join(' / ') || selected.identity?.join(' / ') || '未知' }}</div>
            <div class="d-tier">{{ selected.tierName }} · Lv.{{ selected.level }}</div>
          </div>
        </div>

        <!-- 标签 + 好感度 -->
        <div class="d-tags-row">
          <span v-for="t in getTags(selected)" :key="t" class="dtag">{{ t }}</span>
          <span v-if="getAffection(selected.name) !== 0" class="d-aff-label" :class="{ positive: getAffection(selected.name) > 0, negative: getAffection(selected.name) < 0 }">
            {{ getAffectionLabelText(selected.name) }} {{ getAffection(selected.name) }}
          </span>
        </div>

        <!-- 详情 Tab -->
        <div class="tab-row">
          <button :class="{ active: detailTab === 'overview' }" @click="detailTab = 'overview'; showScripts = false">概览</button>
          <button :class="{ active: detailTab === 'status' }" @click="detailTab = 'status'; showScripts = false">状态 {{ (selected as any)?.statusEffects?.length || 0 }}</button>
          <button :class="{ active: detailTab === 'equipment' }" @click="detailTab = 'equipment'; showScripts = false">装备 {{ selEquipment.length }}</button>
          <button :class="{ active: detailTab === 'skills' }" @click="detailTab = 'skills'; showScripts = false">技能 {{ selSkills.length }}</button>
          <button :class="{ active: detailTab === 'ascension' }" @click="detailTab = 'ascension'; showScripts = false">登神</button>
        </div>

        <!-- Tab 内容 -->
        <div class="tab-content">
          <!-- 属性 -->
          <template v-if="detailTab === 'overview'">
            <!-- 好感度卡片 -->
            <div class="ov-card" v-if="getAffection(selected.name) !== 0">
              <div class="ov-card-title">好感度</div>
              <div class="aff-bar-row">
                <div class="aff-track"><div class="aff-track-fill" :style="{ transform: `scaleX(${affectionPercent(selected.name) / 100})` }" /></div>
                <span class="aff-num" :class="{ positive: getAffection(selected.name) > 0, negative: getAffection(selected.name) < 0 }">{{ getAffection(selected.name) }}</span>
                <span class="aff-label-text" :class="{ positive: getAffection(selected.name) > 0, negative: getAffection(selected.name) < 0 }">{{ getAffectionLabelText(selected.name) }}</span>
              </div>
            </div>

            <!-- 心里话卡片 — 唯一真源 CharacterState.thoughts 正式字段（M6 T1） -->
            <div class="ov-card" v-if="game.getThoughts(selected)">
              <div class="ov-card-title">心里话</div>
              <p class="ov-thoughts">{{ game.getThoughts(selected) }}</p>
            </div>

            <!-- 基础信息卡片 -->
            <div class="ov-card">
              <div class="ov-card-title">基础信息</div>
              <div class="ov-info-grid">
                <div class="ov-kv"><span>种族</span><span>{{ selected.race }}</span></div>
                <div class="ov-kv"><span>身份</span><span>{{ selected.identity?.join(' / ') || '—' }}</span></div>
                <div class="ov-kv"><span>职业</span><span>{{ selected.occupation?.join(' / ') || '—' }}</span></div>
                <div class="ov-kv"><span>所在地</span><span class="ov-long">{{ selected.location || '未知' }}</span></div>
                <div class="ov-kv" v-if="selected.gender"><span>性别</span><span>{{ selected.gender }}</span></div>
                <div class="ov-kv" v-if="(selected as any).customFields?.age"><span>年龄</span><span>{{ (selected as any).customFields.age }}</span></div>
              </div>
            </div>

            <!-- 属性卡片 -->
            <div class="ov-card">
              <div class="ov-card-title">属性</div>
              <div class="ov-attr-grid">
                <div class="ov-attr"><span>力量</span><span>{{ selected.attributes.str }}</span></div>
                <div class="ov-attr"><span>敏捷</span><span>{{ selected.attributes.dex }}</span></div>
                <div class="ov-attr"><span>体质</span><span>{{ selected.attributes.con }}</span></div>
                <div class="ov-attr"><span>智力</span><span>{{ selected.attributes.int }}</span></div>
                <div class="ov-attr"><span>精神</span><span>{{ selected.attributes.spi }}</span></div>
                <div class="ov-attr" v-if="selected.freeAttrPoints"><span>自由点</span><span>{{ selected.freeAttrPoints }}</span></div>
              </div>

              <div class="ov-resources">
                <ResourceBar label="HP" :current="selected.hp" :max="selected.maxHp" color="color-mix(in srgb, var(--theme-hp) 65%, #000)" :height="22" :showValues="true" />
                <ResourceBar label="MP" :current="selected.mp" :max="selected.maxMp" color="color-mix(in srgb, var(--theme-mp) 65%, #000)" :height="22" :showValues="true" />
                <ResourceBar label="SP" :current="selected.sp" :max="selected.maxSp" color="color-mix(in srgb, var(--theme-sp) 65%, #000)" :height="22" :showValues="true" />
              </div>
            </div>

            <!-- 详情列表: 外观/着装 → 性格/背景（M6 T1: 读正式字段，trait→personality） -->
            <div class="ov-detail-list">
              <template v-if="selected.appearance || selected.outfit">
                <div class="ov-dl-item" v-if="selected.appearance">
                  <span class="ov-dl-label">外貌</span>
                  <span class="ov-dl-text">{{ selected.appearance }}</span>
                </div>
                <div class="ov-dl-item" v-if="selected.outfit">
                  <span class="ov-dl-label">着装</span>
                  <span class="ov-dl-text">{{ selected.outfit }}</span>
                </div>
                <div class="ov-dl-divider" />
              </template>
              <div class="ov-dl-item" v-if="selected.personality">
                <span class="ov-dl-label">特征</span>
                <span class="ov-dl-text">{{ selected.personality }}</span>
              </div>
              <div class="ov-dl-item" v-if="selected.background || selected.description">
                <span class="ov-dl-label">背景</span>
                <span class="ov-dl-text">{{ selected.background || selected.description }}</span>
              </div>
            </div>
          </template>

          <!-- 状态 -->
          <template v-if="detailTab === 'status'">
            <div v-if="!((selected as any)?.statusEffects?.length)" class="empty-tab">该角色暂无状态效果</div>
            <div v-else class="status-list">
              <div v-for="fx in (selected as any).statusEffects" :key="fx.name" class="status-row" @click="selStatusInspected = (selStatusInspected === fx.name ? null : fx.name)">
                <BuffChip :name="fx.name" :type="fx.category === '增益' ? 'buff' : fx.category === '减益' ? 'debuff' : 'special'" :stacks="fx.stacks" />
                <span class="st-time" v-if="fx.remainingTime === null">永久</span>
                <span class="st-time" v-else-if="fx.remainingTime < 999">{{ fx.remainingTime }}{{ fx.timeUnit }}</span>
              </div>
            </div>
            <div class="st-detail" v-if="selStatusInspected && (selected as any)?.statusEffects?.find((f:any) => f.name === selStatusInspected)">
              <template v-for="fx in [(selected as any).statusEffects.find((f:any) => f.name === selStatusInspected)]" :key="fx.name">
                <div class="st-d-name">{{ fx.name }}</div>
                <div class="st-d-desc">{{ fx.description }}</div>
                <div class="st-d-meta">
                  <span>层数: {{ fx.stacks }}<span v-if="fx.maxStacks">/{{ fx.maxStacks }}</span></span>
                  <span>剩余: {{ fx.remainingTime === null ? '永久' : fx.remainingTime + fx.timeUnit }}</span>
                  <span>来源: {{ fx.source }}</span>
                </div>
              </template>
            </div>
          </template>

          <!-- 装备 -->
          <template v-if="detailTab === 'equipment'">
            <div v-if="selEquipment.length === 0" class="empty-tab">暂无装备</div>
            <div v-for="eq in selEquipment" :key="eq.name" class="equip-card">
              <div class="eq-header">
                <span class="eq-name" :style="{ color: qualityVar(inferQuality(eq.stats)) }">{{ eq.name }}</span>
                <span class="eq-slot">[{{ eq.equippedSlot }}]</span>
              </div>
              <div class="eq-desc" v-if="eq.description">{{ eq.description }}</div>
              <div class="fx-list" v-if="eq.effects && Object.keys(eq.effects).length">
                <div v-for="(desc, name) in eq.effects" :key="name" class="fx-row"><span class="fx-n">{{ name }}</span><span class="fx-d">{{ desc }}</span></div>
              </div>
              <div class="eq-meta" v-if="eq.durability">耐久 {{ eq.durability }}/{{ eq.maxDurability }}</div>
            </div>
          </template>

          <!-- 技能 -->
          <template v-if="detailTab === 'skills'">
            <div v-if="selSkills.length === 0" class="empty-tab">暂无技能</div>
            <div v-for="sk in selSkills" :key="sk.name" class="skill-card">
              <div class="sk-header">
                <span class="sk-name">{{ sk.name }}</span>
                <span class="sk-tag">{{ sk.type === 'active' ? '主动' : '被动' }} Lv.{{ sk.level }}</span>
              </div>
              <div class="sk-cost" v-if="sk.cost">{{ sk.cost.amount }} {{ sk.cost.type }}{{ sk.cooldown ? ` · 冷却 ${sk.cooldown}回合` : '' }}</div>
              <div class="sk-desc" v-if="sk.description">{{ sk.description }}</div>
              <div class="fx-list" v-if="sk.effects && Object.keys(sk.effects).length">
                <div v-for="(desc, name) in sk.effects" :key="name" class="fx-row"><span class="fx-n">{{ name }}</span><span class="fx-d">{{ desc }}</span></div>
              </div>
            </div>
          </template>

          <!-- 登神 -->
          <template v-if="detailTab === 'ascension'">
            <div class="empty-tab" v-if="!selected.ascension?.enabled">该角色未开启登神长阶</div>
            <template v-else>
              <div class="asc-section" v-if="Object.keys(selected.ascension.elements || {}).length">
                <div class="d-label">要素</div>
                <div v-for="(v, k) in selected.ascension.elements" :key="k" class="asc-item">{{ k }}: {{ (v as any).description || JSON.stringify(v) }}</div>
              </div>
              <div class="asc-section" v-if="Object.keys(selected.ascension.authority || {}).length">
                <div class="d-label">权能</div>
                <div v-for="(v, k) in selected.ascension.authority" :key="k" class="asc-item">{{ k }}: {{ (v as any).description || JSON.stringify(v) }}</div>
              </div>
              <div class="asc-section" v-if="Object.keys(selected.ascension.law || {}).length">
                <div class="d-label">法则</div>
                <div v-for="(v, k) in selected.ascension.law" :key="k" class="asc-item">{{ k }}: {{ (v as any).description || JSON.stringify(v) }}</div>
              </div>
              <div v-if="selected.ascension.deityPosition"><span class="d-label">神位</span> {{ selected.ascension.deityPosition }}</div>
            </template>
          </template>

          <!-- 背景 -->
        </div>

        <!-- 脚本 (装备/技能 tab 时显示) -->
        <div class="script-section" v-if="detailTab === 'equipment' || detailTab === 'skills'">
          <button class="script-toggle" @click="showScripts = !showScripts">{{ showScripts ? '收起脚本' : '查看脚本' }}</button>
          <div class="script-body" v-if="showScripts">
            <template v-if="hasScripts">
              <div v-for="(code, name) in selScripts" :key="name" class="script-block">
                <div class="script-label">{{ name }}</div>
                <pre class="script-code">{{ code }}</pre>
              </div>
            </template>
            <div class="script-empty" v-else>(该物品无脚本效果)</div>
          </div>
        </div>
      </div>
      <div class="detail-empty" v-else>选择一个角色查看详情</div>
    </div>
  </div>
  <div class="empty" v-else>暂无角色数据</div>
</template>

<style scoped>
/* ═══ 根 — 书页面板 ═══ */
.char-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 37.5rem;
  --paper-stack: 0 1px 0 0 color-mix(in srgb, var(--theme-card-border) 40%, transparent),
                 0 4px 12px rgba(0,0,0,0.08);
}

/* ═══ FP 卷首 ═══ */
.fp-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: color-mix(in srgb, var(--theme-card-bg) 92%, var(--theme-surface-muted) 8%);
  border-radius: var(--theme-radius-md, 6px);
  box-shadow: var(--paper-stack);
  border-bottom: 2px solid #c084fc;
}
.fp-label {
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.fp-value {
  font-size: 1.125rem;
  color: #c084fc;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--theme-font-title, 'Cinzel', serif);
}
.fp-value i { font-size: 0.875rem; }

/* ═══ Master-Detail ═══ */
.master-detail { display: flex; gap: 16px; min-height: 31.25rem; }

/* ═══ 左: NPC 卡片列表 ═══ */
.npc-list {
  width: 18rem;
  flex-shrink: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 42.5rem;
  padding: 10px;
  background: var(--theme-card-bg);
  border-radius: var(--theme-radius-md, 6px);
  box-shadow: var(--paper-stack);
}

/* NPC 卡片 — 书页纸牌 */
.npc-card {
  display: flex;
  gap: 10px;
  padding: 10px;
  border-radius: var(--theme-radius-sm, 4px);
  cursor: pointer;
  border: 1px solid var(--theme-card-border);
  background: var(--theme-card-bg);
  align-items: flex-start;
  transition: background 0.12s, border-color 0.15s, box-shadow 0.15s;
}
.npc-card:hover {
  background: var(--theme-surface-muted);
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}
.npc-card.selected {
  border-color: var(--theme-primary);
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  box-shadow: 0 0 0 1px var(--theme-primary),
              0 0 12px color-mix(in srgb, var(--theme-primary) 25%, transparent);
}
.npc-avatar {
  width: 2.5rem; height: 2.5rem;
  border-radius: 50%;
  background: var(--theme-primary-bg);
  color: var(--theme-primary-text);
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 1rem; flex-shrink: 0;
  font-family: var(--theme-font-title, 'Cinzel', serif);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 30%, transparent);
}
.npc-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.npc-name {
  font-weight: 700; font-size: 0.875rem; color: var(--theme-text-primary);
  font-family: var(--theme-font-title, 'Cinzel', serif);
}
.npc-meta { font-size: 0.625rem; color: var(--theme-text-secondary); }
.npc-loc {
  font-size: 0.625rem; color: var(--theme-text-muted);
  display: flex; align-items: center; gap: 3px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.npc-tags { display: flex; gap: 4px; margin-top: 2px; }
.tag {
  font-size: 0.5625rem; padding: 1px 6px; border-radius: 3px;
  background: var(--theme-surface-muted); color: var(--theme-text-secondary);
  text-transform: uppercase; letter-spacing: 0.04em;
}
.npc-affection { margin-top: 4px; width: 5rem; flex-shrink: 0; }
.aff-bar { height: 4px; background: var(--theme-surface-muted); border-radius: 2px; overflow: hidden; margin-bottom: 2px; }
.aff-fill { width: 100%; height: 100%; background: var(--theme-quality-epic); border-radius: 2px; transform-origin: left; transition: transform 0.3s ease-out; }
.aff-text { font-size: 0.5625rem; text-align: right; white-space: nowrap; }
.aff-text.positive { color: var(--theme-quality-epic); }
.aff-text.negative { color: var(--theme-error); }

/* ═══ 右: 角色详情 — 书卷内页 ═══ */
.detail {
  flex: 1; overflow-y: auto;
  display: flex; flex-direction: column; gap: 8px;
  max-height: 42.5rem;
  padding: 16px;
  background: var(--theme-card-bg);
  border-radius: var(--theme-radius-md, 6px);
  box-shadow: var(--paper-stack);
}
.d-header { display: flex; gap: 14px; align-items: center; padding-bottom: 10px; border-bottom: 2px solid var(--theme-card-border); }
.d-avatar {
  width: 3.5rem; height: 3.5rem;
  border-radius: 50%;
  background: var(--theme-primary-bg);
  color: var(--theme-primary-text);
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 1.5rem; flex-shrink: 0;
  font-family: var(--theme-font-title, 'Cinzel', serif);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--theme-primary) 35%, transparent);
}
.d-name {
  font-size: 1.125rem; font-weight: 700; color: var(--theme-text-primary);
  font-family: var(--theme-font-title, 'Cinzel', serif);
}
.d-meta { font-size: 0.75rem; color: var(--theme-text-secondary); }
.d-tier { font-size: 0.75rem; color: var(--theme-quality-epic, #8b5cf6); font-weight: 600; }
.d-tags-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.dtag {
  font-size: 0.625rem; padding: 2px 8px; border-radius: 3px;
  background: var(--theme-surface-muted); color: var(--theme-text-secondary);
  text-transform: uppercase; letter-spacing: 0.04em;
}
.d-aff-label { font-size: 0.75rem; font-weight: 600; }
.d-aff-label.positive { color: #a78bfa; }
.d-aff-label.negative { color: #ef4444; }

/* ═══ Tab — 书签导航 ═══ */
.tab-row {
  display: flex; gap: 0;
  border-bottom: 2px solid var(--theme-card-border);
  padding-bottom: 0;
}
.tab-row button {
  padding: 7px 14px;
  border: none; border-bottom: 2px solid transparent;
  background: none;
  color: var(--theme-text-muted);
  font-size: 0.75rem; cursor: pointer;
  font-family: var(--theme-font-title, 'Cinzel', serif);
  letter-spacing: 0.03em;
  transition: color 0.2s, border-color 0.2s;
  margin-bottom: -2px;
}
.tab-row button:hover { color: var(--theme-text-secondary); }
.tab-row button.active {
  color: var(--theme-text-primary);
  border-bottom-color: var(--theme-primary);
  font-weight: 600;
}
.tab-content { flex: 1; overflow-y: auto; padding-top: 10px; }

/* ═══ 概览卡片 ═══ */
.ov-card {
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 4px);
  padding: 12px 14px;
}
.ov-card + .ov-card { margin-top: 8px; }
.ov-card-title {
  font-size: 0.625rem; color: var(--theme-text-muted);
  text-transform: uppercase; letter-spacing: 0.08em;
  margin-bottom: 10px; font-weight: 600;
  display: flex; align-items: center; gap: 8px;
}
.ov-card-title::after {
  content: '';
  flex: 1; height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}

/* 好感度 */
.aff-bar-row { display: flex; align-items: center; gap: 8px; }
.aff-track { flex: 1; height: 6px; background: var(--theme-surface-muted); border-radius: 3px; overflow: hidden; }
.aff-track-fill { width: 100%; height: 100%; background: var(--theme-quality-epic); border-radius: 3px; transform-origin: left; transition: transform 0.3s ease-out; }
.aff-num { font-size: 1rem; font-weight: 700; }
.aff-num.positive { color: var(--theme-quality-epic); }
.aff-num.negative { color: var(--theme-error); }
.aff-label-text { font-size: 0.75rem; font-weight: 600; }
.aff-label-text.positive { color: #a78bfa; }
.aff-label-text.negative { color: #ef4444; }

/* 心里话 */
.ov-thoughts {
  font-size: 0.8125rem; color: var(--theme-text-secondary);
  line-height: 1.7; font-style: italic; margin: 0;
}

/* 基础信息 */
.ov-info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 14px; }
.ov-kv {
  display: flex; justify-content: space-between; align-items: baseline;
  padding: 5px 0; font-size: 0.8125rem;
  border-bottom: 1px solid color-mix(in srgb, var(--theme-card-border) 35%, transparent);
}
.ov-kv span:first-child { color: var(--theme-text-muted); font-size: 0.6875rem; flex-shrink: 0; margin-right: 8px; }
.ov-kv span:last-child { color: var(--theme-text-primary); text-align: right; }
.ov-long { font-size: 0.6875rem !important; max-width: 11.25rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 属性 */
.ov-attr-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
.ov-attr {
  background: var(--theme-card-bg);
  border-radius: var(--theme-radius-sm, 4px);
  padding: 7px 10px;
  display: flex; justify-content: space-between; align-items: center;
  border: 1px solid var(--theme-card-border);
}
.ov-attr span:first-child { font-size: 0.625rem; color: var(--theme-text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.ov-attr span:last-child { font-size: 0.9375rem; font-weight: 700; color: var(--theme-text-primary); font-variant-numeric: tabular-nums; }
.ov-resources { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; padding-right: 4px; }

/* 详情列表 */
.ov-detail-list { margin-top: 8px; }
.ov-dl-item { display: flex; gap: 12px; padding: 8px 0; align-items: flex-start; }
.ov-dl-item + .ov-dl-item { border-top: 1px solid color-mix(in srgb, var(--theme-card-border) 40%, transparent); }
.ov-dl-label { font-size: 0.6875rem; color: var(--theme-text-muted); min-width: 2.5rem; flex-shrink: 0; font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; }
.ov-dl-text { font-size: 0.8125rem; color: var(--theme-text-primary); line-height: 1.6; }
.ov-dl-divider { border-top: 1px solid var(--theme-card-border); margin: 4px 0; opacity: 0.5; }

/* 装备/技能卡片 */
.equip-card, .skill-card {
  padding: 10px;
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-sm, 4px);
  margin-bottom: 6px;
  border: 1px solid var(--theme-card-border);
}
.eq-header, .sk-header { display: flex; align-items: center; gap: 8px; }
.eq-name, .sk-name {
  font-weight: 600; font-size: 0.8125rem;
  font-family: var(--theme-font-title, 'Cinzel', serif);
}
.eq-slot, .sk-tag {
  font-size: 0.625rem; color: var(--theme-text-muted);
  text-transform: uppercase; letter-spacing: 0.04em;
}
.eq-desc, .sk-desc { font-size: 0.75rem; color: var(--theme-text-secondary); margin-top: 6px; line-height: 1.5; }
.eq-meta { font-size: 0.625rem; color: var(--theme-text-muted); margin-top: 4px; }
.sk-cost { font-size: 0.6875rem; color: var(--theme-text-muted); margin-top: 4px; }

/* 效果 */
.fx-list { margin-top: 6px; }
.fx-row { display: flex; gap: 8px; padding: 2px 0; font-size: 0.75rem; }
.fx-n { color: var(--theme-text-secondary); font-weight: 500; min-width: 3.75rem; }
.fx-d { color: var(--theme-text-primary); }

.d-label {
  font-size: 0.625rem; color: var(--theme-text-muted);
  text-transform: uppercase; letter-spacing: 0.08em;
  margin-bottom: 4px; font-weight: 600;
  display: flex; align-items: center; gap: 6px;
}
.d-label::after {
  content: '';
  flex: 1; height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}
.asc-section { margin-bottom: 8px; }
.asc-item { font-size: 0.75rem; color: var(--theme-text-primary); padding: 2px 0; }

/* 脚本 */
.script-section { margin-top: auto; border-top: 1px solid var(--theme-card-border); padding-top: 6px; }
.script-toggle {
  padding: 5px 10px;
  border: 1px solid var(--theme-card-border);
  background: var(--theme-surface-muted);
  color: var(--theme-text-muted);
  font-size: 0.6875rem; cursor: pointer;
  font-family: inherit;
  border-radius: var(--theme-radius-sm, 4px);
  transition: color 0.15s;
}
.script-toggle:hover { color: var(--theme-text-primary); }
.script-body { margin-top: 6px; }
.script-block { margin-bottom: 6px; }
.script-label { font-size: 0.6875rem; color: var(--theme-accent, #f59e0b); font-weight: 600; margin-bottom: 2px; }
.script-code {
  background: #0d1117; color: #c9d1d9;
  font-family: 'Cascadia Code', monospace; font-size: 0.625rem;
  padding: 8px; border-radius: var(--theme-radius-sm, 4px);
  overflow-x: auto; white-space: pre-wrap; word-break: break-all;
  margin: 0; max-height: 8.75rem; overflow-y: auto;
}
.script-empty { font-size: 0.6875rem; color: var(--theme-text-muted); font-style: italic; }

/* 空态 */
.empty-tab { padding: 32px 0; text-align: center; color: var(--theme-text-muted); font-size: 0.8125rem; font-style: italic; }
.empty-tab::before {
  content: '—';
  display: block;
  margin-bottom: 8px;
  font-size: 1.25rem;
  opacity: 0.3;
}

/* 状态 Tab */
.status-list { display: flex; flex-wrap: wrap; gap: 6px; max-height: 9.375rem; overflow-y: auto; }
.status-row {
  display: flex; align-items: center; gap: 4px; cursor: pointer;
  padding: 4px 8px; border-radius: var(--theme-radius-sm, 4px);
  border: 1px solid transparent;
  transition: border-color 0.12s;
}
.status-row:hover { border-color: var(--theme-card-border); }
.st-time { font-size: 0.625rem; color: var(--theme-text-muted); }
.st-detail {
  margin-top: 8px; padding: 10px 12px;
  background: color-mix(in srgb, var(--theme-primary) 6%, var(--theme-surface-muted));
  border-radius: var(--theme-radius-md, 6px);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 25%, var(--theme-card-border));
}
.st-d-name { font-size: 0.8125rem; font-weight: 700; color: var(--theme-text-primary); }
.st-d-desc { font-size: 0.75rem; color: var(--theme-text-secondary); margin-top: 4px; line-height: 1.5; }
.st-d-meta { display: flex; gap: 14px; margin-top: 6px; font-size: 0.6875rem; color: var(--theme-text-muted); }

/* 未选择 / 空态 */
.detail-empty {
  flex: 1;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 12px;
  color: var(--theme-text-muted);
  font-size: 0.875rem; font-style: italic;
  background: var(--theme-card-bg);
  border-radius: var(--theme-radius-md, 6px);
  box-shadow: var(--paper-stack);
}
.detail-empty::before {
  content: '';
  display: block;
  width: 48px; height: 1px;
  background: linear-gradient(to right, transparent, var(--theme-text-muted), transparent);
  opacity: 0.3;
}
.empty { padding: 48px 0; text-align: center; color: var(--theme-text-muted); font-size: 0.875rem; font-style: italic; }
</style>
