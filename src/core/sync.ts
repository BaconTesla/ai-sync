import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { assertSafeContent, describe, hash, MAX_FILES, MAX_TOTAL, readLocal, writeSynced } from './files';

type StoredRow = PlanRow & { expected: string | null };
export class SyncEngine {
  private plan?: { id: string; expires: number; rows: StoredRow[] };
  private applying = false;
  constructor(private home: string, private backups: string) {}

  async preview(snapshot: unknown): Promise<SyncPlan> {
    if (this.applying) throw new Error('同步正在进行');
    this.plan = undefined;
    if (!snapshot || typeof snapshot !== 'object') throw new Error('快照无效');
    const data = snapshot as Record<string, unknown>;
    if (data.version !== 1 || !Array.isArray(data.files) || data.files.length > MAX_FILES) throw new Error('快照版本或文件数量无效');
    const rows: StoredRow[] = [];
    const seen = new Set<string>();
    const skipped: string[] = [];
    let size = 0;
    for (const raw of data.files) {
      if (!raw || typeof raw !== 'object') throw new Error('文件格式无效');
      const file = raw as Record<string, unknown>;
      if (typeof file.path !== 'string' || typeof file.content !== 'string' || typeof file.hash !== 'string') throw new Error('文件字段无效');
      const info = describe(file.path);
      assertSafeContent(file.content);
      if (seen.has(file.path) || hash(file.content) !== file.hash) throw new Error('文件重复或校验失败');
      seen.add(file.path);
      size += Buffer.byteLength(file.content);
      if (size > MAX_TOTAL) throw new Error('快照总量过大');
      try {
        const local = await readLocal(this.home, file.path);
        rows.push({ path: file.path, ...info, status: local === null ? '新增' : hash(local) === file.hash ? '相同' : '不同', local: local ?? '', remote: file.content, expected: local === null ? null : hash(local) });
      } catch (e) { skipped.push(`${file.path}：${(e as Error).message}`); }
    }
    if (Array.isArray(data.skipped)) skipped.push(...data.skipped.filter((s): s is string => typeof s === 'string').slice(0, 1000).map(s => `对端：${s.slice(0, 500)}`));
    const id = randomUUID();
    this.plan = { id, expires: Date.now() + 5 * 60_000, rows };
    return { id, rows: rows.map(({ expected: _, ...row }) => row), skipped };
  }

  async apply(id: string, paths: string[]): Promise<{ count: number; backupDirectory: string }> {
    if (this.applying) throw new Error('同步正在进行');
    const plan = this.plan;
    if (!plan || plan.id !== id || plan.expires < Date.now()) throw new Error('预览已失效，请重新连接预览');
    if (!Array.isArray(paths) || paths.length === 0 || new Set(paths).size !== paths.length) throw new Error('请选择文件且不要重复');
    const selected = paths.map(p => {
      const row = plan.rows.find(r => r.path === p && r.status !== '相同');
      if (!row) throw new Error('选择了不在当前预览内的文件');
      return row;
    });
    this.applying = true;
    this.plan = undefined;
    const backupDirectory = path.join(this.backups, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
    let count = 0;
    try {
      // Validate the entire selection before the first write.
      for (const row of selected) {
        const current = await readLocal(this.home, row.path);
        if ((current === null ? null : hash(current)) !== row.expected) throw new Error(`${row.path} 已变化，请重新预览`);
      }
      for (const row of selected) {
        await writeSynced(this.home, backupDirectory, row.path, row.remote, row.expected);
        count++;
      }
      return { count, backupDirectory };
    } catch (e) {
      throw new Error(`已写入 ${count} 个文件；${(e as Error).message}。已有覆盖的备份位于 ${backupDirectory}`);
    } finally { this.applying = false; }
  }
}
