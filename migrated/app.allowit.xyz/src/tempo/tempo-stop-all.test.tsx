import {describe, expect, it, vi} from 'vitest';
import {TempoAPI, tempoChannel, type TempoCustodyState, type TempoRecord, type TempoStore} from './tempo-api';
import {reviewTempoStopAll, runTempoStopAll, tempoStopBlocker, type TempoStopDependencies} from './TempoStopAll';
import type {TempoVault, TempoWorkspace} from './TempoVault';
import type {TempoPolicy} from './tempo-contracts';
import {TEST_CONFIG, TEST_HASH, TEST_OWNER, TEST_POLICY, testPrepared} from './tempo-fixtures';

function fixture() {
  const second: TempoPolicy = {...TEST_POLICY, id: '12'.repeat(32), vault: '0x7777777777777777777777777777777777777777'};
  const custody = (balance: string, approved = true, sourceError = ''): TempoCustodyState => ({state: {owner: TEST_OWNER, token: TEST_CONFIG.token, balance, approved, revoked: !approved, spentToday: '0', totalSpent: '0'},
    operations: [], pendingInputs: [], executionPolicy: null, boundExecutionPolicyId: null, boundSnapshot: null, sourceError, activityError: '', inputError: ''});
  const states = new Map([[TEST_POLICY.id, custody('2000000')], [second.id, custody('0')]]);
  const vaults: TempoVault[] = [TEST_POLICY, second].map(policy => ({...states.get(policy.id)!, policy, draftId: null, stateError: ''}));
  const latest = new Map<string, TempoRecord>(), records = new Map<string, TempoRecord>();
  const key = (policy: TempoPolicy, channel: string) => `${policy.id}:${channel}`;
  const store = (policy: TempoPolicy, channel: string): TempoStore => ({channel,
    read: async () => latest.get(key(policy, channel)) ?? null,
    entries: async selected => [...records.values()].filter(record => record.policyId === policy.id && (selected === undefined || tempoChannel(record.method) === selected)),
    write: async (record, updateLatest = true) => {records.set(record.id, structuredClone(record)); if (updateLatest) latest.set(key(policy, channel), structuredClone(record));},
    locked: async action => action(),
  });
  const api = new TempoAPI(TEST_CONFIG, TEST_OWNER);
  const custodyState = vi.spyOn(api, 'custodyState').mockImplementation(async policy => structuredClone(states.get(policy.id)!));
  const events: string[] = [];
  const prepare = vi.spyOn(api, 'prepare').mockImplementation(async (policy, id, method, options) => {
    events.push(`prepare:${policy.id}`);
    const prepared = testPrepared(method, id, options);
    return {...prepared, operation: {...prepared.operation, policyId: policy.id}, transaction: {...prepared.transaction, to: policy.vault}};
  });
  const recover = vi.spyOn(api, 'recover').mockImplementation(async (policyId, id, transactionHash) => {
    events.push(`recover:${policyId}`);
    return {id, policyId, method: records.get(id)!.method, status: 'settled', transactionHash: transactionHash ?? TEST_HASH, blockNumber: 7};
  });
  const send = vi.fn(async () => {events.push('send'); return TEST_HASH;});
  const checkWallet = vi.fn(async () => {});
  const deps: TempoStopDependencies = {store, send, checkWallet, receiptAttempts: 0};
  const workspace: TempoWorkspace = {config: TEST_CONFIG, owner: TEST_OWNER, api, provider: undefined, loaded: true, settled: false, error: '', vaults,
    beginOperation: () => () => {}, reload: async () => {}, vaultFor: () => null, recoveryVaults: () => vaults};
  function save(policy: TempoPolicy, method: TempoRecord['method'], patch: Partial<TempoRecord> = {}) {
    const record: TempoRecord = {version: 1, owner: TEST_OWNER, chainId: TEST_CONFIG.chainId, policyId: policy.id, id: `original-${method}-${policy.id.slice(0, 4)}`,
      method, options: {}, phase: 'sending', ...patch};
    records.set(record.id, record); latest.set(key(policy, tempoChannel(method)), record); return record;
  }
  return {workspace, deps, api, states, custody, second, store, records, latest, save, send, checkWallet, prepare, recover, custodyState, events};
}

describe('Tempo bulk owner stop and return', () => {
  it('keeps an uncertain original withdrawal and continues another vault without resending it', async () => {
    const f = fixture(), original = f.save(TEST_POLICY, 'withdraw', {transactionHash: TEST_HASH});
    const rows = await reviewTempoStopAll(f.workspace, undefined, f.deps);
    expect(tempoStopBlocker(rows[0])).toContain('original request');
    const result = await runTempoStopAll(f.workspace, rows, undefined, undefined, f.deps);
    expect(f.prepare.mock.calls.map(call => call[0].id)).toEqual([f.second.id]);
    expect(f.records.get(original.id)).toEqual(original);
    expect(result[0].records).toContainEqual(original); expect(f.send).toHaveBeenCalledOnce();
  });

  it('does not sign when a new original appears after aggregate review', async () => {
    const f = fixture(), rows = await reviewTempoStopAll(f.workspace, undefined, f.deps);
    const original = f.save(TEST_POLICY, 'withdraw', {phase: 'prepared'});
    const result = await runTempoStopAll(f.workspace, [rows[0]], undefined, undefined, f.deps);
    expect(result[0].result).toContain('saved requests changed');
    expect(f.records.get(original.id)).toEqual(original); expect(f.send).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
  });

  it('requires another review when fresh custody changes the reviewed method', async () => {
    const f = fixture(), rows = await reviewTempoStopAll(f.workspace, undefined, f.deps);
    f.states.set(TEST_POLICY.id, f.custody('0'));
    const result = await runTempoStopAll(f.workspace, [rows[0]], undefined, undefined, f.deps);
    expect(result[0].result).toContain('required action'); expect(f.send).not.toHaveBeenCalled();
  });

  it('stops requesting later wallet confirmations after the owner declines', async () => {
    const f = fixture(); f.send.mockRejectedValueOnce(Object.assign(new Error('Declined'), {code: 4001}));
    const rows = await reviewTempoStopAll(f.workspace, undefined, f.deps);
    const result = await runTempoStopAll(f.workspace, rows, undefined, undefined, f.deps);
    expect(f.send).toHaveBeenCalledOnce(); expect(result[1].result).toContain('cancelled');
    expect(result[0].records[0].phase).toBe('declined');
  });

  it('checks current owner/network scope at the last point before a wallet send', async () => {
    const f = fixture(), rows = await reviewTempoStopAll(f.workspace, undefined, f.deps);
    let current = true;
    f.deps.send = vi.fn(async (_transaction, beforeSend) => {current = false; beforeSend(); return TEST_HASH;});
    await expect(runTempoStopAll(f.workspace, rows, () => current, undefined, f.deps)).rejects.toThrow('changed');
    expect(f.records.values().next().value?.phase).toBe('prepared');
    expect(f.prepare).toHaveBeenCalledOnce(); expect(f.recover).not.toHaveBeenCalled();
  });
});
