import type {WorkflowNode} from '../micro/micro-contracts';
import {tempoModerato} from 'viem/chains';
import type {CallSite, FunctionHelp} from '../policy/policy-code';
import {POLICY_ACTION_LABEL} from '../policy/policy-actions';
import type {TempoRecord} from './tempo-api';
import {tempoMppView, type TempoMppView} from './tempo-mpp';
import {checkedTempoOperation, sameAddress, tempoDecimal, tempoExpiredUnexecuted, type TempoConfig, type TempoExecutionPolicy, type TempoMethod, type TempoOperation, type TempoPolicy} from './tempo-contracts';

export const TEMPO_METHOD_LABEL: Record<TempoMethod, string> = {...POLICY_ACTION_LABEL, withdraw: POLICY_ACTION_LABEL.close};
export function tempoTransactionLink(hash: unknown, config: TempoConfig): string | null {
  return config.network === 'tempo:testnet' && typeof hash === 'string' && /^0x[\da-fA-F]{64}$/.test(hash)
    ? `${tempoModerato.blockExplorers.default.url}/tx/${hash}` : null;
}
export function tempoRecordStatus(record: TempoRecord): string {
  let valid = false;
  try {
    const op = checkedTempoOperation(record.operation, record.policyId);
    valid = op.id === record.id && op.method === record.method && (!record.transactionHash || op.transactionHash?.toLowerCase() === record.transactionHash.toLowerCase());
  } catch { /* A local status alone cannot prove chain confirmation. */ }
  if (valid && record.operation?.status === 'settled') return 'Confirmed';
  if (valid && record.operation?.status === 'failed') return 'Failed on chain';
  if (record.phase === 'declined') return 'Declined in wallet';
  if (record.phase === 'sending' || record.phase === 'observed') return 'Not confirmed';
  return record.phase === 'preparing' ? 'Preparing' : 'Ready for wallet';
}
export interface TempoActivity {id: string; method: TempoMethod; status: string; amount: string | null; transactionHash?: string; blockNumber: string | null; local: boolean; purchase?: TempoMppView}
/** Merge actual service operations and durable owner requests. There are no inferred dates or withdrawals. */
export function tempoActivity(policy: TempoPolicy, config: TempoConfig, records: readonly TempoRecord[], operations: readonly TempoOperation[]): TempoActivity[] {
  const rows = new Map<string, TempoActivity>();
  for (const r of records) {
    if (r.policyId !== policy.id || r.chainId !== config.chainId || !sameAddress(r.owner, policy.owner)) continue;
    rows.set(r.id, {id: r.id, method: r.method, status: tempoRecordStatus(r), amount: r.options.amount ?? null,
      transactionHash: r.transactionHash ?? r.operation?.transactionHash ?? undefined, blockNumber: ['Confirmed', 'Failed on chain'].includes(tempoRecordStatus(r)) && r.operation?.blockNumber != null ? String(r.operation.blockNumber) : null, local: true});
  }
  for (const op of operations) {
    if (op.policyId !== policy.id) continue;
    try {checkedTempoOperation(op, policy.id, policy, config);} catch {continue;}
    const local = rows.get(op.id);
    // A contradictory service hash/method cannot be used to label a preserved local request confirmed.
    if (local && (local.method !== op.method || (local.transactionHash && op.transactionHash && local.transactionHash.toLowerCase() !== op.transactionHash.toLowerCase()))) continue;
    const units = op.execution?.amountUnits;
    const amount = ['deploy', 'fund', 'approve_deploy', 'approve_fund', 'execute'].includes(op.method) && units !== undefined ? tempoDecimal(units) : local?.amount ?? null;
    const expired = tempoExpiredUnexecuted(op);
    const purchase = tempoMppView(op, policy, config);
    rows.set(op.id, {id: op.id, method: op.method, status: op.status === 'settled' ? 'Confirmed' : op.status === 'failed' ? expired ? 'Expired, not executed' : 'Failed on chain' : local?.status ?? 'Not confirmed',
      amount, transactionHash: op.transactionHash ?? local?.transactionHash, blockNumber: !expired && ['settled', 'failed'].includes(op.status) && op.blockNumber != null ? String(op.blockNumber) : null, local: !!local, ...(purchase === undefined ? {} : {purchase})});
  }
  return [...rows.values()].sort((a, b) => {
    if (a.blockNumber !== null && b.blockNumber !== null) return BigInt(a.blockNumber) > BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) < BigInt(b.blockNumber) ? 1 : a.id.localeCompare(b.id);
    return a.blockNumber === null && b.blockNumber !== null ? -1 : a.blockNumber !== null && b.blockNumber === null ? 1 : a.id.localeCompare(b.id);
  });
}
export interface TempoSourceView {workflow: WorkflowNode[]; calls: CallSite[]; functionHelp: FunctionHelp[]; revision: number}
/** Presentation of the already hash-checked snapshot, never a new policy or a paraphrase of custom Rust. */
export function tempoSourceView(source: TempoExecutionPolicy | null): TempoSourceView {
  const empty = {workflow: [], calls: [], functionHelp: [], revision: 0};
  if (!source) return empty;
  let snapshot: Record<string, unknown>;
  try {snapshot = JSON.parse(source.bindingJson);} catch {return empty;}
  if (snapshot.code !== source.source || !Array.isArray(snapshot.workflow)) return empty;
  const seen = new Set<string>();
  const workflow = snapshot.workflow.filter((raw: unknown): raw is WorkflowNode => {
    if (!raw || typeof raw !== 'object') return false;
    const n = raw as WorkflowNode;
    if (typeof n.id !== 'string' || seen.has(n.id) || !['function', 'custom', 'pass', 'preference'].includes(n.kind)
      || !['name', 'label', 'description', 'source'].every(key => typeof n[key as keyof WorkflowNode] === 'string')
      || !Array.isArray(n.arguments) || !n.arguments.every(a => typeof a === 'string')
      || !Number.isInteger(n.start) || !Number.isInteger(n.end) || n.start < 0 || n.end < n.start || n.end > source.source.length
      || source.source.slice(n.start, n.end) !== n.source || (n.origin !== undefined && n.origin !== 'policy_api')
      || (n.score_thresholds !== undefined && (!Array.isArray(n.score_thresholds) || !n.score_thresholds.every(t => !!t && typeof t === 'object' && typeof t.field === 'string' && typeof t.operator === 'string' && Number.isInteger(t.value_bps) && t.value_bps >= 0 && t.value_bps <= 10_000)))) return false;
    seen.add(n.id); return true;
  });
  // Help has no implementation body: only pinned library assets may provide that claim.
  const functionHelp = Array.isArray(snapshot.functionHelp) ? snapshot.functionHelp.filter((h: unknown): h is FunctionHelp => !!h && typeof h === 'object' && ['name', 'title', 'description'].every(k => typeof (h as Record<string, unknown>)[k] === 'string')).map(h => ({name: h.name, title: h.title, description: h.description})) : [];
  const calls = Array.isArray(snapshot.calls) ? snapshot.calls.filter((c: unknown): c is CallSite => {
    if (!c || typeof c !== 'object') return false;
    const s = c as CallSite;
    return typeof s.name === 'string' && Number.isInteger(s.start) && Number.isInteger(s.end) && s.start >= 0 && s.end > s.start && s.end <= source.source.length && source.source.slice(s.start, s.end) === s.name;
  }) : [];
  return {workflow, calls, functionHelp, revision: Number.isSafeInteger(snapshot.revision) ? Number(snapshot.revision) : 0};
}
