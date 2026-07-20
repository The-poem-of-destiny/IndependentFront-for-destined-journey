// Add "导出AI数据" button to CreateStepPlot.vue, below the export/import buttons
import { readFileSync, writeFileSync } from 'fs';

const path = 'src/ui/components/create/CreateStepPlot.vue';
let content = readFileSync(path, 'utf-8');

// Add button below the import button (before </div> closing outline-io-btns)
const btn = `          <button
            class="io-btn"
            :disabled="store.isPlotGenerating || !store.lastPlotGenerationMeta"
            @click="store.exportAIDebugDump()"
            title="导出本轮 AI 调用的完整数据（系统提示词 + 思维链 + 正文输出）"
          >
            AI数据
          </button>`;

// Insert before the closing </div> of outline-io-btns
const target = `            导入大纲
          </button>
        </div>`;
if (content.includes('AI数据')) {
  console.log('Already added');
} else {
  content = content.replace(
    target,
    `            导入大纲
          </button>
${btn}
        </div>`
  );
  writeFileSync(path, content, 'utf-8');
  console.log('  ✓ Added AI export button');
}
