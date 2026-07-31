<script setup lang="ts">
/**
 * ③-A 音乐文件夹条（addendum §UI changes）
 *
 * 五种授权态各一副面孔：unsupported / none / prompt / granted / denied。
 * File System Access 的一切细节都在 store 与 audio-folder.ts 里，本组件只
 * 负责「说清现在是哪种状态、下一步该点哪个按钮」。
 */
import { computed, inject } from 'vue';
import { useAudioStore } from '../../../stores/audio-store';
import { useUIStore } from '../../../stores/ui-store';
import AppButton from '../../shared/AppButton.vue';
import { audioDialogsKey } from './dialogs';

const audio = useAudioStore();
const ui = useUIStore();
const dialogs = inject(audioDialogsKey)!;

/** 已收录在曲库里的「磁盘文件」曲目数（含暂时失联的） */
const fileTrackCount = computed(() => audio.tracks.filter((t) => t.source === 'file').length);

/**
 * 选择文件夹。用户取消时 store 静默返回 false（不是错误，不弹 toast）；
 * 但 picker 的其他异常会往外抛，这里兜住并提示，避免炸到组件外。
 */
async function chooseFolder(): Promise<void> {
  try {
    await audio.pickFolder();
  } catch {
    ui.toast('无法打开文件夹选择器，请检查浏览器权限设置。', 'error');
  }
}

async function grantFolder(): Promise<void> {
  try {
    const ok = await audio.grantFolderPermission();
    if (!ok) ui.toast('浏览器拒绝了音乐文件夹的访问授权。', 'warning');
  } catch {
    ui.toast('申请文件夹访问授权失败。', 'error');
  }
}

async function rescanFolder(): Promise<void> {
  try {
    await audio.rescanFolder();
  } catch {
    ui.toast('扫描音乐文件夹失败。', 'error');
  }
}

/** 取消关联只丢句柄；曲目行与播放列表位次都留着（addendum §forgetFolder） */
async function forgetFolder(): Promise<void> {
  const name = audio.folderName || '音乐文件夹';
  const ok = await dialogs.askConfirm({
    title: '取消关联音乐文件夹',
    message: `取消关联「${name}」？曲库记录与播放列表位次都会保留，重新选回同一个文件夹即可恢复播放。`,
    confirmLabel: '取消关联',
    danger: true,
  });
  if (!ok) return;
  try {
    await audio.forgetFolder();
  } catch {
    ui.toast('取消关联失败。', 'error');
  }
}
</script>

<template>
  <div class="folder-strip" :class="{ 'folder-strip-on': audio.folderPermission === 'granted' }">
    <template v-if="audio.folderPermission === 'unsupported'">
      <span class="folder-name">音乐文件夹</span>
      <span class="folder-note">
        当前浏览器不支持 File System Access，无法直接读取本地文件夹；上传的音频会存进浏览器存储。
      </span>
    </template>

    <template v-else-if="audio.folderPermission === 'none'">
      <span class="folder-name">音乐文件夹</span>
      <span class="folder-note">指定一个文件夹，音频留在原处，曲库只记录目录。</span>
      <AppButton variant="secondary" size="sm" @click="chooseFolder">选择音乐文件夹</AppButton>
    </template>

    <template v-else-if="audio.folderPermission === 'prompt'">
      <span class="folder-name">{{ audio.folderName || '音乐文件夹' }}</span>
      <span class="folder-note">浏览器每次启动后需要重新确认一次访问权限。</span>
      <AppButton variant="primary" size="sm" @click="grantFolder">授权访问音乐文件夹</AppButton>
      <!-- 换个文件夹 / 取消关联必须在这里也给出口，否则未授权态是个死胡同 -->
      <AppButton variant="secondary" size="sm" @click="chooseFolder">改选文件夹</AppButton>
      <AppButton variant="ghost" size="sm" @click="forgetFolder">取消关联</AppButton>
    </template>

    <template v-else-if="audio.folderPermission === 'granted'">
      <span class="folder-name">{{ audio.folderName || '音乐文件夹' }}</span>
      <span class="folder-note">已收录 {{ fileTrackCount }} 首本地曲目。</span>
      <AppButton variant="secondary" size="sm" :disabled="audio.scanning" @click="rescanFolder">
        {{ audio.scanning ? '扫描中…' : '重新扫描' }}
      </AppButton>
      <!-- 扫描中同样要禁用：在飞的对账循环会把刚标上的 missing 又写回可播放 -->
      <AppButton variant="ghost" size="sm" :disabled="audio.scanning" @click="forgetFolder">
        取消关联
      </AppButton>
    </template>

    <template v-else>
      <span class="folder-name">{{ audio.folderName || '音乐文件夹' }}</span>
      <span class="folder-note">浏览器拒绝了访问该文件夹，本地曲目暂时无法播放。</span>
      <AppButton variant="secondary" size="sm" @click="grantFolder">重新授权</AppButton>
      <!-- 浏览器里被永久阻止时重新授权是无效的，必须留下改选/取消两条出路 -->
      <AppButton variant="secondary" size="sm" @click="chooseFolder">改选文件夹</AppButton>
      <AppButton variant="ghost" size="sm" @click="forgetFolder">取消关联</AppButton>
    </template>
  </div>
</template>

<style scoped>
/* ═══ 条状分组外壳 —— 与曲库的上传组 / 行内编辑共用同一副视觉 ═══ */
.folder-strip {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  margin-bottom: var(--theme-spacing-md);
  transition:
    background var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
}
.folder-strip-on {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}
/* 标题与说明的排版与曲库上传组保持一致（那边有一份等价规则） */
.folder-name {
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.folder-note {
  flex: 1;
  min-width: 12rem;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  line-height: 1.55;
}
</style>
