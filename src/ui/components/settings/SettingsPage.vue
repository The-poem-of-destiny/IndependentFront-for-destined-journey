<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { useThemeStore } from '../../stores/theme-store'
import { useUIStore } from '../../stores/ui-store'
import { useSettingsStore, type ApiEntry, type PresetItem } from '../../stores/settings-store'
import AppButton from '../shared/AppButton.vue'
import AppCard from '../shared/AppCard.vue'
import AppModal from '../shared/AppModal.vue'
import WorldBookEditor from './WorldBookEditor.vue'
import type { WorldBook } from '@engine/types'
import { VERSION } from '@engine/index'

const theme = useThemeStore()
const ui = useUIStore()
const cfg = useSettingsStore()
const s = cfg.settings  // 短别名，模板里用 s.xxx

// ============================================================
// 主导航
// ============================================================
type Section = 'api' | 'agent' | 'worldbook' | 'plot' | 'memory' | 'theme' | 'data' | 'about'
const activeSection = ref<Section>('api')

const navItems: { key: Section; label: string; icon: string }[] = [
  { key: 'api', label: 'API 配置', icon: 'fa-solid fa-plug' },
  { key: 'agent', label: 'Agent 配置', icon: 'fa-solid fa-robot' },
  { key: 'worldbook', label: '世界书', icon: 'fa-solid fa-book-open' },
  { key: 'plot', label: '剧情系统', icon: 'fa-solid fa-scroll' },
  { key: 'memory', label: '记忆 & 缓存', icon: 'fa-solid fa-brain' },
  { key: 'theme', label: '外观主题', icon: 'fa-solid fa-palette' },
  { key: 'data', label: '存档数据', icon: 'fa-solid fa-database' },
  { key: 'about', label: '关于', icon: 'fa-solid fa-circle-info' },
]

// ============================================================
// API 池（存于 settings-store，自动持久化）
// ============================================================
const hasApi = computed(() => s.apiPool.length > 0)
const showAddApi = ref(false)
const apiForm = reactive({ name: '', baseUrl: '', apiKey: '', model: '' })
const apiModels = ref<string[]>([])
const apiFormTesting = ref(false)
const apiFormFetchingModels = ref(false)
const editingApiId = ref<string | null>(null)

function maskKey(key: string): string { if (!key || key.length < 8) return key ? key.slice(0,3)+'***' : ''; return key.slice(0,3)+'***'+key.slice(-4) }
	async function testApiAndFetch() { if(!apiForm.baseUrl||!apiForm.apiKey)return; apiFormTesting.value=true; const realKey=apiForm.apiKey; try{const r=await new Promise((ok,rej)=>{const x=new XMLHttpRequest();x.open("POST","/api/proxy/"+encodeURIComponent(apiForm.baseUrl+"/chat/completions"));x.setRequestHeader("Content-Type","application/json");x.setRequestHeader("Authorization","Bearer "+realKey);x.timeout=15000;x.onload=()=>{if(x.status>=200&&x.status<300)ok(x);else rej(new Error(x.status+" "+x.responseText.slice(0,100)))};x.onerror=()=>rej(new Error("network error"));x.ontimeout=()=>rej(new Error("timeout"));x.send(JSON.stringify({model:apiForm.model||"default",messages:[{role:"user",content:"hi"}],max_tokens:1}))});apiForm.apiKey=maskKey(realKey);apiForm._realKey=realKey;ui.toast("ok","success");await fetchModelList()}catch(e){ui.toast("fail: "+(e.message||"").slice(0,60),"error")} apiFormTesting.value=false }
	async function fetchModelList() { apiFormFetchingModels.value=true; const rk=apiForm._realKey||apiForm.apiKey; try{const r=await new Promise((ok,rej)=>{const x=new XMLHttpRequest();x.open("GET","/api/proxy/"+encodeURIComponent(apiForm.baseUrl+"/models"));x.setRequestHeader("Authorization","Bearer "+rk);x.timeout=10000;x.onload=()=>{if(x.status>=200&&x.status<300)ok(x);else rej(new Error(x.status+" "+x.responseText.slice(0,100)))};x.onerror=()=>rej(new Error("network error"));x.ontimeout=()=>rej(new Error("timeout"));x.send()});const d=JSON.parse(r.responseText);apiModels.value=(d.data||[]).map(function(m){return m.id}).filter(Boolean);if(apiModels.value.length>0)apiForm.model=apiModels.value[0];ui.toast("got "+apiModels.value.length+" models","success")}catch(e){ui.toast("err: "+(e.message||"").slice(0,60),"error")} apiFormFetchingModels.value=false }
function openAddApi() { editingApiId.value=null; apiForm.name='';apiForm.baseUrl='';apiForm.apiKey='';apiForm.model='';apiModels.value=[];showAddApi.value=true }
function openEditApi(ep: ApiEntry) { editingApiId.value=ep.id;apiForm.name=ep.name;apiForm.baseUrl=ep.baseUrl;apiForm.apiKey=ep.apiKey||'';apiForm.model=ep.model;apiModels.value=ep.models?.length?ep.models:[ep.model].filter(Boolean);showAddApi.value=true }
	function saveApi() { const realKey=apiForm._realKey||apiForm.apiKey; const e: ApiEntry = {id:editingApiId.value||crypto.randomUUID(),name:apiForm.name,baseUrl:apiForm.baseUrl,apiKey:realKey,maskedKey:maskKey(realKey),model:apiForm.model,models:apiModels.value.length>0?apiModels.value:[apiForm.model].filter(Boolean)};if(editingApiId.value){const i=s.apiPool.findIndex(x=>x.id===editingApiId.value);if(i>=0)s.apiPool[i]=e}else s.apiPool.push(e);showAddApi.value=false;editingApiId.value=null;ui.toast(editingApiId.value?"API updated":"API added","success") }
function deleteApi(id:string) { s.apiPool = s.apiPool.filter(e=>e.id!==id);ui.toast('API 已删除','info') }

// ============================================================
// Agent 配置
// ============================================================
const agentList = [
  { id:'memory_recall', name:'记忆召回', desc:'根据用户输入从记忆库中 Embedding 召回相关记忆', stage:0 },
  { id:'plot_pre_check', name:'剧情预检', desc:'正文前检查需要触发的剧情事件和背景', stage:0 },
  { id:'story', name:'正文生成', desc:'核心叙事 Agent，生成游戏正文内容', stage:1 },
  { id:'craft_gen', name:'制作生成', desc:'处理制作意图，调用 $craft 工具生成创意效果', stage:1 },
  { id:'vars_update', name:'变量更新', desc:'解析 Story 输出，提取变量变更生成 StatePatch', stage:2 },
  { id:'char_update', name:'角色更新', desc:'检测新 NPC 并更新角色状态', stage:3 },
  { id:'char_gen', name:'角色生成', desc:'生成新 NPC 的五维属性、背景和登神长阶', stage:3 },
  { id:'item_gen', name:'物品生成', desc:'为 NPC 生成装备、技能和道具', stage:3 },
  { id:'memory_summary', name:'记忆总结', desc:'生成本轮记忆摘要并计算 Embedding', stage:4 },
  { id:'plot_post_check', name:'剧情修正', desc:'正文后检查世界线变动，修正剧情大纲', stage:5 },
  { id:'plot_outline', name:'大纲生成', desc:'主线/支线模式下生成剧情大纲和事件树', stage:5 },
]
const activeAgent = ref<string | null>(s.activeAgent)

// Phase 8: 世界书编辑
const activeWorldBook = ref<WorldBook | null>(null)

// Agent 配置全部从 settings-store 读写，自动持久化
const agentPromptDraft = ref('')
// 初始化时从 store 恢复 agent 提示词
if (activeAgent.value && s.agentPrompts[activeAgent.value]) {
  agentPromptDraft.value = s.agentPrompts[activeAgent.value]
}

// ============================================================
// 预设系统（正文 Agent 专用）
// ============================================================
const activePreset = computed(() => s.presets.find((p: PresetItem) => p.id === s.activePresetId) || null)

// 条目展开/折叠
const expandedEntries = ref(new Set<string>())
function toggleEntry(presetId: string, idx: number) {
  const key = `${presetId}:${idx}`
  if (expandedEntries.value.has(key)) expandedEntries.value.delete(key)
  else expandedEntries.value.add(key)
}

// 条目编辑弹窗
const showEntryEditor = ref(false)
const editingEntryIdx = ref(-1)
const editingEntryPresetId = ref('')
const entryEditForm = reactive({ name: '', content: '', enabled: true, role: 'system' })

function openEntryEditor(presetId: string, idx: number) {
  const p = s.presets.find((x: PresetItem) => x.id === presetId)
  if (!p?.settings?.prompts?.[idx]) return
  const sp = p.settings.prompts[idx]
  editingEntryPresetId.value = presetId
  editingEntryIdx.value = idx
  entryEditForm.name = sp.name || ''
  entryEditForm.content = sp.content || ''
  entryEditForm.enabled = sp.enabled !== false
  entryEditForm.role = sp.role || 'system'
  showEntryEditor.value = true
}

