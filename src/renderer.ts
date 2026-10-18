function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element ${id}`);
  return node as T;
}
const input = (id: string): HTMLInputElement => el<HTMLInputElement>(id);
let local: LocalState | undefined;
let plan: SyncPlan | undefined;
let filter = 'all';
let focusPath = '';
let busy = false;
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
    const servers = value.mcpServers ?? value.mcp;
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) return Object.keys(servers);
  } catch { /* TOML and JSONC remain available as raw text. Do not evaluate config. */ }
  return [...content.matchAll(/^\s*\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*$/gm)].map(m => m[1]!);
}
function skillTitle(content: string): string | undefined {
  return /^#\s+(.+)$/m.exec(content)?.[1]?.trim().slice(0, 100);
}
function visibleRows(): PlanRow[] {
  const rows = plan?.rows ?? (local?.inventory.files ?? []).map(f => ({ ...f, status: '相同' as const, local: f.content, remote: '' }));
  const query = input('search').value.trim().toLowerCase();
  return rows.filter(r => (filter === 'all' || r.kind === filter) && `${r.path} ${r.agent} ${r.kind === 'MCP / 配置' ? mcpNames(plan ? r.remote : r.local).join(' ') : skillTitle(plan ? r.remote : r.local) ?? ''}`.toLowerCase().includes(query));
}
function updateActions(): void {
  for (const id of ['refresh', 'share', 'rotate', 'preview', 'backups', 'local-view', 'select-new', 'confirm-apply']) el<HTMLButtonElement>(id).disabled = busy;
  el<HTMLButtonElement>('apply').disabled = busy || !plan || selected.size === 0;
  el('apply').textContent = `拉取所选 (${selected.size})`;
  for (const check of document.querySelectorAll<HTMLInputElement>('#inventory input[type=checkbox]')) check.disabled = busy || check.dataset.unchanged === 'true';
}
function showRow(row: PlanRow): void {
  focusPath = row.path;
  el('detail-name').textContent = row.path.split('/').pop() ?? row.path;
  el('detail-meta').textContent = `${row.agent} · ${row.kind}${plan ? ` · ${row.status}` : ''}`;
  el('local-content').textContent = row.local || (row.status === '新增' ? '本机尚无此文件。' : '（空文件）');
  el('remote-content').textContent = row.remote || '（空文件）';
  el('remote-pane').hidden = !plan;
  document.querySelector('.diff')!.classList.toggle('comparing', Boolean(plan));
  const names = row.kind === 'MCP / 配置' ? mcpNames(plan ? row.remote : row.local) : [];
  el('service-info').hidden = names.length === 0;
  el('service-info').textContent = `MCP 服务声明：${names.join(' · ')}（未执行 / 未检查运行状态）`;
}
function renderRows(): void {
  const list = el('inventory');
  list.replaceChildren();
  const rows = visibleRows();
  for (const row of rows) {
    const item = document.createElement('div');
    item.className = 'file-row';
    item.classList.toggle('focused', row.path === focusPath);
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', `${row.agent} ${row.path}${plan ? ` ${row.status}` : ''}`);
    if (plan) {
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = selected.has(row.path);
      check.dataset.unchanged = String(row.status === '相同');
      check.disabled = row.status === '相同' || busy;
      check.setAttribute('aria-label', `选择 ${row.path}`);
      check.onclick = e => e.stopPropagation();
      check.onchange = () => { check.checked ? selected.add(row.path) : selected.delete(row.path); updateActions(); };
      item.append(check);
    }
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = row.kind === 'Skill' ? '✦' : '{ }';
    const info = document.createElement('div');
    info.className = 'file-info';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = row.kind === 'Skill' ? skillTitle(plan ? row.remote : row.local) ?? row.path.split('/').pop()! : row.path.split('/').pop()!;
    const relative = document.createElement('div');
    relative.className = 'file-path';
    relative.textContent = `~/${row.path}`;
    const badges = document.createElement('div');
    badges.className = 'file-badges';
    const agent = document.createElement('span');
    agent.className = 'badge';
    agent.textContent = row.agent;
    badges.append(agent);
    if (plan) {
      const status = document.createElement('span');
      status.className = `badge ${row.status === '新增' ? 'new' : row.status === '不同' ? 'changed' : ''}`;
      status.textContent = row.status === '不同' ? '不同 · 将覆盖' : row.status;
      badges.append(status);
    }
    info.append(name, relative, badges);
    item.append(icon, info);
    item.onclick = () => { showRow(row); renderRows(); };
    item.onkeydown = e => { if (e.target === item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); showRow(row); renderRows(); } };
    list.append(item);
  }
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = input('search').value || filter !== 'all' ? '没有匹配的文件。' : plan ? '对端没有可同步文件。检查被排除的文件与支持路径。' : '还没有发现配置。\n支持 Claude Code、Codex、Gemini CLI、OpenCode 和共享 Skills。';
    list.append(empty);
  }
  el('inventory-title').textContent = plan ? '同步预览 · 对端 → 本机' : '本机配置库';
  el('inventory-subtitle').textContent = plan ? '默认不勾选文件；不同文件将整份覆盖，预览 5 分钟内有效。' : '仅显示支持的 Agent 路径，不读取认证文件。';
  el('local-view').hidden = !plan;
  el('select-new').hidden = !plan;
  const skipped = plan?.skipped ?? local?.inventory.skipped ?? [];
  el('skipped-box').hidden = !skipped.length;
  el('skipped-summary').textContent = `被排除或无法读取的文件 (${skipped.length})`;
  el('skipped').textContent = skipped.join('\n');
  updateActions();
}
function clearPreview(): void {
  plan = undefined;
  selected.clear();
  focusPath = '';
  el('detail-name').textContent = '选择一个文件';
  el('detail-meta').textContent = '内容预览';
  el('local-content').textContent = '在左侧选择 Skill 或配置文件，查看内容。';
  el('remote-pane').hidden = true;
  el('service-info').hidden = true;
  document.querySelector('.diff')!.classList.remove('comparing');
}
async function refresh(): Promise<void> {
  local = await window.sync.state();
  el('device').firstChild!.textContent = local.device;
  input('bind').value = local.bind || local.addresses[0] || input('bind').value;
  input('listen-port').value = String(local.port);
  input('local-token').value = local.token;
  el('file-count').textContent = String(local.inventory.files.length);
  el('skill-count').textContent = String(local.inventory.files.filter(f => /(^|\/)SKILL\.md$/.test(f.path)).length);
  el('mcp-count').textContent = String(local.inventory.files.filter(f => f.kind === 'MCP / 配置').reduce((sum, f) => sum + mcpNames(f.content).length, 0));
  el('share-status').textContent = local.sharing ? '共享中' : '已关闭';
  el('address-label').textContent = local.sharing ? `${local.bind}:${local.port}` : local.addresses.join(' · ') || '未检测到 Tailscale IPv4';
  el('share').textContent = local.sharing ? '停止共享' : '开启共享';
  renderRows();
}
el('refresh').onclick = () => void task(async () => { clearPreview(); await refresh(); message('本机配置已刷新。'); });
el('share').onclick = () => void task(async () => {
  try { await window.sync.share({ enabled: !local?.sharing, host: input('bind').value.trim(), port: Number(input('listen-port').value) }); }
  finally { await refresh(); }
  message(local?.sharing ? '共享已开启：持有令牌的设备可以读取所有符合规则的配置。无需共享时请及时关闭。' : '共享已停止。');
});
el('rotate').onclick = () => void task(async () => { await window.sync.rotateToken(); await refresh(); message('令牌已重置，共享已关闭。请将新令牌安全地传给另一台设备。'); });
el('reveal').onclick = () => { const field = input('local-token'); field.type = field.type === 'password' ? 'text' : 'password'; el('reveal').textContent = field.type === 'password' ? '显示' : '隐藏'; };
el('preview').onclick = () => void task(async () => {
  clearPreview();
  renderRows();
  message('正在连接对端并校验快照…');
  plan = await window.sync.preview({ host: input('peer-host').value.trim(), port: Number(input('peer-port').value), token: input('peer-token').value.trim() });
  renderRows();
  if (plan.rows[0]) { showRow(plan.rows[0]); renderRows(); }
  message(`预览就绪：${plan.rows.filter(r => r.status === '新增').length} 个新增，${plan.rows.filter(r => r.status === '不同').length} 个不同。勾选需要拉取的文件；配置将整份写入，不进行字段合并。`);
});
el('local-view').onclick = () => { clearPreview(); renderRows(); };
el('select-new').onclick = () => { for (const row of visibleRows()) if (row.status === '新增') selected.add(row.path); renderRows(); };
el('backups').onclick = () => void task(async () => { await window.sync.openBackups(); });
input('search').oninput = renderRows;
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-filter]')) button.onclick = () => {
  filter = button.dataset.filter!;
  for (const sibling of document.querySelectorAll('[data-filter]')) sibling.classList.toggle('selected', sibling === button);
  renderRows();
};
el('apply').onclick = () => {
  if (!plan || !selected.size) return;
  const overwrites = plan.rows.filter(r => selected.has(r.path) && r.status === '不同').length;
  el('confirm-text').textContent = `将拉取 ${selected.size} 个文件，其中 ${overwrites} 个会覆盖本机已有内容。覆盖前会在本机应用数据目录保存原文件。`;
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
void task(async () => { await refresh(); if (!local?.addresses.length) message('未检测到 Tailscale IPv4。可以先浏览本机配置；连接 Tailscale 后刷新，或手动填写本机 Tailscale IPv4。'); });
