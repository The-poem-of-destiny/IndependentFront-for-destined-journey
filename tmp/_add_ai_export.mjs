// Add `lastPlotGenerationMeta` tracking to capture AI output data for export
import { readFileSync, writeFileSync } from 'fs';

const storePath = 'src/ui/stores/create-store.ts';
let content = readFileSync(storePath, 'utf-8');

// 1️⃣  Add the ref after plotGenerationError
const addRef = `  /** 最近一次大纲生成的完整 AI 数据（供导出） */
  const lastPlotGenerationMeta = ref<{
    messages: Array<{ role: string; content: string }>;
    rawResponse: string;
    reasoning?: string;
    model: string;
    timestamp: number;
  } | null>(null)`;

if (!content.includes('lastPlotGenerationMeta')) {
  content = content.replace(
    `  const plotGenerationError = ref<string | null>(null)`,
    `  const plotGenerationError = ref<string | null>(null)\n${addRef}`
  );
  console.log('  ✓ Added lastPlotGenerationMeta ref');
} else {
  console.log('  - lastPlotGenerationMeta already exists');
}

// 2️⃣ Capture data after successful generation (before pushOutlineHistory)
// Find: best = { parsed, raw: result.rawResponse }
const captureBlock = `
      // 保存本轮完整 AI 数据，供导出调试用
      lastPlotGenerationMeta.value = {
        messages: messages.map(m => ({ ...m })),
        rawResponse: best.raw,
        reasoning: (result as any).reasoning ?? undefined,
        model: llmParams.model,
        timestamp: Date.now(),
      }
`;
if (!content.includes('lastPlotGenerationMeta.value = {')) {
  content = content.replace(
    'best = { parsed, raw: result.rawResponse }',
    'best = { parsed, raw: result.rawResponse }' + captureBlock
  );
  console.log('  ✓ Added capture block');
} else {
  console.log('  - Capture block already exists');
}

// 3️⃣ Add exportDebugDump function
const exportFn = `
  /** 导出本轮 AI 调试数据（系统提示词 + 思维链 + 正文输出） */
  function exportAIDebugDump(): boolean {
    if (!lastPlotGenerationMeta.value) return false;
    const m = lastPlotGenerationMeta.value;
    const data = {
      exportedAt: new Date().toISOString(),
      model: m.model,
      timestamp: m.timestamp,
      systemPrompt: m.messages.find(msg => msg.role === 'system')?.content ?? '',
      userMessage: m.messages.find(msg => msg.role === 'user')?.content ?? '',
      allMessages: m.messages,
      reasoning: m.reasoning,
      rawResponse: m.rawResponse,
      parsedOutline: plotOutline.value ? {
        title: plotOutline.value.title,
        summary: plotOutline.value.summary,
        content: plotOutline.value.content,
        timeRange: plotOutline.value.timeRange,
      } : null,
      plotSettings: plotSettings.value,
    };
    try {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = \`AI调试数据-\${new Date().toISOString().slice(0, 10)}.json\`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return true;
    } catch { return false; }
  }`;

if (!content.includes('exportAIDebugDump')) {
  // Insert before the last return in the store
  content = content.replace(
    'generatePlotOutline, reviseOutline',
    `exportAIDebugDump,\n    lastPlotGenerationMeta,\n    generatePlotOutline, reviseOutline`
  );
  content = content.replace(
    '  function generatePlotOutline(): Promise<boolean> {',
    exportFn + '\n\n' + '  function generatePlotOutline(): Promise<boolean> {'
  );
  console.log('  ✓ Added exportAIDebugDump function');
} else {
  console.log('  - exportAIDebugDump already exists');
}

writeFileSync(storePath, content, 'utf-8');
console.log('Done!');
