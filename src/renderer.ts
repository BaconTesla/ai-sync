import { libraryEntries, selectablePaths, skillFileTree, type LibraryEntry, type SkillTreeNode } from './library.js';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element ${id}`);
  return node as T;
}
const input = (id: string): HTMLInputElement => el<HTMLInputElement>(id);
let local: LocalState | undefined;
let plan: SyncPlan | undefined;
let filter = 'all';
let focusEntry = '';
let focusPath = '';
let busy = false;
let peers: TailnetPeer[] = [];
// Selection stays file-based at the IPC boundary; the UI adds/removes all eligible files of a Skill together.
const selected = new Set<string>();

function message(text: string, error = false): void {
  el('message').textContent = text;
  el('message').classList.toggle('error', error);
}
async function task(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  document.body.setAttribute('aria-busy', 'true');
  updateActions();
  try { await action(); }
  catch (e) { message((e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''), true); }
  finally { busy = false; document.body.setAttribute('aria-busy', 'false'); updateActions(); }
}
function mcpNames(content: string): string[] {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    const servers = value.mcpServers ?? value.mcp ?? value.mcp_servers;
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) return Object.keys(servers);
  } catch { /* Only projected MCP definitions are displayed, never raw settings. */ }
  return [];
}
function inventoryRows(): PlanRow[] {
  return (local?.inventory.files ?? []).map(f => ({ ...f, status: '相同', local: f.content, remote: '' }));
}
function entries(): LibraryEntry[] { return libraryEntries(plan?.rows ?? inventoryRows(), Boolean(plan)); }
function visibleEntries(): LibraryEntry[] {
  const query = input('search').value.trim().toLowerCase();
  return entries().filter(entry => (filter === 'all' || entry.kind === filter) &&
    `${entry.title} ${entry.path} ${entry.agent} ${entry.files.map(f => `${f.path} ${f.kind === 'MCP' ? mcpNames(plan ? f.remote : f.local).join(' ') : ''}`).join(' ')}`.toLowerCase().includes(query));
}
function selectedEntries(): LibraryEntry[] { return entries().filter(entry => entry.files.some(f => selected.has(f.path))); }
function peerLabel(peer: TailnetPeer): string {
  return [peer.name, peer.online ? '' : '离线', peer.ipv4, peer.os].filter(Boolean).join(' · ');
}
// 设备列表只用于本机选择目标，不参与同步内容；选中即把 IPv4 填进输入框，仍可手动改写。
function renderPeers(): void {
  const select = el<HTMLSelectElement>('peer-select');
  const chosen = peers.find(peer => peer.ipv4 === input('peer-host').value.trim());
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = peers.length ? '选择 Tailscale 设备…' : '未发现其他 Tailscale 设备，可手动填写 IP';
  select.append(placeholder);
  for (const peer of peers) {
    const option = document.createElement('option');
    option.value = peer.ipv4;
    option.textContent = peerLabel(peer);
    select.append(option);
  }
  select.value = chosen ? chosen.ipv4 : '';
}
async function loadPeers(): Promise<void> {
  try { peers = await window.sync.peers(); }
  catch { peers = []; }
  renderPeers();
}
function selectPeer(select: HTMLSelectElement): void {
  const peer = peers.find(item => item.ipv4 === select.value);
  if (!peer) return;
  input('peer-host').value = peer.ipv4;
  select.value = peer.ipv4;
  message(`${peer.name} · ${peer.ipv4}${peer.online ? '' : '，该设备当前离线'}`, !peer.online);
}
function updateActions(): void {
  for (const id of ['refresh', 'peer-reload', 'share', 'rotate', 'preview', 'backups', 'local-view', 'select-new', 'confirm-apply']) el<HTMLButtonElement>(id).disabled = busy;
  el<HTMLSelectElement>('peer-select').disabled = busy;
  el<HTMLButtonElement>('apply').disabled = busy || !plan || selected.size === 0;
  el('apply').textContent = `拉取所选 (${selectedEntries().length})`;
  for (const check of document.querySelectorAll<HTMLInputElement>('#inventory input[type=checkbox]')) check.disabled = busy || check.dataset.unchanged === 'true';
}
function showFile(row: PlanRow, entry: LibraryEntry): void {
  focusPath = row.path;
  el('detail-name').textContent = entry.title;
  const filename = entry.kind === 'Skill' ? row.path.slice(entry.path.length + 1) : 'MCP 服务定义';
  el('detail-meta').textContent = `${filename}${plan ? ` · ${row.status}` : ''}`;
  el('local-content').textContent = row.local || (row.status === '新增' ? '本机尚无此文件或 MCP 定义。' : '（空文件）');
  el('remote-content').textContent = row.remote || '（空文件）';
  el('remote-pane').hidden = !plan;
  document.querySelector('.diff')!.classList.toggle('comparing', Boolean(plan));
  const names = row.kind === 'MCP' ? mcpNames(plan ? row.remote : row.local) : [];
  el('service-info').hidden = names.length === 0;
  el('service-info').textContent = `MCP 服务声明：${names.join(' · ')}（未执行 / 未检查运行状态）`;
  for (const file of document.querySelectorAll<HTMLButtonElement>('#skill-tree [data-file-path]')) {
    const active = file.dataset.filePath === row.path;
    file.classList.toggle('active', active);
    file.setAttribute('aria-pressed', String(active));
  }
}
function renderTree(entry: LibraryEntry): void {
  el('skill-files').hidden = entry.kind !== 'Skill';
  const tree = el('skill-tree');
  tree.replaceChildren();
  if (entry.kind !== 'Skill') return;
  el('tree-summary').textContent = `${plan ? '对端' : '本机'} ${entry.files.length} 个可共享文件 · 点击查看内容`;
  const build = (nodes: SkillTreeNode[]): HTMLUListElement => {
    const list = document.createElement('ul');
    list.className = 'skill-tree-list';
    for (const node of nodes) {
      const item = document.createElement('li');
      if (node.children.length) {
        const folder = document.createElement('details');
        folder.open = true;
        const label = document.createElement('summary');
        label.textContent = node.name;
        folder.append(label, build(node.children));
        item.append(folder);
      } else if (node.file) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tree-file';
        button.dataset.filePath = node.file.path;
        button.textContent = `${node.name}${plan ? ` · ${node.file.status}` : ''}`;
        button.onclick = () => showFile(node.file!, entry);
        item.append(button);
      }
      list.append(item);
    }
    return list;
  };
  tree.append(build(skillFileTree(entry)));
}
function showEntry(entry: LibraryEntry): void {
  const previousFile = focusEntry === entry.id ? focusPath : '';
  focusEntry = entry.id;
  renderTree(entry);
  const row = entry.files.find(f => f.path === previousFile) ?? entry.files.find(f => f.path === entry.manifest) ?? entry.files[0];
  if (row) showFile(row, entry);
}
function clearDetails(): void {
  focusEntry = '';
  focusPath = '';
  el('detail-name').textContent = '选择一个 Skill 或 MCP';
  el('detail-meta').textContent = '内容预览';
  el('local-content').textContent = '点击左侧 Skill 查看文件树，再选择文件预览内容。';
  el('remote-pane').hidden = true;
  el('service-info').hidden = true;
  el('skill-files').hidden = true;
  el('skill-tree').replaceChildren();
  document.querySelector('.diff')!.classList.remove('comparing');
}
function renderRows(): void {
  const list = el('inventory');
  list.replaceChildren();
  const visible = visibleEntries();
  if (focusEntry && !visible.some(entry => entry.id === focusEntry)) clearDetails();
  for (const entry of visible) {
    const item = document.createElement('div');
    item.className = 'file-row';
    item.classList.toggle('focused', entry.id === focusEntry);
    item.dataset.entryId = entry.id;
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', `${entry.agent} ${entry.title}${plan ? ` ${entry.status}` : ''}`);
    if (plan) {
      const check = document.createElement('input');
      check.type = 'checkbox';
      const paths = selectablePaths(entry);
      check.checked = paths.length > 0 && paths.every(p => selected.has(p));
      check.dataset.unchanged = String(entry.status === '相同');
      check.disabled = entry.status === '相同' || busy;
      check.setAttribute('aria-label', `选择${entry.kind === 'Skill' ? '整个 Skill' : ' MCP 服务组'} ${entry.title}`);
      check.onclick = e => e.stopPropagation();
      check.onchange = () => { for (const p of paths) check.checked ? selected.add(p) : selected.delete(p); updateActions(); };
      item.append(check);
    }
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = entry.kind === 'Skill' ? '✦' : '{ }';
    const info = document.createElement('div');
    info.className = 'file-info';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = entry.title;
    const relative = document.createElement('div');
    relative.className = 'file-path';
    relative.textContent = `~/${entry.path}`;
    const badges = document.createElement('div');
    badges.className = 'file-badges';
    const agent = document.createElement('span');
    agent.className = 'badge';
    agent.textContent = entry.agent;
    badges.append(agent);
    if (entry.kind === 'Skill') {
      const count = document.createElement('span');
      count.className = 'badge';
      count.textContent = `${entry.files.length} 个文件`;
      badges.append(count);
    }
    if (plan) {
      const status = document.createElement('span');
      status.className = `badge ${entry.status === '新增' ? 'new' : entry.status === '不同' ? 'changed' : ''}`;
      status.textContent = entry.status === '不同' ? entry.kind === 'MCP' ? '不同 · 合并服务' : '存在文件差异' : entry.status;
      badges.append(status);
    }
    info.append(name, relative, badges);
    item.append(icon, info);
    item.onclick = () => { showEntry(entry); renderRows(); };
    item.onkeydown = e => { if (e.target === item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); showEntry(entry); renderRows(); } };
    list.append(item);
  }
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = input('search').value || filter !== 'all' ? '没有匹配的 Skill 或 MCP。' : plan ? '对端没有可同步的 Skill 或 MCP。检查被排除的文件与支持路径。' : '还没有发现可共享的 Skills 或 MCP。\nSkill 目录中需要有 SKILL.md；没有 MCP 定义的设置文件不会出现在这里。';
    list.append(empty);
  }
  el('inventory-title').textContent = plan ? '同步预览 · 对端 → 本机' : '本机 Skills 与 MCP';
  el('inventory-subtitle').textContent = plan ? '按整个 Skill 勾选通过过滤的文件；MCP 只合并服务定义。预览有效 5 分钟。' : '一个 Skill 一项，点击查看文件树。只共享 Skills 与 MCP，不共享其他设置。';
  el('local-view').hidden = !plan;
  el('select-new').hidden = !plan;
  const skipped = plan?.skipped ?? local?.inventory.skipped ?? [];
  el('skipped-box').hidden = !skipped.length;
  el('skipped-summary').textContent = `被排除或无法读取的文件 (${skipped.length})`;
  el('skipped').textContent = skipped.join('\n');
  updateActions();
}
function clearPreview(): void { plan = undefined; selected.clear(); clearDetails(); }
async function refresh(): Promise<void> {
  local = await window.sync.state();
  el('device').firstChild!.textContent = local.device;
  input('bind').value = local.bind || local.addresses[0] || input('bind').value;
  input('listen-port').value = String(local.port);
  input('local-token').value = local.token;
  const library = libraryEntries(inventoryRows());
  el('file-count').textContent = String(library.length);
  el('skill-count').textContent = String(library.filter(entry => entry.kind === 'Skill').length);
  el('mcp-count').textContent = String(local.inventory.files.filter(f => f.kind === 'MCP').reduce((sum, f) => sum + mcpNames(f.content).length, 0));
  el('share-status').textContent = local.sharing ? '共享中' : '已关闭';
  el('address-label').textContent = local.sharing ? `${local.bind}:${local.port}` : local.addresses.join(' · ') || '未检测到 Tailscale IPv4';
  el('share').textContent = local.sharing ? '停止共享' : '开启共享';
  renderRows();
  await loadPeers();
}
el('refresh').onclick = () => void task(async () => { clearPreview(); await refresh(); message('本机 Skills 与 MCP 已刷新。'); });
el('share').onclick = () => void task(async () => {
  try { await window.sync.share({ enabled: !local?.sharing, host: input('bind').value.trim(), port: Number(input('listen-port').value) }); }
  finally { await refresh(); }
  message(local?.sharing ? '共享已开启：仅共享符合过滤规则的 Skills 和 MCP 服务定义，不发送其他设置。无需共享时请及时关闭。' : '共享已停止。');
});
el<HTMLSelectElement>('peer-select').onchange = event => selectPeer(event.currentTarget as HTMLSelectElement);
el('peer-reload').onclick = () => void task(async () => { await loadPeers(); message(peers.length ? `已读取 ${peers.length} 台 Tailscale 设备。` : '未读取到其他 Tailscale 设备，可手动填写对端 IP。'); });
el('rotate').onclick = () => void task(async () => { await window.sync.rotateToken(); await refresh(); message('令牌已重置，共享已关闭。请将新令牌安全地传给另一台设备。'); });
el('reveal').onclick = () => { const field = input('local-token'); field.type = field.type === 'password' ? 'text' : 'password'; el('reveal').textContent = field.type === 'password' ? '显示' : '隐藏'; };
el('preview').onclick = () => void task(async () => {
  clearPreview();
  renderRows();
  message('正在连接对端并校验快照…');
  plan = await window.sync.preview({ host: input('peer-host').value.trim(), port: Number(input('peer-port').value), token: input('peer-token').value.trim() });
  renderRows();
  const first = visibleEntries()[0];
  if (first) { showEntry(first); renderRows(); }
  message('预览就绪：Skill 已按名称分组，点击查看文件树和每个文件的差异；勾选会包含该 Skill 所有需要更新的可共享文件。MCP 只合并服务定义。');
});
el('local-view').onclick = () => { clearPreview(); renderRows(); };
el('select-new').onclick = () => { for (const entry of visibleEntries()) if (entry.status === '新增') for (const p of selectablePaths(entry)) selected.add(p); renderRows(); };
el('backups').onclick = () => void task(async () => { await window.sync.openBackups(); });
input('search').oninput = renderRows;
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-filter]')) button.onclick = () => {
  filter = button.dataset.filter!;
  for (const sibling of document.querySelectorAll('[data-filter]')) sibling.classList.toggle('selected', sibling === button);
  renderRows();
};
el('apply').onclick = () => {
  if (!plan || !selected.size) return;
  const chosen = selectedEntries();
  const mcpCount = chosen.filter(entry => entry.kind === 'MCP').length;
  const skillCount = chosen.filter(entry => entry.kind === 'Skill').length;
  el('confirm-text').textContent = `将拉取 ${skillCount} 个 Skill、${mcpCount} 组 MCP 服务，共写入 ${selected.size} 个文件。Skill 中有变化的可共享文件一起更新（相同文件不重写，被安全过滤的文件不包含在内）。MCP 只添加或替换同名服务，保留本机独有服务及其他设置。写入前备份原文件。MCP 所在文件会重新排版，注释可能移除。`;
  el<HTMLDialogElement>('confirm-dialog').showModal();
};
el('cancel-apply').onclick = () => el<HTMLDialogElement>('confirm-dialog').close();
el('confirm-apply').onclick = () => {
  el<HTMLDialogElement>('confirm-dialog').close();
  void task(async () => {
    if (!plan) return;
    try {
      const result = await window.sync.apply({ id: plan.id, paths: [...selected] });
      clearPreview();
      await refresh();
      message(`已拉取 ${result.count} 个文件。覆盖的原文件备份：${result.backupDirectory}。新增文件无需备份。`);
    } catch (e) { clearPreview(); await refresh(); throw e; }
  });
};
void task(async () => { await refresh(); if (!local?.addresses.length) message('未检测到 Tailscale IPv4。可以先浏览本机 Skills 与 MCP；连接 Tailscale 后刷新，或手动填写本机 Tailscale IPv4。'); });
