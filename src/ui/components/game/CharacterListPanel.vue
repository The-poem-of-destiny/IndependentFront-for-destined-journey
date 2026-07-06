<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useGameStore } from '../../stores/game-store'
import { getAffectionLabel } from '@engine/affection-system'
import ResourceBar from '../shared/ResourceBar.vue'
import BuffChip from '../shared/BuffChip.vue'

const game = useGameStore()

// ═══ 品质色 ═══
const qualityColors: Record<string, string> = {
  '普通': '#9ca3af', '优良': '#22c55e', '稀有': '#3b82f6',
  '史诗': '#8b5cf6', '传说': '#f59e0b', '神话': '#ef4444', '唯一': '#f97316',
}

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
function getAffection(npcId: string): number { return affections.value[npcId] ?? 0 }
function getAffectionLabelText(npcId: string): string {
  const v = getAffection(npcId)
  if (v === 0) return ''
  return getAffectionLabel(v)
}
function affectionPercent(npcId: string): number {
  const v = getAffection(npcId)
  return ((v + 100) / 200) * 100  // -100→0%, 0→50%, 100→100%
}

// ═══ 详情 Tab 数据 ═══
const selEquipment = computed(() => (selected.value as any)?.equipment || [])
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
          <div class="npc-affection" v-if="getAffection(npc.id) !== 0">
            <div class="aff-bar"><div class="aff-fill" :style="{ width: affectionPercent(npc.id) + '%' }" /></div>
            <div class="aff-text" :class="{ positive: getAffection(npc.id) > 0, negative: getAffection(npc.id) < 0 }">{{ getAffectionLabelText(npc.id) }} {{ getAffection(npc.id) }}</div>
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
          <span v-if="getAffection(selected.id) !== 0" class="d-aff-label" :class="{ positive: getAffection(selected.id) > 0, negative: getAffection(selected.id) < 0 }">
            {{ getAffectionLabelText(selected.id) }} {{ getAffection(selected.id) }}
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
            <div class="ov-card" v-if="getAffection(selected.id) !== 0">
              <div class="ov-card-title">好感度</div>
              <div class="aff-bar-row">
                <div class="aff-track"><div class="aff-track-fill" :style="{ width: affectionPercent(selected.id) + '%' }" /></div>
                <span class="aff-num" :class="{ positive: getAffection(selected.id) > 0, negative: getAffection(selected.id) < 0 }">{{ getAffection(selected.id) }}</span>
                <span class="aff-label-text" :class="{ positive: getAffection(selected.id) > 0, negative: getAffection(selected.id) < 0 }">{{ getAffectionLabelText(selected.id) }}</span>
              </div>
            </div>

            <!-- 心里话卡片 -->
            <div class="ov-card" v-if="(selected as any).customFields?.thoughts">
              <div class="ov-card-title">心里话</div>
              <p class="ov-thoughts">{{ (selected as any).customFields.thoughts }}</p>
            </div>

            <!-- 基础信息卡片 -->
            <div class="ov-card">
              <div class="ov-card-title">基础信息</div>
              <div class="ov-info-grid">
                <div class="ov-kv"><span>种族</span><span>{{ selected.race }}</span></div>
                <div class="ov-kv"><span>身份</span><span>{{ selected.identity?.join(' / ') || '—' }}</span></div>
                <div class="ov-kv"><span>职业</span><span>{{ selected.occupation?.join(' / ') || '—' }}</span></div>
                <div class="ov-kv"><span>所在地</span><span class="ov-long">{{ selected.location || '未知' }}</span></div>
                <div class="ov-kv" v-if="(selected as any).customFields?.gender"><span>性别</span><span>{{ (selected as any).customFields.gender }}</span></div>
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

            <!-- 详情列表: 外观/着装 → 特征/背景 -->
            <div class="ov-detail-list">
              <template v-if="(selected as any).customFields?.appearance || (selected as any).customFields?.outfit">
                <div class="ov-dl-item" v-if="(selected as any).customFields?.appearance">
                  <span class="ov-dl-label">外貌</span>
                  <span class="ov-dl-text">{{ (selected as any).customFields.appearance }}</span>
                </div>
                <div class="ov-dl-item" v-if="(selected as any).customFields?.outfit">
                  <span class="ov-dl-label">着装</span>
                  <span class="ov-dl-text">{{ (selected as any).customFields.outfit }}</span>
                </div>
                <div class="ov-dl-divider" />
              </template>
              <div class="ov-dl-item" v-if="(selected as any).customFields?.trait">
                <span class="ov-dl-label">特征</span>
                <span class="ov-dl-text">{{ (selected as any).customFields.trait }}</span>
              </div>
              <div class="ov-dl-item" v-if="(selected as any).customFields?.background || selected.description">
                <span class="ov-dl-label">背景</span>
                <span class="ov-dl-text">{{ (selected as any).customFields?.background || selected.description }}</span>
              </div>
            </div>
          </template>

          <!-- 状态 -->
          <template v-if="detailTab === 'status'">
            <div v-if="!((selected as any)?.statusEffects?.length)" class="empty-tab">该角色暂无状态效果</div>
            <div v-else class="status-list">
              <div v-for="fx in (selected as any).statusEffects" :key="fx.id" class="status-row" @click="selStatusInspected = (selStatusInspected === fx.id ? null : fx.id)">
                <BuffChip :name="fx.name" :type="fx.category === '增益' ? 'buff' : fx.category === '减益' ? 'debuff' : 'special'" :stacks="fx.stacks" />
                <span class="st-time" v-if="fx.remainingTime === null">永久</span>
                <span class="st-time" v-else-if="fx.remainingTime < 999">{{ fx.remainingTime }}{{ fx.timeUnit }}</span>
              </div>
            </div>
            <div class="st-detail" v-if="selStatusInspected && (selected as any)?.statusEffects?.find((f:any) => f.id === selStatusInspected)">
              <template v-for="fx in [(selected as any).statusEffects.find((f:any) => f.id === selStatusInspected)]" :key="fx.id">
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
            <div v-for="eq in selEquipment" :key="eq.itemId" class="equip-card">
              <div class="eq-header">
                <span class="eq-name" :style="{ color: qualityColors[inferQuality(eq.stats)] }">{{ eq.name }}</span>
                <span class="eq-slot">[{{ eq.slot === 'weapon' ? '武器' : eq.slot === 'armor' ? '防具' : '饰品' }}]</span>
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
            <div v-for="sk in selSkills" :key="sk.id" class="skill-card">
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
          <button class="script-toggle" @click="showScripts = !showScripts">📜 {{ showScripts ? '收起脚本' : '查看脚本' }}</button>
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
.char-panel { display: flex; flex-direction: column; gap: 10px; min-height: 37.5rem; }

