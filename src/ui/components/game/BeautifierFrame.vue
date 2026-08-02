<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  BEAUTIFIER_FRAME_CSP,
  BEAUTIFIER_FRAME_MESSAGE_SOURCE,
  BEAUTIFIER_FRAME_SANDBOX,
  buildBeautifierFrameDocument,
  collectThemeValues,
  createBeautifierBridgeId,
  isBeautifierFrameMessage,
  recommendedFrameMinHeight,
} from '../../lib/beautifier-frame';

const props = withDefaults(
  defineProps<{
    markup: string;
    ruleName?: string;
    forwardContextMenu?: boolean;
  }>(),
  {
    ruleName: '',
    forwardContextMenu: false,
  },
);

const emit = defineEmits<{
  resize: [height: number];
}>();

const frame = ref<HTMLIFrameElement>();
const bridgeId = ref(createBeautifierBridgeId());
const minimumHeight = computed(() => recommendedFrameMinHeight(props.markup));
const height = ref(Math.max(64, minimumHeight.value));

const title = computed(() => (props.ruleName ? `美化内容：${props.ruleName}` : '美化内容'));
const srcdoc = computed(() =>
  buildBeautifierFrameDocument({
    markup: props.markup,
    bridgeId: bridgeId.value,
    forwardContextMenu: props.forwardContextMenu,
  }),
);

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

function onMessage(event: MessageEvent): void {
  if (event.source !== frame.value?.contentWindow) return;
  if (!isBeautifierFrameMessage(event.data, bridgeId.value)) return;

  if (event.data.type === 'ready') {
    sendTheme();
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
    bridgeId.value = createBeautifierBridgeId();
    height.value = Math.max(64, minimumHeight.value);
    nextTick(sendTheme);
  },
);

let themeObserver: MutationObserver | undefined;

onMounted(() => {
  window.addEventListener('message', onMessage);
  themeObserver = new MutationObserver(sendTheme);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme'],
  });
});

onUnmounted(() => {
  window.removeEventListener('message', onMessage);
  themeObserver?.disconnect();
});
</script>

<template>
  <iframe
    ref="frame"
    class="beautifier-frame"
    :title="title"
    :srcdoc="srcdoc"
    :sandbox="BEAUTIFIER_FRAME_SANDBOX"
    :csp="BEAUTIFIER_FRAME_CSP"
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
