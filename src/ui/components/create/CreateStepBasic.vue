<script setup lang="ts">
import { useCreateStore } from '../../stores/create-store'
import { ATTRIBUTE_NAMES } from '@engine/start-catalog'
import FormInput from '../shared/form/FormInput.vue'
import FormSelect from '../shared/form/FormSelect.vue'
import FormStepper from '../shared/form/FormStepper.vue'
import ResourceBar from '../shared/ResourceBar.vue'
import AttributeEditor from './AttributeEditor.vue'

const store = useCreateStore()
</script>

<template>
  <section class="step-basic">
    <!-- ====== 表单区: 两列 Grid ====== -->
    <div class="basic-grid">
      <!-- 左列: 角色信息 -->
      <div class="form-left">
        <h3 class="section-label">角色信息</h3>
        <FormInput v-model="store.name" label="角色名" placeholder="输入角色名称" />
        <FormSelect v-model="store.gender" label="性别" :options="store.GENDER_OPTIONS.map(g => ({ label: g, value: g }))" />
        <FormStepper v-model="store.age" label="年龄" :min="1" :max="999" />
        <FormSelect v-model="store.race" label="种族" :options="store.raceOptions" />
        <FormInput v-if="store.race === '自定义'" v-model="store.customRace" label="自定义种族" placeholder="输入种族名称" class="custom-field" />
        <FormSelect v-model="store.identity" label="身份" :options="store.identityOptions.map(id => ({ label: id, value: id }))" />
        <FormInput v-if="store.identity === '自定义'" v-model="store.customIdentity" label="自定义身份" placeholder="输入身份名称" class="custom-field" />
        <FormSelect v-model="store.startLocation" label="起始地点" :options="store.flatLocationOptions" placeholder="选择起始地点" />
      </div>

      <!-- 右列: 等级 + 属性面板 -->
      <div class="form-right">
        <!-- 等级 + 层级徽章 -->
        <div class="level-section">
          <FormStepper v-model="store.level" label="等级" :min="1" :max="25" class="level-stepper" />
          <div class="tier-badge">
            <span class="tier-name">T{{ store.tier }} {{ store.tierName }}</span>
            <span class="tier-range">
              Lv.{{ store.tier <= 1 ? '1-4' : store.tier <= 2 ? '5-8' : store.tier <= 3 ? '9-12' : store.tier <= 4 ? '13-16' : store.tier <= 5 ? '17-20' : store.tier <= 6 ? '21-24' : '25' }}
            </span>
          </div>
        </div>

        <!-- ★ 属性表格 (原版 5 列) -->
        <div class="attr-table-wrapper">
          <table class="attr-table">
            <thead>
              <tr>
                <th class="col-name">属性</th>
                <th class="col-bp">基础</th>
                <th class="col-tier">层级</th>
                <th class="col-ap">额外</th>
                <th class="col-result">结果</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="attr in ATTRIBUTE_NAMES" :key="attr">
                <td class="attr-name">{{ attr }}</td>
                <td class="attr-bp">
                  <AttributeEditor
                    :attr-key="attr" label=""
                    :model-value="store.basePoints[attr] || 0"
                    :max="store.BP_PER_ATTR_MAX" :remaining="store.remainingBP"
                    @inc="store.addBasePoint" @dec="store.removeBasePoint"
                  />
                </td>
                <td class="attr-tier-cell">
                  <span class="tier-bonus">+{{ store.tierBonus }}</span>
                </td>
                <td class="attr-ap">
                  <AttributeEditor
                    :attr-key="attr" label=""
                    :model-value="store.attributePoints[attr] || 0"
                    :max="99" :remaining="store.remainingAP"
                    @inc="store.addAttributePoint" @dec="store.removeAttributePoint"
                  />
                </td>
                <td class="attr-result-cell">
                  <strong>{{ store.finalAttributes[attr] }}</strong>
                </td>
              </tr>
            </tbody>
          </table>

          <!-- 点数状态 -->
          <div class="points-status">
            <span class="bp-status" :class="{ exhausted: store.remainingBP === 0 }">
              基础点数: <strong>{{ store.usedBP }}</strong> / {{ store.MAX_BP }}
              <span v-if="store.remainingBP > 0" class="remaining">剩余 {{ store.remainingBP }}</span>
            </span>
            <span class="divider">|</span>
            <span class="ap-status" :class="{ over: store.remainingAP < 0 }">
              额外点数: <strong>{{ store.usedAP }}</strong> / {{ store.maxAP }}
              <span v-if="store.remainingAP > 0" class="remaining">剩余 {{ store.remainingAP }}</span>
            </span>
          </div>
        </div>

        <!-- ResourceBar 预览 (比原版好的功能，保留) -->
        <div class="preview-section">
          <h3 class="section-label">资源预览</h3>
          <div class="preview-bars">
            <ResourceBar label="HP" :current="store.hpPreview" :max="store.hpPreview" color="var(--theme-hp, #e74c3c)" />
            <ResourceBar label="MP" :current="store.mpPreview" :max="store.mpPreview" color="var(--theme-mp, #3498db)" />
            <ResourceBar label="SP" :current="store.spPreview" :max="store.spPreview" color="var(--theme-sp, #f1c40f)" />
          </div>
        </div>

        <!-- 经济 -->
        <div class="money-section">
          <h3 class="section-label">初始资源</h3>
          <div class="money-row">
            <div class="money-item">
              <FormStepper v-model="store.money" label="金钱 (G)" :min="0" :max="99999" :step="100" />
              <span class="cost-note">100G = 1 点</span>
            </div>
            <div class="money-item">
              <FormStepper v-model="store.destinyPoints" label="命运点数 (FP)" :min="0" :max="9999" />
              <span class="cost-note">2 FP = 1 点</span>
            </div>
          </div>
        </div>

        <!-- 消耗摘要 -->
        <div class="cost-summary">
          <span>种族「{{ store.race }}」{{ store.raceCost }}点</span>
          <span>身份「{{ store.identity }}」{{ store.identityCost }}点</span>
          <span>装备 {{ store.equipmentCost }} | 道具 {{ store.itemCost }} | 技能 {{ store.skillCost }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* ===== 容器 ===== */
.step-basic { max-width: 100%; margin: 0 auto; padding-bottom: 2.5em; }

/* ===== 两列 Grid ===== */
.basic-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--theme-spacing-xl);
  align-items: start;
}
@media (max-width: 768px) {
  .basic-grid { grid-template-columns: 1fr; gap: var(--theme-spacing-md); }
}

