import {describe, expect, it} from 'vitest';
import {checkedTempoOperation, type TempoOperation} from './tempo-contracts';
import {tempoActivity, tempoRecordStatus} from './tempo-view';
import {TEST_CONFIG, TEST_HASH, TEST_OWNER, TEST_POLICY, testPrepared} from './tempo-fixtures';
import type {TempoRecord} from './tempo-api';

const owner = (): TempoOperation => ({...testPrepared('fund').operation, transaction: testPrepared('fund').transaction, status: 'settled', transactionHash: TEST_HASH, blockNumber: 9, execution: {amountUnits: '1000000'}});
const local = (): TempoRecord => ({version: 1, owner: TEST_OWNER, chainId: TEST_CONFIG.chainId, policyId: TEST_POLICY.id, id: 'request-1', method: 'fund', options: {amount: '1'}, phase: 'sending', transactionHash: TEST_HASH});

describe('Tempo truthful activity and receipt presentation', () => {
  it('merges the exact owner request once and includes an actual executor operation', () => {
    const payment: TempoOperation = {...owner(), id: 'agent-1', method: 'execute', blockNumber: 10, transaction: {...testPrepared('fund').transaction, from: TEST_CONFIG.executor}, execution: {amountUnits: '250000', recipient: TEST_POLICY.recipient}};
    const rows = tempoActivity(TEST_POLICY, TEST_CONFIG, [local()], [owner(), payment]);
    expect(rows.map(r => [r.id, r.status, r.amount, r.local])).toEqual([['agent-1', 'Confirmed', '0.25', false], ['request-1', 'Confirmed', '1', true]]);
  });
  it('never labels a hash or a malformed saved receipt as confirmed', () => {
    expect(tempoRecordStatus(local())).toBe('Not confirmed');
    expect(tempoRecordStatus({...local(), operation: {...owner(), blockNumber: undefined}})).toBe('Not confirmed');
    expect(tempoRecordStatus({...local(), operation: {...owner(), id: 'other'}})).toBe('Not confirmed');
    expect(tempoRecordStatus({...local(), operation: owner()})).toBe('Confirmed');
  });
  it('rejects foreign owner, executor, vault, chain, and receipt policy before display', () => {
    for (const patch of [{policyId: 'other'}, {transaction: {...owner().transaction!, from: TEST_CONFIG.executor}}, {transaction: {...owner().transaction!, to: TEST_CONFIG.authority}}, {transaction: {...owner().transaction!, chainId: 42431}}]) {
      expect(() => checkedTempoOperation({...owner(), ...patch}, TEST_POLICY.id, TEST_POLICY, TEST_CONFIG)).toThrow();
      expect(tempoActivity(TEST_POLICY, TEST_CONFIG, [], [{...owner(), ...patch}])).toEqual([]);
    }
  });
});
