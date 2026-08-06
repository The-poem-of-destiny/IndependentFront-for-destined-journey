<script setup lang="ts">
/**
 * 关于分区 —— 零状态，纯展示（Q-25 从 SettingsPage.vue 抽出）
 *
 * 这里的三张表是**手写常量**，不是从构建期喂进来的：改版本号/测试数还是要来改这个
 * 文件。之所以没顺手接上真实来源，是因为那是新功能而不是这次搬迁的一部分。
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
        ><h4>引擎信息</h4>
        <div class="about-table">
          <div class="about-row">
            <span>引擎版本</span><span>{{ VERSION }}</span>
          </div>
          <div class="about-row"><span>UI 版本</span><span>1.0.0</span></div>
          <div class="about-row"><span>构建时间</span><span>2026-06-15</span></div>
        </div></AppCard
      ><AppCard padding="md"
        ><h4>技术栈</h4>
        <div class="about-table">
          <div class="about-row"><span>框架</span><span>Vue 3.5 + Pinia 2</span></div>
          <div class="about-row"><span>构建</span><span>Vite 6</span></div>
          <div class="about-row"><span>数据库</span><span>Dexie.js (IndexedDB)</span></div>
          <div class="about-row"><span>语言</span><span>TypeScript 5.4</span></div>
        </div></AppCard
      ><AppCard padding="md"
        ><h4>引擎统计</h4>
        <div class="about-table">
          <div class="about-row"><span>引擎模块</span><span>41 模块</span></div>
          <div class="about-row"><span>单元测试</span><span>1978 tests</span></div>
          <div class="about-row"><span>主题</span><span>10 套</span></div>
          <!-- 纪元名是**内容**（D9/D26）：随内容包走，未装包时是中性缺省 -->
          <div class="about-row">
            <span>纪元</span><span>{{ branding.era }}</span>
          </div>
        </div></AppCard
      >
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
  font-size: 0.85rem;
  color: var(--theme-text-primary);
}
.about-row span:first-child {
  color: var(--theme-text-muted);
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