/* ===== 分区标题 ===== */
.section-label {
  font-size: 0.8rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--theme-text-muted);
  margin-bottom: var(--theme-spacing-sm);
  padding-bottom: 4px;
  border-bottom: 1px solid var(--theme-card-border);
}

/* ===== 左侧表单 ===== */
.form-left {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}
.custom-field {
  margin-top: -6px;
  padding-left: 2px;
  border-left: 2px solid var(--theme-color-primary);
  padding-left: var(--theme-spacing-sm);
}

/* ===== 右侧 ===== */
.form-right {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
}

/* ===== 等级 + 层级 ===== */
.level-section {
  display: flex;
  align-items: flex-end;
  gap: var(--theme-spacing-md);
}
.level-stepper { flex: 1; }
.tier-badge {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 4px 14px;
  border-radius: var(--theme-radius-md);
  background: linear-gradient(135deg, #d4af37 0%, #8b6914 100%);
  color: #fff;
  margin-bottom: 4px;
}
.tier-name {
  font-family: var(--theme-font-title, serif);
  font-weight: 800;
  font-size: 1rem;
  letter-spacing: 0.04em;
}
.tier-range {
  font-size: 0.6rem;
  opacity: 0.85;
}

/* ===== 属性表格 ===== */
.attr-table-wrapper {
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-lg);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
}
.attr-table {
  width: 100%;
  border-collapse: collapse;
}
.attr-table th {
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--theme-text-muted);
  padding: 4px 2px;
  text-align: center;
  border-bottom: 1px solid var(--theme-card-border);
}
.attr-table th.col-name { text-align: left; }
.attr-table td {
  padding: 3px 2px;
  vertical-align: middle;
}
.attr-table tbody tr:not(:last-child) td {
  border-bottom: 1px solid var(--theme-card-border);
}

/* 属性名 */
.attr-name {
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--theme-text-primary);
  padding-left: 2px !important;
}

/* tier 列 */
.attr-tier-cell {
  text-align: center;
}
.tier-bonus {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--theme-text-muted);
}

/* 结果列 */
.attr-result-cell {
  text-align: center;
}
.attr-result-cell strong {
  font-size: 1rem;
  color: var(--theme-color-primary);
  font-family: var(--theme-font-title, serif);
}

/* 移动端: 隐藏表头，改为标签行 */
@media (max-width: 480px) {
  .attr-table thead { display: none; }
  .attr-name { font-size: 0.75rem; min-width: 32px; }
}

/* ===== 点数状态 ===== */
.points-status {
  display: flex;
  justify-content: center;
  gap: var(--theme-spacing-sm);
  padding-top: var(--theme-spacing-sm);
  margin-top: var(--theme-spacing-xs);
  border-top: 1px solid var(--theme-card-border);
  font-size: 0.72rem;
  color: var(--theme-text-secondary);
}
.points-status .divider { color: var(--theme-card-border); }
.points-status .remaining { color: var(--theme-quality-优良); margin-left: 4px; }
.bp-status.exhausted .remaining { color: var(--theme-text-muted); }
.ap-status.over { color: var(--theme-quality-唯一); }

/* ===== ResourceBar 预览 ===== */
.preview-section {
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-lg);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
}
.preview-bars {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* ===== 经济 ===== */
.money-section {
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-lg);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
}
.money-row { display: flex; gap: var(--theme-spacing-lg); }
.money-item { flex: 1; }
.cost-note { font-size: 0.6rem; color: var(--theme-text-muted); }

/* ===== 消耗摘要 ===== */
.cost-summary {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs) var(--theme-spacing-lg);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: var(--theme-card-bg);
  border-radius: var(--theme-radius-md);
  font-size: 0.7rem;
  color: var(--theme-text-muted);
}
</style>
