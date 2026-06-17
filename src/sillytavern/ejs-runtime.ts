/**
 * EJS 运行时 — 沙盒模板评估器 (Phase 4.6)
 *
 * ADR-04 修正: EJS 由 Code 层在提示装配时评估，结果注入 variableContent
 *
 * 特性:
 * - 沙盒 eval (new Function, 非 raw eval)
 * - Token 化解析 (<%_ / _%> / <%= / <%- / %>)
 * - getMessageVar/setMessageVar 隔离在 mutations 缓冲区
 * - Math.random() 原生支持
 * - 错误隔离: 单模板失败不中止批量
 */

// ========== Types ==========

export interface EjsRuntimeConfig {
  /** 当前变量快照 (getMessageVar 读取) */
  variables: Record<string, any>;
  /** 可选: 已存在的 mutations 缓冲区 (setMessageVar 写入) */
  mutations?: Record<string, any>;
}

export interface EjsRenderResult {
  rendered: string;
  mutations: Record<string, any>;
  errors: string[];
}

interface EjsToken {
  type: 'text' | 'code' | 'output' | 'unescaped';
  content: string;
}

// ========== Tokenizer ==========

function tokenize(template: string): EjsToken[] {
  const tokens: EjsToken[] = [];
  let pos = 0;

  while (pos < template.length) {
    // Find next EJS delimiter
    const nextOpen = template.indexOf('<%', pos);

    if (nextOpen === -1) {
      // No more EJS — rest is text
      tokens.push({ type: 'text', content: template.slice(pos) });
      break;
    }

    // Text before this EJS block
    if (nextOpen > pos) {
      tokens.push({ type: 'text', content: template.slice(pos, nextOpen) });
    }

    // Determine EJS type
    const afterOpen = template.slice(nextOpen + 2);
    let type: EjsToken['type'];
    let codeStart = 0;

    if (afterOpen.startsWith('_')) {
      type = 'code'; // <%_ ... _%> — trim-mode code
      codeStart = 1;
    } else if (afterOpen.startsWith('=')) {
      type = 'output'; // <%= ... %>
      codeStart = 1;
    } else if (afterOpen.startsWith('-')) {
      type = 'unescaped'; // <%- ... %>
      codeStart = 1;
    } else {
      type = 'code'; // <% ... %>
    }

    // Find matching close
    const closePatterns = type === 'code' ? ['_%>', '%>'] : ['%>'];
    let closestClose = -1;
    let closeLen = 0;

    for (const pat of closePatterns) {
      const idx = afterOpen.indexOf(pat, codeStart);
      if (idx !== -1 && (closestClose === -1 || idx < closestClose)) {
        closestClose = idx;
        closeLen = pat.length;
      }
    }

    if (closestClose === -1) {
      // Unclosed EJS — treat as text
      tokens.push({ type: 'text', content: template.slice(nextOpen) });
      break;
    }

    const code = afterOpen.slice(codeStart, closestClose).trim();
    tokens.push({ type, content: code });

    pos = nextOpen + 2 + closestClose + closeLen;
  }

  return tokens;
}

// ========== Sandbox ==========

function createSandbox(variables: Record<string, any>, mutations: Record<string, any>) {
  const getMessageVar = (path: string): any => {
    const parts = path.replace(/^stat_data\.?/, '').split('.');
    let value: any = { ...variables, ...mutations };
    for (const p of parts) {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== 'object') return undefined;
      value = value[p];
    }
    return value;
  };

  const setMessageVar = (path: string, val: any): void => {
    const parts = path.replace(/^stat_data\.?/, '').split('.');
    let current: any = mutations;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]] || typeof current[parts[i]] !== 'object') {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = val;
  };

  return { getMessageVar, setMessageVar, Math, JSON };
}

// ========== EjsRuntime ==========

export class EjsRuntime {
  private variables: Record<string, any>;
  private mutations: Record<string, any>;

  constructor(config: EjsRuntimeConfig) {
    this.variables = config.variables ?? {};
    this.mutations = config.mutations ?? {};
  }

  /** 渲染单个 EJS 模板字符串 */
  render(template: string): EjsRenderResult {
    const errors: string[] = [];
    const outputs: string[] = [];
    const sandbox = createSandbox(this.variables, this.mutations);

    const tokens = tokenize(template);

    for (const token of tokens) {
      if (token.type === 'text') {
        outputs.push(token.content);
        continue;
      }

      try {
        if (token.type === 'code') {
          // Execute code (no output)
          const fn = new Function(
            'getMessageVar', 'setMessageVar', 'Math', 'JSON',
            token.content,
          );
          fn(sandbox.getMessageVar, sandbox.setMessageVar, sandbox.Math, sandbox.JSON);
        } else {
          // Output expression
          const fn = new Function(
            'getMessageVar', 'setMessageVar', 'Math', 'JSON',
            `return (${token.content})`,
          );
          const result = fn(sandbox.getMessageVar, sandbox.setMessageVar, sandbox.Math, sandbox.JSON);

          if (result !== undefined && result !== null) {
            outputs.push(String(result));
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`EJS 块错误: ${msg.slice(0, 100)}`);
        // 失败的模板产生空输出（隔离）
      }
    }

    return {
      rendered: outputs.join(''),
      mutations: { ...this.mutations },
      errors,
    };
  }

  /** 批量渲染多个模板，合并 mutations */
  renderAll(templates: string[]): EjsRenderResult {
    const merged: EjsRenderResult = {
      rendered: '',
      mutations: { ...this.mutations },
      errors: [],
    };

    for (const tpl of templates) {
      const result = this.render(tpl);
      merged.rendered += result.rendered + '\n';
      Object.assign(this.mutations, result.mutations);
      merged.errors.push(...result.errors);
    }

    merged.mutations = { ...this.mutations };
    return merged;
  }

  /** 获取当前 mutations（供外部提交到 StateManager） */
  getMutations(): Record<string, any> {
    return { ...this.mutations };
  }
}

// ========== 便捷函数 ==========

/** 快速渲染单个 EJS 模板 */
export function renderEjs(
  template: string,
  variables: Record<string, any>,
): EjsRenderResult {
  return new EjsRuntime({ variables }).render(template);
}