async function saveEntry() {
  const p = s.presets.find((x: PresetItem) => x.id === editingEntryPresetId.value)
  if (!p) return
  const idx = editingEntryIdx.value
  const prompts = [...(p.settings.prompts || [])]
  if (prompts[idx]) {
    prompts[idx] = { ...prompts[idx], name: entryEditForm.name, content: entryEditForm.content, enabled: entryEditForm.enabled, role: entryEditForm.role }
    const updated = { ...p, settings: { ...p.settings, prompts }, updatedAt: Date.now() }
    const { savePreset } = await import('@engine/database')
    await savePreset(updated as any)
    await loadPresets()
    s.activePresetId = updated.id
    showEntryEditor.value = false
    ui.toast('条目已保存', 'success')
  }
}
const showPresetEditor = ref(false)
const presetForm = reactive({ name: '', description: '', mainPrompt: '', temperature: '0.8', maxTokens: '4096', topP: '1', freqPen: '0', presPen: '0' })
const editingPresetId = ref<string | null>(null)

async function loadPresets() {
  try { const { getPresets } = await import('@engine/database'); const p = await getPresets(); if (p) s.presets = p as PresetItem[] } catch {}
}
function selectPreset(id: string) {
  s.activePresetId = id
  const p = s.presets.find((x: PresetItem) => x.id === id)
  if (p) {
    const ps = p.settings
    agentPromptDraft.value = ps.prompts?.[0]?.content || ps.mainPrompt || ps.system_prompt || ''
    s.agentPromptEdited = true
  }
}
function openNewPreset() {
  editingPresetId.value = null
  presetForm.name = ''; presetForm.description = ''; presetForm.mainPrompt = ''; presetForm.temperature = '0.8'; presetForm.maxTokens = '4096'; presetForm.topP = '1'; presetForm.freqPen = '0'; presetForm.presPen = '0'
  showPresetEditor.value = true
}
function openEditPreset(p: PresetItem) {
  editingPresetId.value = p.id
  const s = p.settings
  presetForm.name = p.name; presetForm.description = p.description || ''; presetForm.mainPrompt = s.prompts?.[0]?.content || s.mainPrompt || s.system_prompt || ''; presetForm.temperature = s.temp_openai ?? s.temperature ?? '0.8'; presetForm.maxTokens = s.openai_max_tokens ?? s.max_tokens ?? '4096'; presetForm.topP = s.top_p_openai ?? s.top_p ?? '1'; presetForm.freqPen = s.freq_pen_openai ?? s.frequency_penalty ?? '0'; presetForm.presPen = s.pres_pen_openai ?? s.presence_penalty ?? '0'
  showPresetEditor.value = true
}
async function savePreset() {
  const { savePreset: sp } = await import('@engine/database')
  const now = Date.now()

  let settings: Record<string, any>
  if (editingPresetId.value) {
    // 编辑已有预设：基于原 settings 更新，不丢失原有数据
    const original = s.presets.find((p: PresetItem) => p.id === editingPresetId.value)
    settings = {
      ...(original?.settings || {}),   // 保留所有原有 ST 配置
      temp_openai: presetForm.temperature,
      openai_max_tokens: presetForm.maxTokens,
      top_p_openai: presetForm.topP,
      freq_pen_openai: presetForm.freqPen,
      pres_pen_openai: presetForm.presPen,
    }
    // 更新 prompts[0] 的 Main Prompt 内容，保留其余所有条目
    const prompts = [...(settings.prompts || [])]
    if (prompts.length > 0) {
      prompts[0] = { ...prompts[0], content: presetForm.mainPrompt, name: prompts[0].name || 'Main Prompt', role: prompts[0].role || 'system' }
    } else {
      prompts.push({ name: 'Main Prompt', content: presetForm.mainPrompt, role: 'system' })
    }
    settings.prompts = prompts
  } else {
    // 新建预设：从零构建
    settings = {
      temp_openai: presetForm.temperature,
      openai_max_tokens: presetForm.maxTokens,
      top_p_openai: presetForm.topP,
      freq_pen_openai: presetForm.freqPen,
      pres_pen_openai: presetForm.presPen,
      prompts: [{ name: 'Main Prompt', content: presetForm.mainPrompt, role: 'system' }],
    }
  }

  const item: PresetItem = {
    id: editingPresetId.value || crypto.randomUUID(),
    name: presetForm.name, description: presetForm.description,
    settings, createdAt: editingPresetId.value ? (s.presets.find((p:PresetItem)=>p.id===editingPresetId.value)?.createdAt||now) : now, updatedAt: now,
  }
  await sp(item as any)
  await loadPresets()
  showPresetEditor.value = false
  ui.toast(editingPresetId.value ? '预设已更新' : '预设已创建', 'success')
}
async function deletePreset(id: string) {
  const { deletePreset: dp } = await import('@engine/database')
  try { await dp(id); await loadPresets(); if (s.activePresetId === id) s.activePresetId = ''; ui.toast('预设已删除', 'info') } catch {}
}
async function importStPreset() {
  const { savePreset: sp } = await import('@engine/database')
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.json'
  input.onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0]
    if (!f) return
    try {
      const raw = JSON.parse(await f.text())
      // 用导入的文件名作为预设名
      const presetName = f.name.replace(/\.json$/i, '')
      const now = Date.now()
      const preset: PresetItem = {
        id: crypto.randomUUID(),
        name: presetName,
        description: raw.description || '',
        settings: raw,
        createdAt: now, updatedAt: now,
      }
      await sp(preset as any)
      await loadPresets()
      ui.toast(`已导入预设「${presetName}」(${raw.prompts?.length || 0} 个子提示词)`, 'success')
    } catch { ui.toast('导入失败，请检查文件格式', 'error') }
  }; input.click()
}
async function exportPresetDynamic(p: PresetItem) {
  const data = { ...p.settings, name: p.name, description: p.description }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${p.name}.json`; a.click()
  URL.revokeObjectURL(url)
}

// 进入 Agent 配置时加载预设
watch(activeSection, (s) => { if (s === 'agent') loadPresets() })

const availableApiModels = computed(() => {
  const m: { id: string; label: string }[] = []
  for (const api of s.apiPool) for (const mdl of api.models) m.push({ id: `${api.id}:${mdl}`, label: `${api.name} — ${mdl}` })
  return m
})

function selectAgent(agentId: string) {
  activeAgent.value = agentId
  s.activeAgent = agentId
  agentPromptDraft.value = s.agentPrompts[agentId] || ''
  s.agentPromptEdited = false
}

function confirmPrompt() { if(!activeAgent.value)return; s.agentPrompts[activeAgent.value]=agentPromptDraft.value; s.agentPromptEdited=false; s.agentDirty[activeAgent.value]=true; ui.toast('提示词已保存','success') }
function resetPrompt() { if(!activeAgent.value)return; agentPromptDraft.value=''; s.agentPrompts[activeAgent.value]=''; s.agentPromptEdited=false; s.agentDirty[activeAgent.value]=false; ui.toast('已恢复默认提示词','info') }
async function saveAsDefault() {
  if (!activeAgent.value) return
  const agentId = activeAgent.value

  // 构建当前 Agent 的默认条目
  const entry = {
    worldBookEnabled: s.agentWorldbookEnabled[agentId] ?? false,
    worldBookIds: [...(s.agentWorldbookIds[agentId] || [])],
    model: s.agentModels[agentId] || '',
    systemPrompt: '',
    presetId: '',
    preset: null as PresetItem | null,
    temperature: s.agentTemperature[agentId] ?? 0.7,
    topP: s.agentTopP[agentId] ?? 1.0,
    freqPen: s.agentFreqPen[agentId] ?? 0,
    presPen: s.agentPresPen[agentId] ?? 0,
    maxTokens: s.agentMaxTokens[agentId] ?? 16384,
  }

  if (agentId === 'story') {
    // Story Agent：嵌入完整预设数据
    entry.presetId = s.activePresetId || ''
    if (s.activePresetId && activePreset.value) {
      entry.preset = JSON.parse(JSON.stringify(activePreset.value))
    }
  } else {
    // 其他 Agent：提交 System Prompt draft
    s.agentPrompts[agentId] = agentPromptDraft.value
    entry.systemPrompt = agentPromptDraft.value || ''
  }

  // 读取现有文件，更新当前 Agent，写回
  let current: { version: number; agents: Record<string, any> } = { version: 1, agents: {} }
  try {
    const res = await fetch('/data/defaults/agent-config.json')
    if (res.ok) current = await res.json()
  } catch { /* 首次保存 — 用空骨架 */ }

  current.agents[agentId] = entry as any

  const ok = await cfg.saveAgentProjectDefaults(current as any)
  if (ok) {
    ui.toast(`已将「${agentList.find(a => a.id === agentId)?.name || agentId}」的配置保存为项目默认`, 'success')
  } else {
    ui.toast('保存项目默认失败，请确认开发服务器正在运行', 'error')
  }
}

function saveAgentSettings() {
  if(!activeAgent.value)return
  // 非 story Agent：提交 System Prompt draft 到持久化
  if (activeAgent.value !== 'story') {
    s.agentPrompts[activeAgent.value] = agentPromptDraft.value
  }
  s.agentDirty[activeAgent.value]=true
  ui.toast('Agent 设置已保存','success')
}
function restoreAgentDefaults() {
  if (!activeAgent.value) return
  const agentId = activeAgent.value

  // 优先查项目默认
  const pd = cfg.projectAgentDefaults?.agents?.[agentId]
  if (pd) {
    s.agentModels[agentId] = pd.model ?? ''
    s.agentWorldbookEnabled[agentId] = pd.worldBookEnabled ?? false
    s.agentWorldbookIds[agentId] = [...(pd.worldBookIds || [])]
    if (agentId === 'story') {
      s.activePresetId = pd.presetId || ''
      if (pd.preset) {
        const existing = (s.presets as PresetItem[]).find(p => p.id === pd.preset!.id)
        if (!existing) s.presets.push(pd.preset)
      }
    } else {
      s.agentPrompts[agentId] = pd.systemPrompt || ''
      agentPromptDraft.value = pd.systemPrompt || ''
    }
    s.agentTemperature[agentId] = pd.temperature ?? 0.7
    s.agentTopP[agentId] = pd.topP ?? 1.0
    s.agentFreqPen[agentId] = pd.freqPen ?? 0
    s.agentPresPen[agentId] = pd.presPen ?? 0
    s.agentMaxTokens[agentId] = pd.maxTokens ?? 16384
    s.agentPromptEdited = false
    s.agentDirty[agentId] = false
    ui.toast('已恢复项目默认设置', 'info')
    return
  }

  // 无项目默认 → 硬编码兜底
  s.agentModels[agentId] = ''
  s.agentWorldbookEnabled[agentId] = false
  s.agentWorldbookIds[agentId] = []
  s.agentPrompts[agentId] = ''
  s.activePresetId = ''
  agentPromptDraft.value = ''
  s.agentTemperature[agentId] = 0.7
  s.agentTopP[agentId] = 1.0
  s.agentFreqPen[agentId] = 0
  s.agentPresPen[agentId] = 0
  s.agentMaxTokens[agentId] = 16384
  s.agentPromptEdited = false
  s.agentDirty[agentId] = false
  ui.toast('已恢复默认设置', 'info')
}

// Phase 8: 世界书管理
async function importWorldBook() {
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.json'
  input.onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0]
    if (!f) return
    try {
      const raw = JSON.parse(await f.text())
      const book: WorldBook = {
        id: f.name.replace(/\.json$/i, ''),
        name: raw.name || f.name.replace(/\.json$/i, ''),
        partition: 'world_setting',
        description: raw.description || '',
        entries: Array.isArray(raw.entries) ? raw.entries.map((e: any) => ({
          uid: e.uid || Date.now(),
          name: e.name || e.comment || '',
          content: e.content || '',
          enabled: e.enabled !== false,
          constant: e.constant || false,
          key: e.key || [],
          keysecondary: e.keysecondary || [],
          selectiveLogic: e.selectiveLogic ?? 0,
          order: e.order ?? 100,
          position: e.position ?? 0,
        })) : [],
      }
      s.worldBooks.push(book)
      ui.toast(`已导入 "${book.name}" (${book.entries.length} 条目)`, 'success')
    } catch { ui.toast('导入失败：文件格式错误', 'error') }
  }
  input.click()
}

function newWorldBook() {
  const name = prompt('世界书名称：')
  if (!name) return
  const id = name.toLowerCase().replace(/\s+/g, '_')
  const book: WorldBook = {
    id,
    name,
    partition: 'world_setting',
    entries: [],
  }
  s.worldBooks.push(book)
  activeWorldBook.value = book
  ui.toast(`已创建 "${name}"`, 'success')
}

function deleteWorldBook(id: string) {
  const book = s.worldBooks.find(b => b.id === id)
  if (!book) return
  if (!confirm(`确定删除世界书"${book.name}"吗？将删除全部 ${book.entries?.length || 0} 条条目，此操作不可撤销。`)) return
  s.worldBooks = s.worldBooks.filter(b => b.id !== id)
  ui.toast(`已删除"${book.name}"`, 'warning')
}

function closeWorldBookEditor() {
  activeWorldBook.value = null
}

async function resetWorldBooks() {
  if (!confirm('确定恢复所有世界书为默认吗？\n\n这将清除所有修改和导入的世界书，重新加载内置版本。此操作不可撤销。')) return
  try {
    await cfg.resetWorldBooksToDefaults()
    activeWorldBook.value = null
    ui.toast('世界书已恢复为默认', 'success')
  } catch {
    ui.toast('恢复失败，请检查 data/worldbooks/ 目录', 'error')
  }
}

function handleWorldBookUpdate(updated: WorldBook) {
  const idx = s.worldBooks.findIndex(b => b.id === updated.id)
  if (idx >= 0) {
    s.worldBooks[idx] = updated
  }
  ui.toast('世界书已保存', 'success')
}

function toggleAgentWorldBook(agentId: string | null, bookId: string) {
  if (!agentId) return
  const ids = s.agentWorldbookIds[agentId] || []
  const idx = ids.indexOf(bookId)
  if (idx >= 0) {
    ids.splice(idx, 1)
  } else {
    ids.push(bookId)
  }
  s.agentWorldbookIds[agentId] = [...ids]
  s.agentDirty[agentId] = true
}

// ============================================================
// 剧情系统（存于 settings-store，自动持久化）
// ============================================================
const showPlotPreview = ref(false)
const genreOptions = [
  { value:'combat', label:'战斗', desc:'侧重战斗冲突与力量成长' }, { value:'mystery', label:'解谜', desc:'侧重悬疑推理与真相揭露' },
  { value:'social', label:'社交', desc:'侧重势力博弈与人际关系' }, { value:'romance', label:'恋爱', desc:'侧重情感发展与羁绊建立' },
  { value:'exploration', label:'探索', desc:'侧重地图探索与未知发现' }, { value:'politics', label:'权谋', desc:'侧重政治斗争与权力更迭' },
  { value:'survival', label:'生存', desc:'侧重资源管理与逆境求生' }, { value:'tragedy', label:'悲剧', desc:'侧重命运无常与英雄陨落' },
]
function toggleGenre(g:string){const i=s.plotGenres.indexOf(g);if(i>=0)s.plotGenres.splice(i,1);else s.plotGenres.push(g)}
const plotDifficultyOptions = [
  { value:'dynamic', label:'动态（根据玩家层级）' }, { value:'1', label:'T1 普通' }, { value:'2', label:'T2 中坚' },
  { value:'3', label:'T3 精英' }, { value:'4', label:'T4 史诗' }, { value:'5', label:'T5 传说' }, { value:'6', label:'T6 神话' }, { value:'7', label:'T7 神祇' },
]

// ============================================================
// 主题 & 数据 & 关于
// ============================================================
function selectTheme(id:string){theme.apply(id);ui.toast(`主题：${theme.currentTheme?.nameZh}`,'success')}
const showClearConfirm = ref(false)
const storageInfo = ref<{ used: number; quota: number; pct: number } | null>(null)
async function loadStorageUsage() {
  storageInfo.value = await cfg.getStorageUsage()
}
onMounted(loadStorageUsage)
function fmtBytes(b: number) { if (b < 1024) return `${b} B`; if (b < 1048576) return `${(b/1024).toFixed(1)} KB`; return `${(b/1048576).toFixed(1)} MB` }
async function exportAll(){const{exportAllData}=await import('@engine/database');const d=await exportAllData();const b=new Blob([JSON.stringify(d,null,2)],{type:'application/json'});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download=`fated-poem-${Date.now()}.json`;a.click();URL.revokeObjectURL(u);ui.toast('导出成功','success')}
async function importAll(){const i=document.createElement('input');i.type='file';i.accept='.json';i.onchange=async(e)=>{const f=(e.target as HTMLInputElement).files?.[0];if(!f)return;try{const{importAllData}=await import('@engine/database');await importAllData(JSON.parse(await f.text()));ui.toast('导入成功','success');await loadStorageUsage()}catch{ui.toast('导入失败','error')}};i.click()}
async function clearAll(){const{deleteDatabase}=await import('@engine/database');await deleteDatabase();cfg.resetAll();showClearConfirm.value=false;ui.toast('数据已清除，页面即将刷新','warning');setTimeout(()=>location.reload(),1500)}
</script>

<template>
  <div class="settings-page">
    <!-- 顶部栏 -->
    <div class="settings-header">
      <AppButton variant="ghost" size="sm" @click="ui.navigate(ui.activeSaveId ? 'game' : 'home')">← 返回</AppButton>
      <h2 class="settings-title">系统设置</h2>
      <div class="header-spacer" />
    </div>

    <div class="settings-body">
      <!-- ====== 左侧主导航 ====== -->
      <nav class="main-nav">
        <button v-for="item in navItems" :key="item.key" class="nav-item" :class="{ 'nav-active': activeSection === item.key }"
          @click="activeSection = item.key; activeAgent = null">
          <span class="nav-icon"><i :class="item.icon" aria-hidden="true"></i></span>
          <span class="nav-label">{{ item.label }}</span>
          <span class="nav-indicator" v-if="activeSection === item.key" />
        </button>
      </nav>

      <!-- ====== Agent 子导航（仅当选中 Agent 配置时显示）====== -->
      <nav v-if="activeSection === 'agent'" class="sub-nav">
        <button v-for="ag in agentList" :key="ag.id" class="sub-nav-item" :class="{ 'sub-nav-active': activeAgent === ag.id }"
          @click="selectAgent(ag.id)">
          <span class="sub-nav-name">{{ ag.name }}</span>
          <!-- 未配置 API 标红 -->
          <span v-if="!hasApi" class="sub-nav-badge sub-nav-bad">!</span>
          <span v-else-if="agentDirty[ag.id]" class="sub-nav-badge sub-nav-ok">✓</span>
        </button>
      </nav>

      <!-- ====== 右侧内容（居中）====== -->
      <div class="settings-content" :class="{ 'content-with-subnav': activeSection === 'agent' }">
        <Transition name="section-fade" mode="out-in">
          <div :key="activeSection" class="section-wrapper">

            <!-- ========== API 池 ========== -->
            <section v-if="activeSection === 'api'" class="section centered">
          <div class="section-head">
            <div><h3>API 池管理</h3><p class="section-desc">管理 AI 模型连接端点。支持所有 OpenAI 兼容 API。</p></div>
            <AppButton variant="primary" size="sm" @click="openAddApi">+ 添加 API</AppButton>
          </div>
          <div class="api-pool">
            <AppCard v-for="ep in s.apiPool" :key="ep.id" padding="md"><div class="api-card-body"><div class="api-card-info"><span class="api-card-name">{{ ep.name }}</span><span class="api-card-model text-secondary text-sm">{{ ep.model||'未选择模型' }}</span><span class="api-card-url text-muted text-xs">{{ ep.baseUrl }}</span></div><div class="api-card-actions"><AppButton variant="ghost" size="sm" @click="openEditApi(ep)">编辑</AppButton><AppButton variant="ghost" size="sm" @click="deleteApi(ep.id)">删除</AppButton></div></div></AppCard>
            <p v-if="s.apiPool.length===0" class="text-muted text-sm" style="text-align:center;padding:24px">还没有配置 API，点击右上角"添加 API"开始</p>
          </div>
          <!-- 模型推荐 -->
          <AppCard padding="md" class="embedding-hint" style="margin-top:16px">
            <p class="text-sm text-muted" style="margin:0 0 6px">💡 <strong>模型推荐</strong></p>
            <p class="text-sm text-muted" style="margin:0 0 4px">对话模型：推荐 <strong>DeepSeek V4 Flash</strong>（快速便宜）或 <strong>DeepSeek V4 Pro</strong>（质量优先）。</p>
            <p class="text-sm text-muted" style="margin:0">Embedding 模型：推荐 <strong>硅基流动 (SiliconFlow)</strong> 的 <strong>Qwen3-VL-Embedding-8B</strong>，充个五块钱能玩到天荒地老。</p>
          </AppCard>
        </section>

        <!-- ========== Agent 详情 ========== -->
        <section v-if="activeSection === 'agent' && activeAgent" class="section centered">
          <div class="agent-detail-head">
            <h3>{{ agentList.find(a=>a.id===activeAgent)?.name }}</h3>
            <span class="text-sm text-muted">{{ agentList.find(a=>a.id===activeAgent)?.desc }}</span>
          </div>

          <!-- 模型选择 — 默认必须为空 -->
          <AppCard padding="md" class="detail-card">
            <h4>模型选择</h4>
            <p class="form-hint">从 API 池中为此 Agent 选择模型。必须选择，留空则此 Agent 无法运行。</p>
            <div class="key-row">
              <select class="form-input" :value="s.agentModels[activeAgent] || ''"
                @change="s.agentModels[activeAgent] = ($event.target as HTMLSelectElement).value; s.agentDirty[activeAgent] = true">
                <option value="">— 请选择模型 —</option>
                <option v-for="m in availableApiModels" :key="m.id" :value="m.id">{{ m.label }}</option>
              </select>
              <span v-if="!s.agentModels[activeAgent] && !hasApi" class="api-warn">⚠ 请先配置 API</span>
              <span v-else-if="!s.agentModels[activeAgent]" class="api-warn">⚠ 未选择</span>
              <span v-else class="api-ok">✓</span>
            </div>
          </AppCard>

          <!-- LLM 参数 (所有 Agent 通用) -->
          <AppCard padding="md" class="detail-card">
            <h4>LLM 参数</h4>
            <p class="form-hint">控制此 Agent 的采样行为和生成长度。所有参数均有合理默认值。</p>
            <div class="form-grid" style="grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px">
              <label class="form-label">Temperature
                <p class="form-hint">越高越随机 (0-2)</p>
                <input type="number" step="0.1" min="0" max="2"
                  :value="s.agentTemperature[activeAgent] ?? 0.7"
                  @input="s.agentTemperature[activeAgent] = Number(($event.target as HTMLInputElement).value); s.agentDirty[activeAgent] = true"
                  class="form-input" />
              </label>
              <label class="form-label">Top P
                <p class="form-hint">核采样阈值 (0-1)</p>
                <input type="number" step="0.05" min="0" max="1"
                  :value="s.agentTopP[activeAgent] ?? 1.0"
                  @input="s.agentTopP[activeAgent] = Number(($event.target as HTMLInputElement).value); s.agentDirty[activeAgent] = true"
                  class="form-input" />
              </label>
              <label class="form-label">Frequency Penalty
                <p class="form-hint">抑制重复 (-2 ~ 2)</p>
                <input type="number" step="0.1" min="-2" max="2"
                  :value="s.agentFreqPen[activeAgent] ?? 0"
                  @input="s.agentFreqPen[activeAgent] = Number(($event.target as HTMLInputElement).value); s.agentDirty[activeAgent] = true"
                  class="form-input" />
              </label>
              <label class="form-label">Presence Penalty
                <p class="form-hint">鼓励新话题 (-2 ~ 2)</p>
                <input type="number" step="0.1" min="-2" max="2"
                  :value="s.agentPresPen[activeAgent] ?? 0"
                  @input="s.agentPresPen[activeAgent] = Number(($event.target as HTMLInputElement).value); s.agentDirty[activeAgent] = true"
                  class="form-input" />
              </label>
              <label class="form-label">Max Tokens
                <p class="form-hint">单次回复最大长度</p>
                <input type="number" min="100" max="32768" step="100"
                  :value="s.agentMaxTokens[activeAgent] ?? 16384"
                  @input="s.agentMaxTokens[activeAgent] = Number(($event.target as HTMLInputElement).value); s.agentDirty[activeAgent] = true"
                  class="form-input" />
              </label>
            </div>
          </AppCard>

          <!-- 世界书配置 (Phase 8) -->
          <AppCard padding="md" class="detail-card">
            <h4>世界书配置</h4>
            <p class="form-hint">启用该 Agent 的世界书上下文注入。选择要关联的世界书。</p>
            <div class="key-row" style="margin-bottom:8px">
              <label class="toggle-label">
                <span class="text-sm text-secondary">启用世界书</span>
                <input type="checkbox" class="toggle-input"
                  :checked="s.agentWorldbookEnabled[activeAgent] || false"
                  @change="s.agentWorldbookEnabled[activeAgent] = ($event.target as HTMLInputElement).checked; s.agentDirty[activeAgent] = true" />
                <span class="toggle-slider"></span>
              </label>
            </div>
            <div class="worldbook-select-list">
              <template v-if="s.worldBooks.length === 0">
                <p class="text-muted text-sm" style="padding:20px;text-align:center">暂未导入世界书。请先在「世界书」导航中导入。</p>
              </template>
              <label v-for="book in s.worldBooks" :key="book.id" class="worldbook-checkbox">
                <input type="checkbox"
                  :checked="(s.agentWorldbookIds[activeAgent] || []).includes(book.id)"
                  @change="toggleAgentWorldBook(activeAgent, book.id)"
                  :aria-label="`关联世界书: ${book.name}`" />
                <i class="fa-solid fa-book" aria-hidden="true" style="font-size:13px;opacity:0.5"></i>
                <span class="wb-check-label">{{ book.name }}</span>
                <span class="text-xs text-muted">{{ book.entries?.length || 0 }} 条目</span>
              </label>
            </div>
          </AppCard>

          <!-- 预设系统（正文 Agent 专用）— 仿酒馆 ST 左侧面板布局 -->
          <AppCard v-if="activeAgent === 'story'" padding="md" class="detail-card">
            <h4>预设管理（酒馆 ST 兼容）</h4>
            <p class="form-hint">仿 SillyTavern AI Response Configuration 面板布局。支持导入 SillyTavern 预设 JSON。</p>

            <!-- 预设选择器栏 -->
            <div class="preset-selector-bar">
              <select class="form-input preset-select" :value="s.activePresetId" @change="selectPreset(($event.target as HTMLSelectElement).value)">
                <option value="">— 选择预设 —</option>
                <option v-for="p in s.presets" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
              <AppButton variant="ghost" size="sm" @click="importStPreset">📥 导入</AppButton>
              <AppButton variant="primary" size="sm" @click="openNewPreset">+ 新建</AppButton>
            </div>

            <!-- 选中预设的完整预览卡片 — 仿 ST 面板布局 -->
            <div v-if="activePreset" class="preset-viewer">
              <div class="preset-viewer-header">
                <div class="preset-viewer-title">
                  <h5>{{ activePreset.name }}</h5>
                  <span v-if="activePreset.description" class="text-xs text-muted">{{ activePreset.description }}</span>
                </div>
                <div class="preset-viewer-actions">
                  <AppButton variant="ghost" size="sm" @click="exportPresetDynamic(activePreset!)">📤 导出</AppButton>
                  <AppButton variant="ghost" size="sm" @click="deletePreset(s.activePresetId)">🗑 删除</AppButton>
                </div>
              </div>

              <!-- 条目列表（子提示词） -->
              <div class="preset-prompts-list">
                <h4 class="text-sm text-muted" style="margin:0 0 8px;padding:0 16px">
                  📝 条目列表（{{ activePreset.settings?.prompts?.length || 0 }} 个）
                </h4>
                <div v-for="(sp, idx) in (activePreset.settings?.prompts || [])" :key="sp.identifier || idx" class="subprompt-item" :class="{ 'subprompt-disabled': sp.enabled === false }">
                  <div class="subprompt-header" @click="toggleEntry(s.activePresetId, idx)">
                    <div class="subprompt-info">
                      <label class="subprompt-toggle" @click.stop>
                        <input type="checkbox" :checked="sp.enabled !== false" disabled class="toggle-input" />
                        <span class="toggle-slider toggle-sm"></span>
                      </label>
                      <span class="subprompt-name">{{ sp.name || `条目 #${idx + 1}` }}</span>
                      <span class="subprompt-role text-xs text-muted">{{ sp.role || 'system' }}</span>
                    </div>
                    <div class="subprompt-meta">
                      <button class="subprompt-edit-btn" @click.stop="openEntryEditor(s.activePresetId, idx)" title="编辑此条目">✎</button>
                      <span class="subprompt-chars text-xs text-muted">{{ (sp.content || '').length }} 字</span>
                      <span class="subprompt-chevron" :class="{ 'chevron-open': expandedEntries.has(`${s.activePresetId}:${idx}`) }">▸</span>
                    </div>
                  </div>
                  <div v-if="expandedEntries.has(`${s.activePresetId}:${idx}`)" class="subprompt-content">
                    {{ (sp.content || '(空)').slice(0, 300) }}{{ (sp.content || '').length > 300 ? '...' : '' }}
                  </div>
                </div>
                <p v-if="!activePreset.settings?.prompts?.length" class="text-muted text-sm" style="padding:12px 16px">此预设没有条目</p>
              </div>
            </div>

            <!-- 未选择预设 -->
            <div v-else class="preset-empty">
              <p class="text-muted">选择一个预设或新建/导入预设来配置正文 Agent</p>
            </div>
          </AppCard>

          <AppCard v-else padding="md" class="detail-card">
            <h4>System Prompt</h4>
            <p class="form-hint">编辑此 Agent 的固定系统提示词。留空则使用引擎默认模板。</p>
            <textarea v-model="agentPromptDraft" class="form-textarea prompt-editor" rows="10" placeholder="留空使用引擎默认模板..." @input="s.agentPromptEdited=true" />
          </AppCard>

          <!-- 操作按钮 -->
          <div class="detail-actions">
            <AppButton variant="ghost" size="sm" @click="saveAsDefault">保存为默认</AppButton>
            <AppButton variant="ghost" size="sm" @click="restoreAgentDefaults">恢复默认</AppButton>
            <AppButton variant="primary" size="sm" @click="saveAgentSettings">保存设置</AppButton>
          </div>
        </section>

        <!-- Agent 未选择时的提示 -->
        <section v-if="activeSection === 'agent' && !activeAgent" class="section centered">
          <div style="text-align:center;padding:60px 0">
            <p class="text-muted" style="font-size:1.1rem">← 请从左侧选择一个 Agent</p>
            <p class="text-sm text-muted" style="margin-top:8px">每个 Agent 需要单独配置模型和世界书上下文</p>
          </div>
        </section>

        <!-- ========== 世界书 (Phase 8) ========== -->
        <section v-if="activeSection === 'worldbook'" class="section centered">
          <!-- 编辑模式：显示条目编辑器 -->
          <WorldBookEditor
            v-if="activeWorldBook"
            :book="activeWorldBook"
            :readonly="(activeWorldBook.builtIn && !s.disableWorldBookProtection) || false"
            @back="closeWorldBookEditor"
            @update="handleWorldBookUpdate"
          />

          <!-- 列表模式 -->
          <template v-else>
            <div class="section-head">
              <div><h3>世界书管理</h3><p class="section-desc">管理世界书条目，为 Agent 提供世界观上下文。</p></div>
              <div style="display:flex;gap:8px;align-items:center">
                <label class="toggle-label" style="margin-right:8px" title="关闭后内置世界书恢复只读保护">
                  <span class="text-xs text-muted">编辑保护</span>
                  <input type="checkbox" class="toggle-input" v-model="s.disableWorldBookProtection" />
                  <span class="toggle-slider"></span>
                </label>
                <AppButton variant="secondary" size="sm" @click="importWorldBook">导入ST世界书</AppButton>
                <AppButton variant="primary" size="sm" @click="newWorldBook">+ 新建世界书</AppButton>
                <AppButton variant="ghost" size="sm" @click="resetWorldBooks" style="color:var(--color-warning)">⟳ 恢复默认</AppButton>
              </div>
            </div>

            <AppCard v-if="s.worldBooks.length === 0" padding="md">
              <p class="text-muted text-sm" style="text-align:center;padding:40px 0">
                暂无世界书<br/>
                <span style="font-size:0.75rem">点击右上角"导入ST世界书"或"新建世界书"开始</span>
              </p>
            </AppCard>

            <div v-else class="worldbook-list">
              <AppCard v-for="book in s.worldBooks" :key="book.id" padding="md" class="worldbook-card">
                <div class="wb-info">
                  <h4>
                    <i class="fa-solid fa-book" aria-hidden="true" style="margin-right:6px;opacity:0.6"></i>{{ book.name }}
                    <span v-if="book.builtIn" class="builtin-badge">内置</span>
                  </h4>
                  <p class="text-sm text-muted">{{ book.description || book.partition }}</p>
                  <span class="text-sm text-muted">{{ book.entries?.length || 0 }} 条目</span>
                </div>
                <div style="display:flex;gap:8px">
                  <AppButton v-if="!book.builtIn" variant="danger" size="sm" @click="deleteWorldBook(book.id)">
                    <i class="fa-solid fa-trash" aria-hidden="true"></i>
                  </AppButton>
                  <AppButton variant="secondary" size="sm" @click="activeWorldBook = book">
                    <i class="fa-solid fa-eye" v-if="book.builtIn" aria-hidden="true" style="margin-right:4px"></i>
                    浏览 <i class="fa-solid fa-arrow-right" aria-hidden="true" style="margin-left:4px"></i>
                  </AppButton>
                </div>
              </AppCard>
            </div>
          </template>
        </section>

        <!-- ========== 剧情系统 ========== -->
        <section v-if="activeSection === 'plot'" class="section centered">
          <h3>剧情系统</h3>
          <p class="section-desc">控制剧情生成模式、大纲和事件参数。对应 Agent：剧情预检 / 剧情修正 / 大纲生成</p>
          <!-- 剧情偏向 — 最上面 -->
          <AppCard padding="md" class="detail-card"><h4>剧情偏向</h4><p class="form-hint">选择一个或多个你喜欢的剧情方向，AI 会优先往这些方向发展。</p><div class="genre-grid"><label v-for="g in genreOptions" :key="g.value" class="genre-chip" :class="{'genre-active':s.plotGenres.includes(g.value)}" @click="toggleGenre(g.value)"><span class="genre-chip-label">{{ g.label }}</span><span class="genre-chip-desc">{{ g.desc }}</span></label></div></AppCard>
          <!-- 模式 & 参数 -->
          <AppCard padding="md" class="detail-card" style="margin-top:16px"><h4>剧情模式 & 参数</h4>
            <div class="form-grid">
              <label class="form-label">剧情模式<p class="form-hint">选择剧情系统的运行模式</p><select v-model="s.plotMode" class="form-input"><option value="off">完全关闭 — 不生成任何剧情事件</option><option value="side">仅支线 — 每年自动生成地区冲突事件</option><option value="main">主线模式 — 按大纲推进完整主线剧情</option></select></label>
              <label class="form-label">主线持续年份<p class="form-hint">主线剧情覆盖的游戏年份数</p><input v-model.number="s.plotDuration" type="number" min="1" max="50" class="form-input" /></label>
              <label class="form-label">事件难度层级<p class="form-hint">动态 = 根据玩家当前层级自动调整</p><select v-model="s.plotDifficulty" class="form-input"><option v-for="o in plotDifficultyOptions" :key="o.value" :value="o.value">{{ o.label }}</option></select></label>
              <label class="form-label">引入外部 NPC<p class="form-hint">允许 AI 在世界书之外创造新角色</p><select v-model="s.plotAllowExternalNPC" class="form-input"><option :value="true">允许 — 剧情更丰富但可能偏离设定</option><option :value="false">禁止 — 仅使用世界书内角色</option></select></label>
              <label class="form-label" style="grid-column:1/-1">自定义偏好<p class="form-hint">用自然语言描述你想要的剧情风格</p><textarea v-model="s.plotCustomPref" class="form-input form-textarea" rows="2" placeholder="例如：希望主角经历一场背叛后重新振作..." /></label>
            </div>
          </AppCard>
          <!-- 大纲预览 -->
          <AppCard padding="md" class="detail-card plot-preview-card" :class="{'plot-revealed':showPlotPreview}" style="margin-top:16px">
            <div class="plot-preview-header"><h4>剧情大纲预览</h4><AppButton variant="ghost" size="sm" @click="showPlotPreview=!showPlotPreview">{{ showPlotPreview?'隐藏':'点击查看（防剧透）' }}</AppButton></div>
            <div class="plot-preview-body" :class="{'plot-blur':!showPlotPreview}"><p class="text-muted text-sm"><strong>第一年 — 序章：命定之始</strong></p><p class="text-muted text-sm">主角在起始地点觉醒命运之力，遭遇第一次重大抉择...</p><p class="text-muted text-sm"><strong>第二年 — 崛起：风云际会</strong></p><p class="text-muted text-sm">与各大势力接触，逐步揭开世界背后的真相...</p><p class="text-muted text-sm"><strong>第三年 — 转折：命运分叉</strong></p><p class="text-muted text-sm">关键盟友背叛/牺牲，主线走向出现重大分支...</p><p class="text-muted text-sm"><strong>第四年 — 高潮：诸神黄昏</strong></p><p class="text-muted text-sm">最终决战前夕，所有伏笔回收，各方势力集结...</p><p class="text-muted text-sm"><strong>第五年 — 终章：命定之诗</strong></p><p class="text-muted text-sm">完成主线任务，世界线尘埃落定，角色结局生成...</p></div>
            <p class="text-xs text-muted" style="margin-top:8px">⚠ 以上为示例大纲。实际内容由 AI 在游戏开始时生成。点击可切换模糊/清晰。</p>
          </AppCard>
        </section>

        <!-- ========== 记忆 & 缓存 ========== -->
        <section v-if="activeSection === 'memory'" class="section centered">
          <h3>记忆 & 缓存设置</h3>
          <p class="section-desc">控制 Embedding 召回、记忆压缩和缓存策略。Embedding 端点请在「API 配置」中添加（推荐硅基流动）。</p>
          <AppCard padding="md"><div class="form-grid">
            <label class="form-label">每轮最大召回记忆数<p class="form-hint">每次对话时从记忆库中召回的最多条目数</p><input type="number" v-model.number="s.memoryRecallCount" min="5" max="50" class="form-input" /></label>
            <label class="form-label">压缩阈值（轮）<p class="form-hint">超过此轮数后，早期记忆会被压缩为摘要</p><input type="number" v-model.number="s.memoryCompressionThreshold" min="50" max="500" class="form-input" /></label>
            <label class="form-label">每存档最大快照数<p class="form-hint">超过上限后最旧的快照会被自动删除</p><input type="number" v-model.number="s.memorySnapshotLimit" min="10" max="50" class="form-input" /></label>
            <label class="form-label">缓存策略<p class="form-hint">影响 API 调用的 Prompt 缓存利用率</p><select v-model="s.memoryCacheStrategy" class="form-input"><option value="aggressive">激进 — 尽可能缓存，高命中率</option><option value="balanced">平衡 — 兼顾缓存命中与资源消耗</option><option value="conservative">保守 — 最小缓存，适合低内存设备</option></select></label>
          </div></AppCard>
        </section>

        <!-- ========== 外观主题 ========== -->
        <section v-if="activeSection === 'theme'" class="section centered">
          <h3>外观主题</h3>
          <p class="section-desc">当前：<strong>{{ theme.currentTheme?.nameZh }}</strong>（{{ theme.currentTheme?.type==='dark'?'深色':theme.currentTheme?.type==='warm'?'暖色':'浅色' }}系）</p>
          <div class="theme-grid">
            <button v-for="t in theme.THEME_LIST" :key="t.id" class="theme-option" :class="{'theme-selected':t.id===theme.current}" :style="{background:t.preview}" @click="selectTheme(t.id)">
              <span class="theme-name" :style="{color:t.type==='dark'?'#fff':'#1a1a1a'}">{{ t.nameZh }}</span><span v-if="t.id===theme.current" class="theme-check">✓</span>
            </button>
          </div>
          <AppCard padding="md" style="margin-top:16px"><div class="form-grid"><label class="form-label">字体风格<p class="form-hint">衬线体更有古典文学感，无衬线体更适合长时间阅读</p><select class="form-input" :value="theme.fonts" @change="theme.setFonts(($event.target as HTMLSelectElement).value as any)"><option value="sans">无衬线 (Noto Sans SC)</option><option value="serif">衬线 (Noto Serif SC)</option><option value="mixed">混合</option></select></label><label class="form-label">字体大小<p class="form-hint">调整所有界面文字大小</p><select class="form-input" :value="theme.fontSize" @change="theme.setFontSize(($event.target as HTMLSelectElement).value)"><option value="14">小 (14px)</option><option value="16" selected>默认 (16px)</option><option value="18">大 (18px)</option><option value="20">特大 (20px)</option></select></label></div></AppCard>
        </section>

        <!-- ========== 存档数据 ========== -->
        <section v-if="activeSection === 'data'" class="section centered">
          <h3>存档数据管理</h3><p class="section-desc">导出、导入或清除所有数据。建议定期导出备份。</p>
          <div class="data-actions"><AppCard padding="md"><h4>导出数据</h4><p class="text-muted text-sm">将所有存档、角色、记忆、剧情导出为 JSON 文件</p><AppButton variant="secondary" size="sm" @click="exportAll" style="margin-top:8px">导出全部数据</AppButton></AppCard><AppCard padding="md"><h4>导入数据</h4><p class="text-muted text-sm">从 JSON 文件恢复数据，将合并到现有数据库</p><AppButton variant="secondary" size="sm" @click="importAll" style="margin-top:8px">导入数据</AppButton></AppCard><AppCard padding="md"><h4>📊 浏览器存储用量</h4><div v-if="storageInfo"><div class="storage-bar-track"><div class="storage-bar-fill" :style="{width:storageInfo.pct+'%'}"></div></div><p class="text-sm" style="margin:6px 0 0">{{ fmtBytes(storageInfo.used) }} / {{ fmtBytes(storageInfo.quota) }}（{{ storageInfo.pct.toFixed(1) }}%）</p><p class="text-xs text-muted">IndexedDB + localStorage</p></div><p v-else class="text-muted text-sm">获取中…</p></AppCard><AppCard padding="md" class="data-danger"><h4>清除所有数据</h4><p class="text-muted text-sm">永久删除所有存档、角色、记忆和设置。不可撤销。</p><AppButton variant="danger" size="sm" @click="showClearConfirm=true" style="margin-top:8px">清除所有数据</AppButton></AppCard></div>
          <AppModal :open="showClearConfirm" title="确认清除" size="sm" @update:open="showClearConfirm=$event"><p>确定要删除所有数据吗？此操作<strong style="color:var(--theme-error)">不可撤销</strong>。</p><template #footer><AppButton variant="ghost" size="sm" @click="showClearConfirm=false">取消</AppButton><AppButton variant="danger" size="sm" @click="clearAll">确认清除</AppButton></template></AppModal>
        </section>

        <!-- ========== 关于 ========== -->
        <section v-if="activeSection === 'about'" class="section centered">
          <h3>关于命定之诗</h3>
          <div class="about-grid"><AppCard padding="md"><h4>引擎信息</h4><div class="about-table"><div class="about-row"><span>引擎版本</span><span>{{ VERSION }}</span></div><div class="about-row"><span>UI 版本</span><span>1.0.0</span></div><div class="about-row"><span>构建时间</span><span>2026-06-15</span></div></div></AppCard><AppCard padding="md"><h4>技术栈</h4><div class="about-table"><div class="about-row"><span>框架</span><span>Vue 3.5 + Pinia 2</span></div><div class="about-row"><span>构建</span><span>Vite 6</span></div><div class="about-row"><span>数据库</span><span>Dexie.js (IndexedDB)</span></div><div class="about-row"><span>语言</span><span>TypeScript 5.4</span></div></div></AppCard><AppCard padding="md"><h4>引擎统计</h4><div class="about-table"><div class="about-row"><span>引擎模块</span><span>41 模块</span></div><div class="about-row"><span>单元测试</span><span>1978 tests</span></div><div class="about-row"><span>主题</span><span>10 套</span></div><div class="about-row"><span>纪元</span><span>复兴纪元</span></div></div></AppCard></div>
          <p class="text-muted text-sm text-center" style="margin-top:16px">《命定之诗》Fated Poem — 多 Agent 协作文字 RPG 引擎<br/>© 2026 命定之诗创作组</p>
        </section>

          </div><!-- /section-wrapper -->
        </Transition>
      </div>
    </div>

    <!-- 条目编辑弹窗 -->
    <AppModal :open="showEntryEditor" title="编辑条目" size="md" @update:open="showEntryEditor=$event">
      <div class="api-form">
        <label class="form-label">条目名称<input v-model="entryEditForm.name" class="form-input" placeholder="如: ROLE主提示" /></label>
        <div class="key-row">
          <label class="form-label" style="flex:1">角色
            <select v-model="entryEditForm.role" class="form-input">
              <option value="system">system</option><option value="user">user</option><option value="assistant">assistant</option>
            </select>
          </label>
          <label class="form-label toggle-label" style="flex-direction:row;align-items:center;gap:8px">
            <span>启用</span>
            <input type="checkbox" v-model="entryEditForm.enabled" class="toggle-input" />
            <span class="toggle-slider"></span>
          </label>
        </div>
        <label class="form-label">
          内容
          <textarea v-model="entryEditForm.content" class="form-textarea prompt-editor" rows="14" placeholder="条目提示词内容..." />
        </label>
      </div>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="showEntryEditor=false">取消</AppButton>
        <AppButton variant="primary" size="sm" @click="saveEntry">保存条目</AppButton>
      </template>
    </AppModal>

    <!-- 预设编辑弹窗 -->
    <AppModal :open="showPresetEditor" :title="editingPresetId ? '编辑预设' : '新建预设'" size="md" @update:open="showPresetEditor=$event">
      <div class="api-form">
        <label class="form-label">预设名称<input v-model="presetForm.name" class="form-input" placeholder="如: 默认叙事风格" /></label>
        <label class="form-label">描述<input v-model="presetForm.description" class="form-input" placeholder="简短描述此预设的风格" /></label>
        <label class="form-label">
          System Prompt（主提示词）
          <p class="form-hint">这是正文 AI 的核心人格和叙事指导</p>
          <textarea v-model="presetForm.mainPrompt" class="form-textarea prompt-editor" rows="8" placeholder="Write {{char}}'s next reply in a fictional chat..." />
        </label>
        <div class="form-grid">
          <label class="form-label">Temperature<input v-model="presetForm.temperature" type="number" step="0.1" min="0" max="2" class="form-input" /><p class="form-hint">越高越随机，越低越稳定</p></label>
          <label class="form-label">Max Tokens<input v-model="presetForm.maxTokens" type="number" min="100" max="32768" class="form-input" /><p class="form-hint">单次回复最大长度</p></label>
          <label class="form-label">Top P<input v-model="presetForm.topP" type="number" step="0.1" min="0" max="1" class="form-input" /></label>
          <label class="form-label">Frequency Penalty<input v-model="presetForm.freqPen" type="number" step="0.1" min="-2" max="2" class="form-input" /></label>
          <label class="form-label">Presence Penalty<input v-model="presetForm.presPen" type="number" step="0.1" min="-2" max="2" class="form-input" /></label>
        </div>
      </div>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="showPresetEditor=false">取消</AppButton>
        <AppButton variant="primary" size="sm" @click="savePreset">{{ editingPresetId ? '保存修改' : '创建预设' }}</AppButton>
      </template>
    </AppModal>

    <!-- 添加/编辑 API 弹窗 -->
    <AppModal :open="showAddApi" :title="editingApiId?'编辑 API':'添加 API'" size="md" @update:open="showAddApi=$event">
      <div class="api-form"><label class="form-label">名称<input v-model="apiForm.name" class="form-input" placeholder="如: DeepSeek 生产" /></label><label class="form-label">主链接<input v-model="apiForm.baseUrl" class="form-input" placeholder="https://api.deepseek.com/v1" /></label><label class="form-label">API Key<div class="key-row"><input v-model="apiForm.apiKey" class="form-input" :type="apiForm.apiKey.length>10&&!apiForm.apiKey.includes('***')?'text':'password'" placeholder="sk-..." /><AppButton variant="secondary" size="sm" :disabled="apiFormTesting" @click="testApiAndFetch">{{ apiFormTesting?'测试中...':'测试连接' }}</AppButton></div><p class="form-hint">点击测试连接后密钥会被立即隐藏，仅保留前几位</p></label><label class="form-label">模型列表<div class="key-row"><select v-model="apiForm.model" class="form-input"><option v-for="m in apiModels" :key="m" :value="m">{{ m }}</option><option v-if="apiModels.length===0" value="" disabled>请先测试连接获取模型</option></select><AppButton variant="secondary" size="sm" :disabled="apiFormFetchingModels" @click="fetchModelList">{{ apiFormFetchingModels?'获取中...':'获取模型' }}</AppButton></div><p class="form-hint">点击获取模型从 API 端点拉取可用模型列表</p></label></div>
      <template #footer><AppButton variant="ghost" size="sm" @click="showAddApi=false">取消</AppButton><AppButton variant="primary" size="sm" @click="saveApi">{{ editingApiId?'保存修改':'添加' }}</AppButton></template>
    </AppModal>
  </div>
</template>

<style scoped>
.settings-page{display:flex;flex-direction:column;height:100vh;background:var(--theme-window-bg)}
.settings-header{display:flex;align-items:center;padding:12px 20px;background:var(--theme-title-bar-bg);border-bottom:1px solid var(--theme-card-border);gap:16px;flex-shrink:0}
.settings-title{font-family:var(--theme-font-title);font-size:1.1rem;color:var(--theme-text-primary);margin:0}
.header-spacer{flex:1}

.settings-body{display:flex;flex:1;overflow:hidden}

/* 主导航 */
.main-nav{width:180px;flex-shrink:0;background:var(--theme-title-bar-bg);border-right:1px solid var(--theme-card-border);padding:12px 8px;overflow-y:auto;display:flex;flex-direction:column;gap:2px}
.nav-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border:none;border-radius:var(--theme-radius-md);background:transparent;color:var(--theme-tab-text);font-family:inherit;font-size:0.88rem;cursor:pointer;transition:all var(--theme-transition-fast);text-align:left;position:relative}
.nav-item:hover{background:var(--theme-tab-hover-bg);color:var(--theme-text-primary)}
.nav-active{background:var(--theme-surface-muted);color:var(--theme-text-primary);font-weight:600}
.nav-icon{font-size:1rem;line-height:1;flex-shrink:0;width:24px;text-align:center;opacity:0.7;display:flex;align-items:center;justify-content:center}
.nav-icon i{font-size:1rem}
.nav-active .nav-icon{opacity:1}
.nav-label{flex:1}
.nav-indicator{width:3px;height:16px;border-radius:2px;background:var(--theme-primary);position:absolute;left:-8px;top:50%;transform:translateY(-50%)}

