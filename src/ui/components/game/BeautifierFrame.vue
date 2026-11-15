<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import {
  BEAUTIFIER_FRAME_MESSAGE_SOURCE,
  BEAUTIFIER_FRAME_SANDBOX,
  buildBeautifierFrameDocument,
  collectThemeValues,
  createBeautifierBridgeId,
  isBeautifierCageInnerReady,
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
    /** 加固档（见 `lib/beautifier-hardening.ts`）：去掉 `http:` / `ws:` 并套 relay 牢笼帧。 */
    hardened?: boolean;
  }>(),
  {
    ruleName: '',
    forwardContextMenu: false,
    scripts: 'allow',
    hardened: false,
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
    hardened: props.hardened,
  });
});

/**
 * 当前文档的内层是否已就绪。加固档走 relay 牢笼：内层加载前宿主发出的消息会被牢笼
 * 丢掉，所以宿主 → 帧的消息一律等美化帧的 `ready`（或牢笼的 `inner-ready`）之后再发；
 * 之前丢掉的主题与存储状态由就绪时那一次 theme + storage-reset 补齐。非加固档行为不变。
 */
let innerReady = false;

function postToFrame(message: Record<string, unknown>): void {
  if (props.hardened && !innerReady) return;
  frame.value?.contentWindow?.postMessage(message, '*');
}

function themeValues(): Record<string, string> {
  return collectThemeValues(getComputedStyle(document.documentElement));
}

function sendTheme(): void {
  postToFrame({
    source: BEAUTIFIER_FRAME_MESSAGE_SOURCE,
    bridgeId: bridgeId.value,
    type: 'theme',
    values: themeValues(),
  });
}

function sendStorageSync(mutations: readonly BeautifierStorageMutation[]): void {
  postToFrame({
    source: BEAUTIFIER_FRAME_MESSAGE_SOURCE,
    bridgeId: bridgeId.value,
    type: 'storage-sync',
    mutations,
  });
}

function sendStorageReset(entries: readonly BeautifierStorageEntry[]): void {
  postToFrame({
    source: BEAUTIFIER_FRAME_MESSAGE_SOURCE,
    bridgeId: bridgeId.value,
    type: 'storage-reset',
    entries,
  });
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

function onFrameReady(): void {
  innerReady = true;
  sendTheme();
  if (storageSession) sendStorageReset(storageSession.snapshot());
}

function onMessage(event: MessageEvent): void {
  // 加固档下来源是牢笼帧窗口：它就是这个 iframe 元素的 contentWindow，校验照旧。
  if (event.source !== frame.value?.contentWindow) return;
  if (props.hardened && isBeautifierCageInnerReady(event.data, bridgeId.value)) {
    // 美化帧自己的 `ready` 通常先到；牢笼的 inner-ready 只是兜底，已就绪就不重复补发。
    if (!innerReady) onFrameReady();
    return;
  }
  if (!isBeautifierFrameMessage(event.data, bridgeId.value)) return;

  if (event.data.type === 'ready') {
    onFrameReady();
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
  () => [props.markup, props.forwardContextMenu, props.hardened] as const,
  () => {
    if (storageSession) storageEntries.value = storageSession.snapshot();
    innerReady = false;
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
