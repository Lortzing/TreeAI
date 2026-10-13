import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The JS audit is a CLI tool; tests exercise its resource/discovery contracts directly.
const { inspectResourcePaths, inspectTestDiscovery } = await import('../../scripts/audit-computed-paths.mjs');

test('computed resource audit catches a moved Worker URL and preserves unresolved dynamic paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'treeai-resource-audit-'));
  try {
    mkdirSync(join(root, 'src', 'import'), { recursive: true });
    writeFileSync(join(root, 'src', 'parse-worker.ts'), '');
    const report = inspectResourcePaths('src/import/executor.ts', `
      new Worker(new URL('../parse-worker.ts', import.meta.url));
      new Worker(new URL('./parse-worker.ts', import.meta.url));
      join(ROOT, 'src', dynamicName);
    `, root);
    assert.deepEqual(report.paths.map(p => p.exists), [true, false]);
    assert.equal(report.unresolved.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('computed discovery audit expands quoted globs and rejects a stranded test entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'treeai-discovery-audit-'));
  try {
    mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'tests', 'original.test.ts'), '');
    const report = inspectTestDiscovery('package.json', JSON.stringify({ scripts: {
      test: `node --test "tests/*.test.ts" && node --test 'missing/*.test.ts'`,
    } }), root);
    assert.deepEqual(report.paths.map(p => p.matches), [1, 0]);
    assert.equal(report.errors.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