/* Agent 子导航 */
.sub-nav{width:170px;flex-shrink:0;background:var(--theme-content-bg);border-right:1px solid var(--theme-card-border);padding:10px 8px;overflow-y:auto;display:flex;flex-direction:column;gap:2px}
.sub-nav-item{display:flex;align-items:center;justify-content:space-between;padding:9px 12px;border:none;border-radius:var(--theme-radius-sm);background:transparent;color:var(--theme-tab-text);font-family:inherit;font-size:0.8rem;cursor:pointer;transition:all var(--theme-transition-fast);text-align:left}
.sub-nav-item:hover{background:var(--theme-tab-hover-bg);color:var(--theme-text-primary)}
.sub-nav-active{background:var(--theme-surface-muted);color:var(--theme-text-primary);font-weight:600;border-left:2px solid var(--theme-primary)}
.sub-nav-name{flex:1}
.sub-nav-badge{font-size:0.65rem;width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.sub-nav-bad{background:var(--theme-error);color:#fff}
.sub-nav-ok{background:var(--theme-success);color:#fff}

/* 内容区 */
.settings-content{flex:1;overflow-y:auto;padding:32px 40px}
.content-with-subnav{padding:32px 32px}
.section-wrapper{width:100%}

/* 分区切换动画 */
.section-fade-enter-active,
.section-fade-leave-active{transition:opacity 0.2s ease,transform 0.2s ease}
.section-fade-enter-from{opacity:0;transform:translateY(8px)}
.section-fade-leave-to{opacity:0;transform:translateY(-4px)}

/* 居中 */
.centered{max-width:780px;margin:0 auto}

/* 通用 */
.section>h3{font-family:var(--theme-font-title);font-size:1.4rem;color:var(--theme-text-primary);margin:0 0 4px;padding-left:12px;border-left:3px solid var(--theme-primary)}
.section-desc{margin:0 0 20px;font-size:0.85rem;color:var(--theme-text-muted)}
.section-head{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:16px;gap:16px}
.section-head h3{font-family:var(--theme-font-title);font-size:1.3rem;color:var(--theme-text-primary);margin:0 0 4px}
.form-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px}
.form-label{display:flex;flex-direction:column;gap:2px;font-size:0.85rem;font-weight:500;color:var(--theme-text-secondary)}
.form-input{padding:8px 12px;border:1px solid var(--theme-card-border);border-radius:var(--theme-radius-md);background:var(--theme-content-bg);color:var(--theme-text-primary);font-family:inherit;font-size:0.9rem;transition:border-color var(--theme-transition-fast),box-shadow 0.15s;width:100%}
.form-input:focus{outline:none;border-color:var(--theme-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--theme-primary) 15%, transparent)}
.form-textarea{resize:vertical;min-height:50px}
.form-hint{font-size:0.72rem;color:var(--theme-text-muted);margin:0 0 4px;line-height:1.4}
.key-row{display:flex;gap:8px;align-items:center}
.key-row .form-input{flex:1}

/* API */
.api-pool{display:flex;flex-direction:column;gap:8px}
.api-card-body{display:flex;align-items:center;justify-content:space-between;width:100%}
.api-card-info{display:flex;flex-direction:column;gap:2px}
.api-card-name{font-weight:600;font-size:0.95rem;color:var(--theme-text-primary)}
.api-card-actions{display:flex;gap:4px;flex-shrink:0}
.api-form{display:flex;flex-direction:column;gap:14px}
.embedding-hint{background:color-mix(in srgb,var(--theme-primary) 8%,var(--theme-card-bg))}
.api-warn{color:var(--theme-error);font-size:0.8rem;font-weight:600;white-space:nowrap}
.api-ok{color:var(--theme-success);font-size:0.9rem;font-weight:700}

/* Agent */
.agent-detail-head{margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--theme-card-border)}
.agent-detail-head h3{font-family:var(--theme-font-title);font-size:1.3rem;margin:0 0 6px}
.detail-card{margin-bottom:20px;border:1px solid var(--theme-card-border);transition:border-color 0.15s;border-radius:var(--theme-radius-lg, 12px)}
.detail-card:hover{border-color:color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border))}
.detail-card h4{margin:0 0 8px;font-size:1rem;color:var(--theme-text-primary)}
.detail-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px;padding-top:16px;border-top:1px solid var(--theme-card-border)}
.prompt-editor{font-family:'Monaco','Menlo','Cascadia Code',monospace;font-size:0.8rem;line-height:1.6;min-height:200px;width:100%;padding:14px;border:1px solid var(--theme-card-border);border-radius:var(--theme-radius-md);background:color-mix(in srgb, #000 6%, var(--theme-content-bg));color:var(--theme-text-primary);resize:vertical;tab-size:2}
.prompt-editor:focus{outline:none;border-color:var(--theme-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--theme-primary) 12%, transparent)}

/* Preset 预设系统 — 仿 ST 面板 */
.preset-selector-bar{display:flex;gap:8px;align-items:center;margin-bottom:12px}
.preset-select{flex:1}

.preset-viewer{border:1px solid var(--theme-card-border);border-radius:var(--theme-radius-lg);overflow:hidden}
.preset-viewer-header{display:flex;align-items:flex-start;justify-content:space-between;padding:12px 16px;background:var(--theme-surface-muted);gap:12px}
.preset-viewer-title h5{margin:0 0 2px;font-size:1rem}
.preset-viewer-actions{display:flex;gap:4px;flex-shrink:0}

/* 采样器参数网格 — 仿 ST 滑块面板 */
.preset-sampler-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;padding:12px 16px}
.sampler-item{display:flex;flex-direction:column;gap:2px}
.sampler-label{font-size:0.72rem;font-weight:500;color:var(--theme-text-muted);text-transform:uppercase;letter-spacing:0.3px}
.sampler-row{display:flex;align-items:center;gap:8px}
.sampler-slider{flex:1;height:4px;-webkit-appearance:none;appearance:none;background:var(--theme-card-border);border-radius:2px;outline:none;cursor:default}
.sampler-slider::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;background:var(--theme-primary)}
.sampler-value{font-size:0.8rem;font-weight:600;color:var(--theme-text-primary);min-width:30px;text-align:right}
.sampler-value-text{font-size:0.8rem;font-weight:600;color:var(--theme-text-primary)}

