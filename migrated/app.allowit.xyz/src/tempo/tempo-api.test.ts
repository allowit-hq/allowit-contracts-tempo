import {describe, expect, it, vi} from 'vitest';
import {checkedTempoRecord, TempoAPI, TempoLifecycle, type TempoRecord, type TempoStore} from './tempo-api';
import {TEST_CONFIG, TEST_HASH, TEST_OWNER, TEST_POLICY, testPrepared} from './tempo-fixtures';
const fixture = () => {
  let record: TempoRecord | null = null;
  const store: TempoStore = {read: vi.fn(async () => record), write: vi.fn(async value => {record = structuredClone(value);}), entries: vi.fn(async () => record ? [record] : []), locked: async action => action()};
  const api = new TempoAPI(TEST_CONFIG, TEST_OWNER);
  vi.spyOn(api, 'prepare').mockImplementation(async (_policy, id, method, options) => testPrepared(method, id, options));
  vi.spyOn(api, 'recover').mockImplementation(async (policyId, id, transactionHash) => ({id, policyId, transactionHash, method: 'fund', status: 'settled'}));
  const send = vi.fn(async () => TEST_HASH);
  const lifecycle = new TempoLifecycle(api, TEST_POLICY, store, send);
  return {api, store, send, lifecycle, read: () => record};
};
describe('Tempo durable transaction recovery', () => {
  it('commits the exact request before signing, then reports the returned hash', async () => {
    const f = fixture();
    f.send.mockImplementation(async () => {expect(f.read()?.phase).toBe('sending');expect(f.read()?.prepared?.transaction.data).toBe(testPrepared('fund').transaction.data);return TEST_HASH;});
    const record = await f.lifecycle.submit('fund', {amount: '1'});
    expect(record.operation?.status).toBe('settled');expect(f.send).toHaveBeenCalledOnce();expect(f.api.recover).toHaveBeenCalledWith(TEST_POLICY.id, record.id, TEST_HASH);
  });
  it('never signs again after an unknown wallet send, including reload', async () => {
    const f = fixture(); f.send.mockRejectedValueOnce(new Error('Wallet connection lost'));
    await expect(f.lifecycle.submit('fund', {amount: '1'})).rejects.toThrow('lost');
    expect(f.read()?.phase).toBe('sending');
    const reloaded = new TempoLifecycle(f.api, TEST_POLICY, f.store, f.send);
    await expect(reloaded.submit('fund', {amount: '1'})).rejects.toThrow('Recover');
    expect(f.send).toHaveBeenCalledOnce();
  });
  it('rejects a tampered plan before the wallet sees it', async () => {
    const f = fixture(); vi.mocked(f.api.prepare).mockImplementationOnce(async (_p, id) => ({...testPrepared('fund', id), transaction: {...testPrepared('fund').transaction, to: TEST_CONFIG.authority}}));
    await expect(f.lifecycle.submit('fund', {amount: '1'})).rejects.toThrow('reviewed');expect(f.send).not.toHaveBeenCalled();
  });
  it('a prepared backend status cannot clear uncertainty after a lost wallet hash', async () => {
    const f = fixture(); f.send.mockRejectedValueOnce(new Error('Disconnected'));
    await expect(f.lifecycle.submit('fund', {amount: '1'})).rejects.toThrow();
    vi.mocked(f.api.recover).mockImplementationOnce(async (policyId, id) => ({id, policyId, method: 'fund', status: 'prepared'}));
    expect((await f.lifecycle.recover())?.phase).toBe('sending');
    await expect(f.lifecycle.submit('fund', {amount: '1'})).rejects.toThrow('Recover');expect(f.send).toHaveBeenCalledOnce();
  });
  it('refuses missing, changed, terminal or uncertain selected original requests without signing', async () => {
    for (const patch of [{id: 'other'}, {owner: TEST_CONFIG.executor}, {chainId: 1}, {policyId: 'other'}, {method: 'withdraw' as const}, {options: {amount: '2'}},
      {phase: 'sending' as const}, {transactionHash: TEST_HASH}, {operation: {id: 'request', policyId: TEST_POLICY.id, method: 'fund' as const, status: 'settled' as const}}]) {
      const f = fixture();
      const selected: TempoRecord = {version: 1, owner: TEST_OWNER, chainId: TEST_CONFIG.chainId, policyId: TEST_POLICY.id, id: 'request',
        method: 'fund', options: {amount: '1'}, phase: 'preparing', ...patch};
      vi.mocked(f.store.entries).mockResolvedValue([selected]);
      await expect(f.lifecycle.submit('fund', {amount: '1'}, undefined, 'request')).rejects.toThrow();
      expect(f.send).not.toHaveBeenCalled(); expect(f.api.prepare).not.toHaveBeenCalled();
    }
  });
  it('cannot start a new request when a historical send in the same channel remains unresolved', async () => {
    const f = fixture(), latest = await f.lifecycle.submit('fund', {amount: '2'});
    const historical = {...latest, id: 'uncertain-earlier-send', operation: undefined, phase: 'sending' as const};
    vi.mocked(f.store.entries).mockResolvedValue([historical, latest]);
    await expect(f.lifecycle.submit('fund', {amount: '1'})).rejects.toThrow('earlier unresolved');
    expect(f.send).toHaveBeenCalledOnce();
  });
});

describe('Tempo saved request validation', () => {
  const saved = (): TempoRecord => ({version: 1, owner: TEST_OWNER, chainId: TEST_CONFIG.chainId, policyId: TEST_POLICY.id,
    id: 'reviewed-request', method: 'fund', options: {amount: '1'}, phase: 'sending', prepared: testPrepared('fund', 'reviewed-request'), transactionHash: TEST_HASH});
  it.each([{options: undefined}, {options: []}, {options: {amount: '1e6'}}, {options: {amount: '1', unknown: '1'}}, {method: 'execute'}, {phase: 'unknown'},
    {id: ''}, {owner: TEST_CONFIG.executor}, {chainId: 1}, {policyId: 'other'}, {transactionHash: 'invalid'}])('refuses a malformed durable request before rendering or signing: %j', patch => {
    expect(() => checkedTempoRecord({...saved(), ...patch}, TEST_CONFIG, TEST_OWNER, TEST_POLICY)).toThrow();
  });
  it('rejects substituted prepared bytes and a receipt belonging to another saved identity', () => {
    const record = saved();
    expect(() => checkedTempoRecord({...record, prepared: {...record.prepared!, transaction: {...record.prepared!.transaction, to: TEST_CONFIG.authority}}}, TEST_CONFIG, TEST_OWNER, TEST_POLICY)).toThrow();
    expect(() => checkedTempoRecord({...record, operation: {id: 'other', policyId: TEST_POLICY.id, method: 'fund', status: 'submitted', transactionHash: TEST_HASH}}, TEST_CONFIG, TEST_OWNER, TEST_POLICY)).toThrow();
  });
});
