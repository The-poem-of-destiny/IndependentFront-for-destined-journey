<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import {
  BEAUTIFIER_FRAME_MESSAGE_SOURCE,
  BEAUTIFIER_FRAME_SANDBOX,
  buildBeautifierFrameDocument,
  collectThemeValues,
  createBeautifierBridgeId,
  isBeautifierFrameMessage,
  recommendedFrameMinHeight,
  type BeautifierFrameScriptPolicy,
  type BeautifierStorageEntry,
  type BeautifierStorageMutation,
} from '../../lib/beautifier-frame';
import {
  openBeautifierStorageSession,
  type BeautifierStorageSession,
} from '../../lib/beautifier-storage';

const props = withDefaults(
  defineProps<{
    markup: string;
    ruleName?: string;
    forwardContextMenu?: boolean;
    /** 见 `BeautifierFrameScriptPolicy`：规则作者 = `allow`，模型输出 = `block`。 */
    scripts?: BeautifierFrameScriptPolicy;
  }>(),
  {
    ruleName: '',
    forwardContextMenu: false,
    scripts: 'allow',
  },
);

/** 模型帧不参与共享正则命名空间，连会话都不开（少一个监听者，也少一份快照拷贝）。 */
const usesSharedStorage = computed(() => props.scripts === 'allow');

const emit = defineEmits<{
  resize: [height: number];
}>();

const frame = ref<HTMLIFrameElement>();
const bridgeId = ref(createBeautifierBridgeId());
const minimumHeight = computed(() => recommendedFrameMinHeight(props.markup));
const height = ref(Math.max(64, minimumHeight.value));
const storageEntries = shallowRef<BeautifierStorageEntry[] | null>(null);

const title = computed(() => (props.ruleName ? `美化内容：${props.ruleName}` : '美化内容'));
const srcdoc = computed(() => {
  if (storageEntries.value === null) return '';
  return buildBeautifierFrameDocument({
    markup: props.markup,
    bridgeId: bridgeId.value,
    forwardContextMenu: props.forwardContextMenu,
    storageEntries: storageEntries.value,
    scripts: props.scripts,
  });
});

function themeValues(): Record<string, string> {
  return collectThemeValues(getComputedStyle(document.documentElement));
}

function sendTheme(): void {
  frame.value?.contentWindow?.postMessage(
    {
      source: BEAUTIFIER_FRAME_MESSAGE_SOURCE,
      bridgeId: bridgeId.value,
      type: 'theme',
      values: themeValues(),
    },
    '*',
  );
}

function sendStorageSync(mutations: readonly BeautifierStorageMutation[]): void {
  frame.value?.contentWindow?.postMessage(
    {
      source: BEAUTIFIER_FRAME_MESSAGE_SOURCE,
      bridgeId: bridgeId.value,
      type: 'storage-sync',
      mutations,
    },
    '*',
  );
}

function sendStorageReset(entries: readonly BeautifierStorageEntry[]): void {
  frame.value?.contentWindow?.postMessage(
    {
      source: BEAUTIFIER_FRAME_MESSAGE_SOURCE,
      bridgeId: bridgeId.value,
      type: 'storage-reset',
      entries,
    },
    '*',
  );
}

let storageSession: BeautifierStorageSession | undefined;

async function commitStorage(mutations: readonly BeautifierStorageMutation[]): Promise<void> {
  const session = storageSession;
  if (!session) return;

  try {
    await session.commit(mutations);
    if (session !== storageSession) return;
    // Echoing the durable batch is normally a no-op in the source frame. It
    // also repairs its mirror if an earlier rejected batch forced a reset.
    sendStorageSync(mutations);
  } catch {
    if (session !== storageSession) return;
    const entries = session.snapshot();
    sendStorageReset(entries);
  }
}

function onMessage(event: MessageEvent): void {
  if (event.source !== frame.value?.contentWindow) return;
  if (!isBeautifierFrameMessage(event.data, bridgeId.value)) return;

  if (event.data.type === 'ready') {
    sendTheme();
    if (storageSession) sendStorageReset(storageSession.snapshot());
    return;
  }

  if (event.data.type === 'storage-mutate' && event.data.mutations) {
    void commitStorage(event.data.mutations);
    return;
  }

  if (event.data.type === 'height' && Number.isFinite(event.data.height)) {
    const nextHeight = Math.min(6000, Math.max(minimumHeight.value, Math.ceil(event.data.height!)));
    if (nextHeight === height.value) return;
    height.value = nextHeight;
    emit('resize', nextHeight);
    return;
  }

  if (event.data.type === 'contextmenu') {
    const el = frame.value;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + (event.data.x ?? 0),
        clientY: rect.top + (event.data.y ?? 0),
      }),
    );
  }
}

watch(
  () => [props.markup, props.forwardContextMenu] as const,
  () => {
    if (storageSession) storageEntries.value = storageSession.snapshot();
    bridgeId.value = createBeautifierBridgeId();
    height.value = Math.max(64, minimumHeight.value);
    nextTick(sendTheme);
  },
);

let themeObserver: MutationObserver | undefined;
let mounted = false;

onMounted(() => {
  mounted = true;
  window.addEventListener('message', onMessage);
  themeObserver = new MutationObserver(sendTheme);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme'],
  });

  if (!usesSharedStorage.value) {
    storageEntries.value = [];
    return;
  }

  void openBeautifierStorageSession((mutations) => {
    if (!storageSession) return;
    sendStorageSync(mutations);
  })
    .then((session) => {
      if (!mounted) {
        session.close();
        return;
      }
      storageSession = session;
      storageEntries.value = session.snapshot();
    })
    .catch(() => {
      // The storage module normally degrades to shared memory itself. Keep the
      // renderer usable even if session construction fails unexpectedly.
      if (mounted) storageEntries.value = [];
    });
});

onUnmounted(() => {
  mounted = false;
  window.removeEventListener('message', onMessage);
  themeObserver?.disconnect();
  storageSession?.close();
  storageSession = undefined;
});
</script>

<template>
  <iframe
    v-if="storageEntries !== null"
    ref="frame"
    class="beautifier-frame"
    :title="title"
    :srcdoc="srcdoc"
    :sandbox="BEAUTIFIER_FRAME_SANDBOX"
    credentialless
    referrerpolicy="no-referrer"
    loading="lazy"
    :style="{ height: `${height}px` }"
    @load="sendTheme"
  />
</template>

<style scoped>
.beautifier-frame {
  display: block;
  width: 100%;
  min-width: 0;
  border: 0;
  overflow: hidden;
  background: transparent;
}
</style>