/* 子 Prompt 列表 */
.preset-prompts-list{display:flex;flex-direction:column}
.subprompt-item{padding:8px 16px;border-bottom:1px solid var(--theme-card-border);transition:background var(--theme-transition-fast)}
.subprompt-item:last-child{border-bottom:none}
.subprompt-disabled{opacity:0.45}
.subprompt-header{display:flex;align-items:center;justify-content:space-between;gap:8px}
.subprompt-info{display:flex;align-items:center;gap:8px;flex:1;min-width:0}
.subprompt-toggle{display:flex;align-items:center;cursor:default}
.subprompt-name{font-size:0.82rem;font-weight:600;color:var(--theme-text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.subprompt-role{font-size:0.65rem;opacity:0.7;flex-shrink:0;text-transform:uppercase}
.subprompt-meta{display:flex;align-items:center;gap:6px;flex-shrink:0}
.subprompt-chars{flex-shrink:0}
.subprompt-chevron{font-size:0.7rem;color:var(--theme-text-muted);transition:transform var(--theme-transition-fast);user-select:none}
.chevron-open{transform:rotate(90deg)}
.subprompt-edit-btn{width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:0.8rem;color:var(--theme-text-muted);background:none;border:none;border-radius:var(--theme-radius-sm);cursor:pointer;transition:all var(--theme-transition-fast)}
.subprompt-edit-btn:hover{color:var(--theme-primary);background:var(--theme-tab-hover-bg)}
.subprompt-content{padding:6px 8px 6px 44px;font-family:monospace;font-size:0.72rem;color:var(--theme-text-secondary);white-space:pre-wrap;max-height:80px;overflow-y:auto;line-height:1.4;background:var(--theme-content-bg);border-radius:var(--theme-radius-sm);margin-top:4px}
.toggle-sm{width:28px;height:16px;border-radius:8px}
.toggle-sm::after{width:12px;height:12px}

.preset-empty{padding:24px;text-align:center}
.worldbook-select-list{border:1px solid var(--theme-card-border);border-radius:var(--theme-radius-md);min-height:60px;padding:8px;display:flex;flex-direction:column;gap:2px}
.worldbook-checkbox{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;cursor:pointer;min-height:44px;transition:background 0.15s}
.worldbook-checkbox:hover{background:var(--theme-tab-hover-bg)}
.worldbook-checkbox input[type=checkbox]{width:18px;height:18px;cursor:pointer;margin:0;accent-color:var(--theme-color-primary,#15803D)}
.wb-check-label{flex:1;font-size:14px;font-weight:500}
.worldbook-list{display:flex;flex-direction:column;gap:10px}
.worldbook-card{display:flex;align-items:center;justify-content:space-between;gap:16px;transition:all 0.15s;border:1px solid var(--theme-card-border);border-radius:var(--theme-radius-lg, 12px)}
.worldbook-card:hover{border-color:color-mix(in srgb, var(--theme-primary) 25%, var(--theme-card-border));transform:translateY(-1px);box-shadow:0 2px 8px rgba(0,0,0,0.12)}
.wb-info{flex:1;min-width:0}
.wb-info h4{font-size:15px;margin:0 0 4px;display:flex;align-items:center;gap:8px}
.builtin-badge{font-size:11px;font-weight:500;padding:2px 8px;border-radius:10px;background:rgba(34,197,94,0.15);color:#22c55e;border:1px solid rgba(34,197,94,0.3)}

/* Toggle */
.toggle-label{display:flex;align-items:center;gap:10px;cursor:pointer}
.toggle-input{display:none}
.toggle-slider{width:40px;height:22px;border-radius:11px;background:var(--theme-card-border);transition:background var(--theme-transition-fast);position:relative}
.toggle-slider::after{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform var(--theme-transition-fast)}
.toggle-input:checked+.toggle-slider{background:var(--theme-success)}
.toggle-input:checked+.toggle-slider::after{transform:translateX(18px)}

/* Plot */
.genre-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px}
.genre-chip{display:flex;flex-direction:column;gap:2px;padding:12px 14px;border:1.5px solid var(--theme-card-border);border-radius:var(--theme-radius-md);cursor:pointer;transition:all var(--theme-transition-fast);user-select:none;background:var(--theme-card-bg)}
.genre-chip:hover{border-color:var(--theme-primary);transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,0.1)}
.genre-chip:hover{border-color:var(--theme-primary)}
.genre-active{border-color:var(--theme-primary);background:color-mix(in srgb,var(--theme-primary) 10%,var(--theme-card-bg))}
.genre-chip-label{font-weight:600;font-size:0.9rem;color:var(--theme-text-primary)}
.genre-active .genre-chip-label{color:var(--theme-primary)}
.genre-chip-desc{font-size:0.72rem;color:var(--theme-text-muted)}
.plot-preview-card{transition:all 0.3s ease}
.plot-preview-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.plot-preview-header h4{margin:0;font-size:0.95rem}
.plot-blur{filter:blur(6px);user-select:none;opacity:0.5;transition:all 0.3s ease;cursor:pointer}
.plot-preview-body{display:flex;flex-direction:column;gap:4px}

/* Theme */
.theme-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:14px}
.theme-option{position:relative;aspect-ratio:16/10;border:2px solid var(--theme-card-border);border-radius:var(--theme-radius-lg);cursor:pointer;transition:all var(--theme-transition-fast);overflow:hidden;display:flex;align-items:flex-end;padding:10px}
.theme-option:hover{transform:translateY(-3px);box-shadow:0 6px 20px color-mix(in srgb, #000 25%, transparent);border-color:color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border))}
.theme-selected{border-color:var(--theme-primary) !important;box-shadow:0 0 16px color-mix(in srgb,var(--theme-primary) 25%,transparent)}
.theme-name{font-size:0.75rem;font-weight:700;text-shadow:0 1px 3px rgba(0,0,0,0.6);letter-spacing:0.5px}
.theme-check{position:absolute;top:6px;right:6px;width:22px;height:22px;border-radius:50%;background:var(--theme-primary);color:#fff;display:flex;align-items:center;justify-content:center;font-size:0.7rem;font-weight:700;box-shadow:0 0 8px color-mix(in srgb, var(--theme-primary) 40%, transparent)}

/* Data */
.data-actions{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.data-actions h4{margin:0 0 4px;font-size:0.95rem}
.data-danger{border-color:color-mix(in srgb,var(--theme-error) 25%,transparent) !important;background:color-mix(in srgb,var(--theme-error) 3%,transparent)}
.data-danger:hover{border-color:color-mix(in srgb,var(--theme-error) 45%,transparent) !important}
.storage-bar-track{height:8px;border-radius:4px;background:var(--theme-card-border);overflow:hidden}
.storage-bar-fill{height:100%;border-radius:4px;background:linear-gradient(90deg,var(--theme-quality-common),var(--theme-quality-rare));transition:width 0.5s ease}

/* About */
.about-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.about-grid h4{margin:0 0 10px;font-size:0.95rem;color:var(--theme-text-primary);padding-bottom:8px;border-bottom:1px solid var(--theme-card-border)}
.about-table{display:flex;flex-direction:column;gap:6px}
.about-row{display:flex;justify-content:space-between;font-size:0.85rem;color:var(--theme-text-primary)}
.about-row span:first-child{color:var(--theme-text-muted)}
</style>
