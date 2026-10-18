import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { libraryEntries, selectablePaths, skillFileTree } from '../library';
import { scan } from '../core/files';

function file(relative: string, local = '', remote = '', status: PlanRow['status'] = '相同', agent = 'Claude Code'): PlanRow {
  return { path: relative, local, remote, status, agent, kind: 'Skill' };
}
const root = '.claude/skills/review';

test('a Skill with many files produces one named library entry, not one item per file', () => {
  const entries = libraryEntries([
    file(`${root}/scripts/check.ts`, '# Not the Skill name'),
    file(`${root}/SKILL.md`, '---\nname: code-review\ndescription: Check code\n---\n# Long heading'),
    file(`${root}/references/examples.md`, '# Also not the Skill name'),
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.title, 'code-review');
  assert.equal(entries[0]?.files.length, 3);
  assert.equal(entries[0]?.manifest, `${root}/SKILL.md`);
});
test('Skill names fall back from simple frontmatter to manifest heading and directory name', () => {
  assert.equal(libraryEntries([file(`${root}/SKILL.md`, '# Review Skill')])[0]?.title, 'Review Skill');
  assert.equal(libraryEntries([file(`${root}/SKILL.md`, 'instructions only')])[0]?.title, 'review');
  assert.equal(libraryEntries([file(`${root}/SKILL.md`, "---\r\nname: 'Quoted Skill'\r\n---\r\n# Heading")])[0]?.title, 'Quoted Skill');
  assert.equal(libraryEntries([file(`${root}/SKILL.md`, '---\nname: >\n  Complex YAML\n---\n# Fallback')])[0]?.title, 'Fallback');
});
test('same-name Skills from different agents remain separate', () => {
  const entries = libraryEntries([
    file(`${root}/SKILL.md`, '# Same'),
    file('.codex/skills/review/SKILL.md', '# Same', '', '相同', 'Codex'),
  ]);
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0]?.id, entries[1]?.id);
});
test('nested Skills use the nearest manifest and never select the child Skill as part of its parent', () => {
  const entries = libraryEntries([
    file(`${root}/SKILL.md`, '# Parent'),
    file(`${root}/scripts/run.sh`, 'echo parent'),
    file(`${root}/nested/SKILL.md`, '# Child'),
    file(`${root}/nested/data/input.txt`, 'child input'),
  ]);
  const parent = entries.find(e => e.path === root)!;
  const child = entries.find(e => e.path.endsWith('/nested'))!;
  assert.equal(parent.files.length, 2);
  assert.equal(child.files.length, 2);
  assert.ok(parent.files.every(f => !f.path.includes('/nested/')));
});
test('file tree has real directory hierarchy and retains file paths and preview content', () => {
  const [entry] = libraryEntries([
    file(`${root}/SKILL.md`, '# Review'),
    file(`${root}/scripts/nested/run.ts`, 'console.log("demo")'),
    file(`${root}/assets/template.txt`, 'template'),
  ]);
  const tree = skillFileTree(entry!);
  assert.deepEqual(tree.map(n => n.name), ['assets', 'scripts', 'SKILL.md']);
  const run = tree[1]?.children[0]?.children[0];
  assert.equal(run?.path, `${root}/scripts/nested/run.ts`);
  assert.equal(run?.file?.local, 'console.log("demo")');
});
test('whole Skill selection includes changed and new files, but does not rewrite identical ones', () => {
  const [entry] = libraryEntries([
    file(`${root}/SKILL.md`, '# Review', '# Review', '相同'),
    file(`${root}/scripts/run.ts`, 'old', 'new', '不同'),
    file(`${root}/assets/template.txt`, '', 'new', '新增'),
  ], true);
  assert.equal(entry?.status, '不同');
  assert.deepEqual(selectablePaths(entry!), [`${root}/assets/template.txt`, `${root}/scripts/run.ts`]);
});
test('aggregate status distinguishes an entirely new Skill from a partially new or unchanged Skill', () => {
  assert.equal(libraryEntries([file(`${root}/SKILL.md`, '', '# New', '新增')], true)[0]?.status, '新增');
  assert.equal(libraryEntries([file(`${root}/SKILL.md`, '# Same', '# Same')], true)[0]?.status, '相同');
});
test('preview uses remote Skill name, while local inventory uses local name', () => {
  const rows = [file(`${root}/SKILL.md`, '---\nname: local-name\n---', '---\nname: remote-name\n---', '不同')];
  assert.equal(libraryEntries(rows)[0]?.title, 'local-name');
  assert.equal(libraryEntries(rows, true)[0]?.title, 'remote-name');
});
test('loose files do not become Skills, and MCP entries keep their separate behavior', () => {
  const entries = libraryEntries([
    file('.claude/skills/README.md', '# Collection readme'),
    file(`${root}/scripts/run.ts`, 'no manifest'),
    { path: '.claude.json', local: '{"mcpServers":{}}', remote: '', status: '相同', agent: 'Claude Code', kind: 'MCP' },
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.kind, 'MCP');
});
test('scanner shares recognized Skill files only; loose files and unsafe manifests are excluded', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'ai-sync-library-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, root, 'scripts'), { recursive: true });
  await mkdir(path.join(home, '.claude/skills/unsafe'), { recursive: true });
  await writeFile(path.join(home, root, 'SKILL.md'), '# Review');
  await writeFile(path.join(home, root, 'scripts/run.ts'), 'console.log("safe")');
  await writeFile(path.join(home, '.claude/skills/README.md'), '# Collection readme');
  await writeFile(path.join(home, '.claude/skills/unsafe/SKILL.md'), '{"token":"private-value"}');
  await writeFile(path.join(home, '.claude/skills/unsafe/helper.txt'), 'cannot identify Skill safely');
  const result = await scan(home);
  assert.deepEqual(result.files.map(f => f.path), [`${root}/scripts/run.ts`, `${root}/SKILL.md`].sort((a, b) => a.localeCompare(b)));
  assert.ok(result.skipped.some(s => s.includes('README.md')));
  assert.ok(result.skipped.some(s => s.includes('unsafe/helper.txt')));
});
