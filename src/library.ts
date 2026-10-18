/** Pure library view model, shared by the browser, scanner and tests. No filesystem or DOM access. */
export interface LibraryEntry {
  id: string;
  path: string;
  title: string;
  agent: string;
  kind: SyncFile['kind'];
  status: PlanRow['status'];
  files: PlanRow[];
  manifest?: string;
}
export interface SkillTreeNode {
  name: string;
  path: string;
  children: SkillTreeNode[];
  file?: PlanRow;
}
export function skillDirectories(paths: string[]): string[] {
  return [...new Set(paths.filter(p => /(?:^|\/)SKILL\.md$/i.test(p)).map(p => p.slice(0, p.lastIndexOf('/'))))]
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
}
export function skillOwner(relative: string, directories: string[]): string | undefined {
  return directories.find(directory => relative.startsWith(`${directory}/`));
}
function skillName(content: string, directory: string): string {
  // A display-only convenience, not a YAML parser. Complex YAML names fall back to heading / directory.
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  let name = frontmatter ? /^name:[ \t]*([^\r\n]+)$/m.exec(frontmatter[1]!)?.[1]?.trim() : undefined;
  if (name?.startsWith('"')) { try { name = JSON.parse(name) as string; } catch { name = undefined; } }
  else if (name?.startsWith("'")) name = /^'(.*)'(?:\s+#.*)?$/.exec(name)?.[1]?.replace(/''/g, "'");
  else name = name?.replace(/\s+#.*$/, '').trim();
  if (typeof name !== 'string' || /^[>|[{&*!]/.test(name)) name = undefined;
  return (name || /^#\s+(.+)$/m.exec(content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ''))?.[1]?.trim() || directory.split('/').pop() || 'Skill').slice(0, 120);
}
export function libraryEntries(rows: PlanRow[], remote = false): LibraryEntry[] {
  const directories = skillDirectories(rows.filter(r => r.kind === 'Skill').map(r => r.path));
  const groups = new Map<string, LibraryEntry>();
  for (const row of rows) {
    const directory = row.kind === 'Skill' ? skillOwner(row.path, directories) : undefined;
    if (row.kind === 'Skill' && !directory) continue; // Loose files are not standalone Skills.
    const id = directory ?? row.path;
    let entry = groups.get(id);
    if (!entry) {
      entry = { id, path: id, title: row.kind === 'MCP' ? `MCP · ${row.path.split('/').pop()}` : '', agent: row.agent, kind: row.kind, status: '相同', files: [] };
      groups.set(id, entry);
    }
    entry.files.push(row);
  }
  for (const entry of groups.values()) {
    entry.files.sort((a, b) => a.path.localeCompare(b.path));
    entry.status = entry.files.every(f => f.status === '相同') ? '相同' : entry.files.every(f => f.status === '新增') ? '新增' : '不同';
    if (entry.kind === 'Skill') {
      const manifest = entry.files.find(f => f.path.slice(entry.path.length + 1).toLowerCase() === 'skill.md');
      entry.manifest = manifest?.path;
      entry.title = skillName(manifest ? remote ? manifest.remote : manifest.local : '', entry.path);
    }
  }
  return [...groups.values()].sort((a, b) => a.path.localeCompare(b.path));
}
export function selectablePaths(entry: LibraryEntry): string[] {
  return entry.files.filter(f => f.status !== '相同').map(f => f.path);
}
export function skillFileTree(entry: LibraryEntry): SkillTreeNode[] {
  const roots: SkillTreeNode[] = [];
  for (const file of entry.files) {
    const parts = file.path.slice(entry.path.length + 1).split('/');
    let nodes = roots;
    let prefix = entry.path;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!;
      prefix += `/${name}`;
      let node = nodes.find(n => n.path === prefix);
      if (!node) { node = { name, path: prefix, children: [] }; nodes.push(node); }
      if (i === parts.length - 1) node.file = file;
      nodes = node.children;
    }
  }
  const sort = (nodes: SkillTreeNode[]): void => {
    nodes.sort((a, b) => Number(Boolean(b.children.length)) - Number(Boolean(a.children.length)) || a.name.localeCompare(b.name));
    for (const node of nodes) sort(node.children);
  };
  sort(roots);
  return roots;
}
