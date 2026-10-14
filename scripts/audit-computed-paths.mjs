#!/usr/bin/env node
/** Read-only migration audit of executable resource paths and test discovery. */
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function inspectResourcePaths(path, source, root = ROOT) {
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const paths = [], unresolved = [];
  const literal = n => n && ts.isStringLiteralLike(n) ? n.text : null;
  const visit = n => {
    if (ts.isNewExpression(n) && n.expression.getText(ast) === 'URL' && n.arguments?.length === 2 &&
        n.arguments[1].getText(ast) === 'import.meta.url') {
      const value = literal(n.arguments[0]);
      if (value !== null && value.startsWith('.')) paths.push({ expression: n.getText(ast), target: resolve(dirname(resolve(root, path)), value) });
      else unresolved.push(n.getText(ast));
    }
    if (ts.isCallExpression(n) && ['join', 'resolve'].includes(n.expression.getText(ast))) {
      const first = n.arguments[0];
      const isRoot = first && /^(?:REPO_ROOT|ROOT|deps\.ROOT)$/.test(first.getText(ast));
      const isRelativeResource = ['scripts', 'tests', 'schemas', 'apps', 'packages'].includes(literal(first));
      if (isRoot || isRelativeResource) {
        const rest = [...n.arguments].slice(isRoot ? 1 : 0);
        if (rest.every(a => literal(a) !== null)) {
          const value = rest.map(literal);
          // Runtime output, optional credential registries and generated builds have their own gates.
          if (!['evidence', 'dist', 'node_modules'].includes(value[0]) && !value.some(p => p.startsWith('.pi'))) {
            paths.push({ expression: n.getText(ast), target: resolve(root, ...value) });
          }
        } else unresolved.push(n.getText(ast));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(ast);
  return { paths: paths.map(p => ({ ...p, target: relative(root, p.target), exists: existsSync(p.target) })), unresolved };
}

export function inspectTestDiscovery(packagePath, source, root = ROOT) {
  const pkg = JSON.parse(source), paths = [], errors = [];
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    for (const m of command.matchAll(/node --test\s+([^&;]+)/g)) {
      for (const pattern of m[1].trim().split(/\s+/).filter(p => !p.startsWith('-'))) {
        const unquoted = pattern.replace(/^["']|["']$/g, '');
        const matches = globSync(unquoted, { cwd: dirname(resolve(root, packagePath)) });
        paths.push({ packagePath, script: name, pattern, matches: matches.length });
        if (!matches.length) errors.push(`Empty test discovery: ${packagePath} ${name} ${pattern}`);
      }
    }
  }
  return { paths, errors };
}

export function auditComputedPaths(root = ROOT) {
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const resources = [], unresolved = [], discovery = [], errors = [];
  for (const path of paths) {
    if (!existsSync(resolve(root, path))) continue;
    if (/^(?:apps|packages|scripts|tests)\//.test(path) && /\.(?:ts|mjs|js)$/.test(path) && !path.includes('/fixtures/')) {
      const report = inspectResourcePaths(path, readFileSync(resolve(root, path), 'utf8'), root);
      resources.push(...report.paths.map(p => ({ owner: path, ...p })));
      unresolved.push(...report.unresolved.map(expression => ({ owner: path, expression })));
    }
    if (/^(?:package\.json|(?:apps|packages)\/[^/]+\/package\.json)$/.test(path)) {
      const report = inspectTestDiscovery(path, readFileSync(resolve(root, path), 'utf8'), root);
      discovery.push(...report.paths); errors.push(...report.errors);
    }
  }
  for (const p of resources) if (!p.exists) errors.push(`Missing computed resource: ${p.owner} -> ${p.target}`);
  return {
    schema: 'treeai-computed-paths-v1', resources, discovery, unresolved, errors,
    limitations: [
      'Only import.meta URL and literal root-relative join/resolve inputs are resolved; unresolved expressions are enumerated, never assumed PASS.',
      'Generated output, optional provider registries, installed bundles and dynamic fixture recipes require verifier/browser/package execution.',
      'This report is structural evidence, not physical installation, model quality or human acceptance.',
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && !(args.length === 2 && args[0] === '--out' && args[1] && !args[1].startsWith('--'))) {
    console.error('Usage: node scripts/audit-computed-paths.mjs [--out report.json]'); process.exitCode = 1;
  } else {
    const report = auditComputedPaths();
    if (args.length) writeFileSync(resolve(args[1]), JSON.stringify(report, null, 2) + '\n');
    console.log(`${report.errors.length ? 'FAIL' : 'PASS'}: ${report.resources.length} resolved resources, ${report.discovery.length} test globs; ${report.unresolved.length} computed expressions require runtime gates`);
    for (const error of report.errors) console.error(error);
    process.exitCode = report.errors.length ? 1 : 0;
  }
}
