export type ColumnMeta = { name: string; dtype: 'number' | 'string' | 'datetime' | 'bool' };
export type FramePayload = { columns: ColumnMeta[]; rows: unknown[][]; row_count: number };

export class ApiError extends Error {}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, init);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = data?.detail;
    throw new ApiError(typeof detail === 'string' ? detail : JSON.stringify(detail ?? res.statusText));
  }
  return data as T;
}

export const api = {
  get: <T = any>(url: string) => request<T>('GET', url),
  post: <T = any>(url: string, body?: unknown) => request<T>('POST', url, body),
  put: <T = any>(url: string, body?: unknown) => request<T>('PUT', url, body),
  del: <T = any>(url: string) => request<T>('DELETE', url),
};

export type Equipment = {
  id: number;
  name: string;
  factory: string;
  product: string;
  project: string;
  process: string;
  ip: string;
  access_method: 'fs' | 'ftp' | 'sftp' | 'agent';
  port: number | null;
  username: string;
  password: string;
  log_path: string;
  file_pattern: string;
  lookback_days: number;
  encoding: string;
  capture_interval_sec: number;
  enabled: boolean;
  parser_id: number | null;
  parser_name?: string | null;
  options: Record<string, unknown>;
  description: string;
  status: string;
  running?: boolean;
  last_capture_at: string | null;
  last_success_at: string | null;
  last_error: string;
  file_count?: number;
  record_count?: number;
};

export type Parser = { id: number; name: string; description: string; code: string; updated_at: string; used_by?: number };

export type ParamSpec = {
  name: string;
  label?: string;
  type: 'string' | 'text' | 'number' | 'boolean' | 'select' | 'column' | 'columns' | 'json';
  default?: unknown;
  options?: string[];
  help?: string;
};

export type NodeType = {
  id: number;
  key: string;
  name: string;
  category: string;
  description: string;
  color: string;
  inputs: number;
  params: ParamSpec[];
  code: string;
};

export type FlowKind = 'match' | 'analysis';
export type FlowSummary = {
  id: number;
  name: string;
  kind: FlowKind;
  description: string;
  schedule_minutes: number;
  last_run_at: string | null;
  last_status: string;
  last_error: string;
  node_count: number;
  outputs: string[];
  updated_at: string;
};

export type Dataset = {
  id: number;
  name: string;
  flow_id: number | null;
  flow_name?: string | null;
  columns: ColumnMeta[];
  row_count: number;
  updated_at: string;
};

export type NodeRunStatus = {
  status: 'ok' | 'error' | 'skipped' | 'disabled';
  rows?: number;
  columns?: ColumnMeta[];
  ms?: number;
  error?: string;
  detail?: string;
};

export type GraphStatus = {
  enabled: boolean;
  connected: boolean;
  address?: string;
  version?: string;
  error?: string;
  graphs?: { graph: string; product_key: string; resources: string[]; updated_at: string; products: number }[];
};

export type Outcome = { stage: string; field: string; value: string; bad: boolean };
export type ImpactItem = {
  product: string;
  label: string;
  keyed: boolean;
  reasons: { via: 'resource' | 'equipment'; kind: string; value: string; stage: string; equipment: string | null; dt: number }[];
  min_dt: number;
  shared_resource: boolean;
  outcomes: Outcome[];
  bad: boolean;
};
export type Impact = {
  origin: { id: string; label: string; outcomes: Outcome[] };
  hours: number;
  total: number;
  shown: number;
  by_resource: number;
  by_equipment: number;
  bad: number;
  items: ImpactItem[];
};

export function fmtTime(s?: string | null) {
  if (!s) return '-';
  return s.replace('T', ' ').slice(0, 19);
}
