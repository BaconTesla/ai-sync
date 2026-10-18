interface SyncFile {
  path: string;
  agent: string;
  kind: 'Skill' | 'MCP';
  hash: string;
  content: string;
}
interface ScanResult { files: SyncFile[]; skipped: string[] }
interface PeerInput { host: string; port: number; token: string }
interface PlanRow {
  path: string;
  agent: string;
  kind: SyncFile['kind'];
  status: '新增' | '不同' | '相同';
  local: string;
  remote: string;
}
interface SyncPlan { id: string; rows: PlanRow[]; skipped: string[] }
interface LocalState {
  device: string;
  addresses: string[];
  sharing: boolean;
  bind: string;
  port: number;
  token: string;
  inventory: ScanResult;
  backupDirectory: string;
}
interface SyncAPI {
  state(): Promise<LocalState>;
  share(input: { enabled: boolean; host: string; port: number }): Promise<void>;
  rotateToken(): Promise<void>;
  preview(peer: PeerInput): Promise<SyncPlan>;
  apply(input: { id: string; paths: string[] }): Promise<{ count: number; backupDirectory: string }>;
  openBackups(): Promise<void>;
}
interface Window { sync: SyncAPI }
