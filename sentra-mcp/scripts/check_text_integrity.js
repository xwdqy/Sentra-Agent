import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const targetFiles = [
  'src/agent/stages/arggen.js',
  'src/agent/stages/reflection.js'
];

const checks = [
  { name: 'replacement-char', regex: /\uFFFD/g },
  { name: 'placeholder-question-run', regex: /\?{3,}/g },
  { name: 'common-mojibake-fragments', regex: /(鎵|鍘|绫诲|瑙|杩|姝|鎬|褰|瀹|鏍|楠|閿|欒|閲|柊)/g }
];

function lineColFromIndex(source, index) {
  const head = source.slice(0, index);
  const line = head.split('\n').length;
  const col = index - head.lastIndexOf('\n');
  return { line, col };
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(scriptDir, '..');
  const issues = [];

  for (const rel of targetFiles) {
    const abs = path.resolve(projectRoot, rel);
    const content = await fs.readFile(abs, 'utf8');

    for (const check of checks) {
      check.regex.lastIndex = 0;
      let match = null;
      while ((match = check.regex.exec(content)) !== null) {
        const { line, col } = lineColFromIndex(content, match.index);
        issues.push({
          file: rel,
          check: check.name,
          line,
          col,
          sample: String(match[0] || '')
        });
      }
    }
  }

  if (issues.length === 0) {
    console.log('text-integrity: ok');
    return;
  }

  console.error('text-integrity: found suspicious text fragments:');
  for (const it of issues) {
    console.error(`- ${it.file}:${it.line}:${it.col} [${it.check}] "${it.sample}"`);
  }
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`text-integrity: failed - ${String(err)}`);
  process.exitCode = 1;
});
