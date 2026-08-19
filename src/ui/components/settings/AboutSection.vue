<script setup lang="ts">
/**
 * 关于分区 —— 零状态，纯展示（Q-25 从 SettingsPage.vue 抽出）
 *
 * 首页“关于”入口会直接落到本分区。制作人员、项目概览、技术信息和许可证统一在这里
 * 展示，避免首页再维护一份内容会漂移的弹窗。
 */
import AppCard from '../shared/AppCard.vue';
import { VERSION } from '@engine/index';
import { useBranding } from '../../branding-defaults';

// 品牌面（D26）：分区标题与页脚署名随内容包走，未装包时是中性默认值
const { branding } = useBranding();
</script>

<template>
  <section class="section centered">
    <h3>关于{{ branding.shortName }}</h3>
    <div class="about-grid">
      <AppCard padding="md"
        ><h4>制作人员</h4>
        <div class="about-table">
          <div class="about-row"><span>项目开发</span><span>Richard</span></div>
          <div class="about-row"><span>AI 开发协作</span><span>Claude Code</span></div>
          <div class="about-row">
            <span>世界观设定</span><span>{{ branding.credits }}</span>
          </div>
        </div></AppCard
      ><AppCard padding="md"
        ><h4>项目信息</h4>
        <div class="about-table">
          <div class="about-row">
            <span>项目名称</span><span>{{ branding.shortName }}</span>
          </div>
          <div class="about-row">
            <span>引擎版本</span><span>{{ VERSION }}</span>
          </div>
          <div class="about-row">
            <span>项目类型</span><span>{{ branding.about }}</span>
          </div>
          <div class="about-row">
            <span>纪元</span><span>{{ branding.era }}</span>
          </div>
        </div></AppCard
      ><AppCard padding="md"
        ><h4>技术信息</h4>
        <div class="about-table">
          <div class="about-row"><span>前端框架</span><span>Vue 3 + Pinia</span></div>
          <div class="about-row"><span>构建工具</span><span>Vite</span></div>
          <div class="about-row"><span>本地数据库</span><span>Dexie.js (IndexedDB)</span></div>
          <div class="about-row"><span>开发语言</span><span>TypeScript</span></div>
        </div></AppCard
      >
      <AppCard
        v-if="branding.worldSummary.title || branding.worldSummary.lines.length"
        padding="md"
        class="about-world"
      >
        <h4>{{ branding.worldSummary.title || '世界概览' }}</h4>
        <p
          v-for="(line, index) in branding.worldSummary.lines"
          :key="index"
          class="world-summary-line"
        >
          {{ line }}
        </p>
      </AppCard>
    </div>
    <!--
      🔴 字体与图标署名 —— **不是可选装饰，是许可义务**（2026-08-05 自托管起）。
      Font Awesome 的图标按 **CC BY 4.0** 授权，该协议要求署名，而且是唯一一条
      要求**界面上可见**的：把许可证文件放进 dist 不足以满足它。
      三款字体是 SIL OFL 1.1，要求随分发附上许可证全文 —— 那部分靠 /licenses/ 下的
      静态文件满足，这里的链接是让人找得到它们。
      删这一段之前先读 THIRD-PARTY-NOTICES.md。
    -->
    <AppCard padding="md" class="about-licenses">
      <h4>字体与图标</h4>
      <p class="card-desc">
        本应用自带并分发下列字体，不从任何 CDN 加载。许可证全文随应用一起分发。
      </p>
      <div class="about-table">
        <div class="about-row">
          <span>Noto Sans SC / Noto Serif SC</span>
          <span>
            © Google Inc. ·
            <a href="/licenses/OFL-Noto-Sans-SC.txt" target="_blank" rel="noopener">OFL 1.1</a>
          </span>
        </div>
        <div class="about-row">
          <span>Cinzel</span>
          <span>
            © The Cinzel Project Authors ·
            <a href="/licenses/OFL-Cinzel.txt" target="_blank" rel="noopener">OFL 1.1</a>
          </span>
        </div>
        <div class="about-row">
          <span>Font Awesome Free 6.7.2</span>
          <span>
            © Fonticons, Inc. ·
            <a href="/licenses/Font-Awesome-Free.txt" target="_blank" rel="noopener"
              >图标 CC BY 4.0</a
            >
          </span>
        </div>
      </div>
    </AppCard>

    <p class="about-footer text-muted text-sm text-center">
      {{ branding.about
      }}<template v-if="branding.copyright"><br />{{ branding.copyright }}</template>
    </p>
  </section>
</template>

<!-- 共用外壳（.section>h3 / .section-desc / .form-* / .toggle-*）：唯一一份在 settings-chrome.css -->
<style scoped src="./settings-chrome.css"></style>

<style scoped>
/* About */
.about-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
}
.about-grid h4 {
  margin: 0 0 10px;
  font-size: 0.95rem;
  color: var(--theme-text-primary);
  padding-bottom: 8px;
  border-bottom: 1px solid var(--theme-card-border);
}
.about-table {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.about-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--theme-spacing-md);
  font-size: 0.85rem;
  color: var(--theme-text-primary);
}
.about-row span:first-child {
  color: var(--theme-text-muted);
  flex-shrink: 0;
}
.about-row span:last-child {
  text-align: right;
}
.about-world {
  grid-column: 1 / -1;
}
.world-summary-line {
  margin: 0;
  color: var(--theme-text-secondary);
  font-size: 0.85rem;
  line-height: 1.7;
}
.world-summary-line + .world-summary-line {
  margin-top: var(--theme-spacing-xs);
}
.about-footer {
  margin-top: var(--theme-spacing-lg);
}
/* 署名卡：整行宽（不进上面那个 auto-fill 网格），字号比引擎信息小一号 */
.about-licenses .about-row {
  font-size: 0.8rem;
  gap: var(--theme-spacing-md);
}
.about-licenses a {
  color: var(--theme-primary);
  text-decoration: none;
}
.about-licenses a:hover {
  text-decoration: underline;
}
</style>
