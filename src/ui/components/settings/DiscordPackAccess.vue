<script setup lang="ts">
import { computed, ref } from 'vue';
import AppButton from '../shared/AppButton.vue';
import { useContentStore } from '../../stores/content-store';
import {
  discordSession,
  loginDiscord,
  logoutDiscord,
  verifyDiscordAccess,
} from '../../lib/discord-auth-client';

const content = useContentStore();
const busy = ref(false);
const error = ref('');
const expiry = computed(() =>
  content.leaseExpiresAt ? new Date(content.leaseExpiresAt).toLocaleString() : '尚无租约',
);
const inviteUrl = computed(() => {
  try {
    const url = new URL(discordSession.value?.access.inviteUrl ?? '');
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
});
async function act(operation: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await operation();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
async function revalidate() {
  await verifyDiscordAccess();
  if (content.protectedPack) await content.renewPackLease();
}
</script>

<template>
  <div class="discord-access" aria-label="Discord 内容授权">
    <p v-if="discordSession">
      Discord：{{ discordSession.user.displayName }}（{{ discordSession.user.id }}）
      <span> · {{ discordSession.access.message }}</span>
    </p>
    <p v-else>在线内容包需要登录 Discord 并通过社区资格验证。</p>
    <p v-if="content.protectedPack" role="status">
      {{ content.leaseMessage }}<br />
      绑定账号：{{ content.boundUserId ?? '旧包未绑定' }} · 有效期至：{{ expiry }}
    </p>
    <div class="discord-actions">
      <AppButton size="sm" :disabled="busy" @click="act(loginDiscord)">{{
        discordSession ? '切换 Discord 账号' : '登录 Discord'
      }}</AppButton>
      <AppButton
        v-if="discordSession"
        size="sm"
        variant="secondary"
        :disabled="busy"
        @click="act(revalidate)"
        >重新验证并续期</AppButton
      >
      <AppButton
        v-if="discordSession"
        size="sm"
        variant="ghost"
        :disabled="busy"
        @click="act(logoutDiscord)"
        >退出登录</AppButton
      >
      <a v-if="inviteUrl" :href="inviteUrl" target="_blank" rel="noopener noreferrer"
        >前往 Discord 社区</a
      >
    </div>
    <p v-if="error || content.leaseError" class="access-error" role="alert">
      {{ error || content.leaseError }}
    </p>
    <p class="text-muted text-sm">
      授权有效期内可离线使用；联网时自动复验并续期。退出、切换账号或资格撤销会立即锁定。授权内容的编辑仅在本次会话保留，不写入备份；本地
      JSON 导入仍是离线模式。
    </p>
  </div>
</template>

<style scoped>
.discord-access {
  padding: 0.75rem 0;
}
.discord-access p {
  margin: 0 0 0.6rem;
  overflow-wrap: anywhere;
}
.discord-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.6rem;
}
.access-error {
  color: var(--theme-danger, #c44);
}
</style>