/* FP */
.fp-bar { display: flex; align-items: center; justify-content: space-between; padding: 6px 12px; background: var(--theme-surface-muted); border-radius: 6px; }
.fp-label { font-size: 0.75rem; color: var(--theme-text-muted); }
.fp-value { font-size: 1rem; color: #c084fc; font-weight: 700; display: flex; align-items: center; gap: 6px; }
.fp-value i { font-size: 0.875rem; }

/* Master-Detail */
.master-detail { display: flex; gap: 14px; min-height: 31.25rem; }
.npc-list { width: 20rem; flex-shrink: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; max-height: 42.5rem; border-right: 1px solid var(--theme-card-border); padding-right: 10px; }

/* NPC 卡片 */
.npc-card { display: flex; gap: 10px; padding: 10px; border-radius: 6px; cursor: pointer; border: 1px solid var(--theme-card-border); background: var(--theme-card-bg); align-items: flex-start; }
.npc-card:hover { background: var(--theme-surface-muted); }
.npc-card.selected { border-color: var(--theme-primary); background: var(--theme-tab-hover-bg); }
.npc-avatar { width: 2.5rem; height: 2.5rem; border-radius: 50%; background: var(--theme-primary-bg); color: var(--theme-primary-text); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 1rem; flex-shrink: 0; font-family: var(--theme-font-title, 'Cinzel', serif); }
.npc-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.npc-name { font-weight: 700; font-size: 0.875rem; color: var(--theme-text-primary); }
.npc-meta { font-size: 0.6875rem; color: var(--theme-text-secondary); }
.npc-loc { font-size: 0.625rem; color: var(--theme-text-muted); display: flex; align-items: center; gap: 3px; }
.npc-tags { display: flex; gap: 4px; margin-top: 2px; }
.tag { font-size: 0.625rem; padding: 1px 6px; border-radius: 3px; background: var(--theme-surface-muted); color: var(--theme-text-secondary); }
.npc-affection { margin-top: 4px; }
.aff-bar { height: 4px; background: var(--theme-surface-muted); border-radius: 2px; overflow: hidden; margin-bottom: 2px; }
.aff-fill { height: 100%; background: #c084fc; border-radius: 2px; }
.aff-text { font-size: 0.625rem; text-align: right; }
.aff-text.positive { color: #a78bfa; }
.aff-text.negative { color: #ef4444; }

/* 详情 */
.detail { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; max-height: 42.5rem; }
.d-header { display: flex; gap: 12px; align-items: center; }
.d-avatar { width: 3rem; height: 3rem; border-radius: 50%; background: var(--theme-primary-bg); color: var(--theme-primary-text); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 1.25rem; flex-shrink: 0; font-family: var(--theme-font-title, 'Cinzel', serif); }
.d-name { font-size: 1.0625rem; font-weight: 700; color: var(--theme-text-primary); font-family: var(--theme-font-title, 'Cinzel', serif); }
.d-meta { font-size: 0.75rem; color: var(--theme-text-secondary); }
.d-tier { font-size: 0.75rem; color: var(--theme-quality-epic, #8b5cf6); }
.d-tags-row { display: flex; gap: 6px; align-items: center; }
.dtag { font-size: 0.6875rem; padding: 2px 8px; border-radius: 3px; background: var(--theme-surface-muted); color: var(--theme-text-secondary); }
.d-aff-label { font-size: 0.75rem; font-weight: 600; }
.d-aff-label.positive { color: #a78bfa; }
.d-aff-label.negative { color: #ef4444; }

/* Tab */
.tab-row { display: flex; gap: 3px; border-bottom: 1px solid var(--theme-card-border); padding-bottom: 6px; }
.tab-row button { padding: 6px 12px; border: none; background: none; color: var(--theme-text-secondary); font-size: 0.75rem; cursor: pointer; font-family: inherit; border-radius: 4px; }
.tab-row button.active { background: var(--theme-primary-bg); color: var(--theme-primary-text); font-weight: 600; }
.tab-content { flex: 1; overflow-y: auto; }

/* ═══ 概览卡片 ═══ */
.ov-card { background: var(--theme-card-bg); border: 1px solid var(--theme-card-border); border-radius: 8px; padding: 10px 12px; }
.ov-card + .ov-card { margin-top: 8px; }
.ov-card-title { font-size: 0.6875rem; color: var(--theme-text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; font-weight: 600; }

/* 好感度 */
.aff-bar-row { display: flex; align-items: center; gap: 8px; }
.aff-track { flex: 1; height: 8px; background: var(--theme-surface-muted); border-radius: 4px; overflow: hidden; }
.aff-track-fill { height: 100%; background: #c084fc; border-radius: 4px; transition: width 0.3s; }
.aff-num { font-size: 1rem; font-weight: 700; }
.aff-num.positive { color: #a78bfa; }
.aff-num.negative { color: #ef4444; }
.aff-label-text { font-size: 0.75rem; font-weight: 600; }
.aff-label-text.positive { color: #a78bfa; }
.aff-label-text.negative { color: #ef4444; }

/* 心里话 */
.ov-thoughts { font-size: 0.8125rem; color: var(--theme-text-secondary); line-height: 1.6; font-style: italic; margin: 0; }

/* 基础信息 */
.ov-info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; }
.ov-kv { display: flex; justify-content: space-between; align-items: baseline; padding: 4px 0; font-size: 0.8125rem; }
.ov-kv span:first-child { color: var(--theme-text-muted); font-size: 0.6875rem; flex-shrink: 0; margin-right: 8px; }
.ov-kv span:last-child { color: var(--theme-text-primary); text-align: right; }
.ov-long { font-size: 0.6875rem !important; max-width: 11.25rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 属性 */
.ov-attr-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
.ov-attr { background: var(--theme-surface-muted); border-radius: 4px; padding: 6px 10px; display: flex; justify-content: space-between; align-items: center; }
.ov-attr span:first-child { font-size: 0.6875rem; color: var(--theme-text-muted); }
.ov-attr span:last-child { font-size: 0.9375rem; font-weight: 700; color: var(--theme-text-primary); }
.ov-resources { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; padding-right: 4px; }

/* 详情列表 */
.ov-detail-list { margin-top: 8px; }
.ov-dl-item { display: flex; gap: 12px; padding: 8px 0; align-items: flex-start; }
.ov-dl-label { font-size: 0.75rem; color: var(--theme-text-muted); min-width: 2.5rem; flex-shrink: 0; font-weight: 500; }
.ov-dl-text { font-size: 0.8125rem; color: var(--theme-text-primary); line-height: 1.5; }
.ov-dl-divider { border-top: 1px solid var(--theme-card-border); margin: 0; }

/* 装备卡片 */
.equip-card, .skill-card { padding: 8px; background: var(--theme-surface-muted); border-radius: 4px; margin-bottom: 6px; }
.eq-header, .sk-header { display: flex; align-items: center; gap: 8px; }
.eq-name, .sk-name { font-weight: 600; font-size: 0.8125rem; }
.eq-slot, .sk-tag { font-size: 0.625rem; color: var(--theme-text-muted); }
.eq-desc, .sk-desc { font-size: 0.75rem; color: var(--theme-text-secondary); margin-top: 4px; }
.eq-meta { font-size: 0.625rem; color: var(--theme-text-muted); margin-top: 4px; }
.sk-cost { font-size: 0.6875rem; color: var(--theme-text-muted); margin-top: 2px; }

/* 效果 */
.fx-list { margin-top: 4px; }
.fx-row { display: flex; gap: 8px; padding: 1px 0; font-size: 0.75rem; }
.fx-n { color: var(--theme-text-secondary); font-weight: 500; min-width: 60px; }
.fx-d { color: var(--theme-text-primary); }

.d-label { font-size: 0.625rem; color: var(--theme-text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
.asc-section { margin-bottom: 8px; }
.asc-item { font-size: 0.75rem; color: var(--theme-text-primary); padding: 2px 0; }

/* 脚本 */
.script-section { margin-top: auto; border-top: 1px solid var(--theme-card-border); padding-top: 6px; }
.script-toggle { padding: 5px 12px; border: 1px solid var(--theme-card-border); background: var(--theme-surface-muted); color: var(--theme-text-muted); font-size: 0.6875rem; cursor: pointer; font-family: inherit; border-radius: 4px; }
.script-toggle:hover { color: var(--theme-text-primary); }
.script-body { margin-top: 6px; }
.script-block { margin-bottom: 6px; }
.script-label { font-size: 0.6875rem; color: var(--theme-accent, #f59e0b); font-weight: 600; margin-bottom: 2px; }
.script-code { background: #0d1117; color: #c9d1d9; font-family: 'Cascadia Code', monospace; font-size: 0.625rem; padding: 8px; border-radius: 4px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; margin: 0; max-height: 8.75rem; overflow-y: auto; }
.script-empty { font-size: 0.6875rem; color: var(--theme-text-muted); font-style: italic; }

.empty-tab { padding: 24px; text-align: center; color: var(--theme-text-muted); font-size: 0.8125rem; }

/* 状态 Tab */
.status-list { display: flex; flex-wrap: wrap; gap: 4px; max-height: 9.375rem; overflow-y: auto; }
.status-row { display: flex; align-items: center; gap: 4px; cursor: pointer; }
.st-time { font-size: 0.625rem; color: var(--theme-text-muted); }
.st-detail { margin-top: 8px; padding: 8px 10px; background: var(--theme-surface-muted); border-radius: 6px; border-left: 3px solid var(--theme-primary); }
.st-d-name { font-size: 0.8125rem; font-weight: 700; color: var(--theme-text-primary); }
.st-d-desc { font-size: 0.75rem; color: var(--theme-text-secondary); margin-top: 2px; }
.st-d-meta { display: flex; gap: 12px; margin-top: 6px; font-size: 0.6875rem; color: var(--theme-text-muted); }
.detail-empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--theme-text-muted); font-size: 0.875rem; }
.empty { padding: 40px; text-align: center; color: var(--theme-text-muted); font-size: 0.875rem; }
</style>
