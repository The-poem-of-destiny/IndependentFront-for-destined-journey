import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
it.each(['dev.bat', 'dev.sh'])('%s never terminates unidentified port owners', (file) => {
  const source = readFileSync(file, 'utf8');
  expect(source).not.toMatch(/^\s*(?:taskkill\s|kill\s+-9)/m);
  expect(source).toContain('--strictPort');
});
