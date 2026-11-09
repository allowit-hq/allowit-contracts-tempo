import {afterEach, describe, expect, it, vi} from 'vitest';
import {checkedTempoOperation, type TempoOperation} from './tempo-contracts';
import {TEST_POLICY, testPrepared} from './tempo-fixtures';

// The Rust reconcile path keeps the prepared block, sets failed with a null hash, and adds this flag only after
// finalized expiry, an unchanged vault nonce and a concurrent-hash check. This block is not a transaction receipt.
const expired = (): TempoOperation => ({
  id: 'expires-payment-1', policyId: TEST_POLICY.id, method: 'execute', status: 'failed', transactionHash: null,
  blockNumber: 100,
  transaction: {...testPrepared('fund').transaction, from: TEST_POLICY.executor, to: TEST_POLICY.vault, value: '0x0'},
  execution: {amountUnits: '250000', recipient: TEST_POLICY.recipient, nonce: 1, expiresAt: 280, expiredUnexecuted: true},
});
afterEach(() => vi.unstubAllGlobals());

describe('Tempo finalized expired-unexecuted agent payments', () => {
  it.each(['approve_deploy', 'deploy', 'approve_fund', 'fund', 'tune', 'revoke', 'withdraw'] as const)('never exempts %s from receipt requirements', method => {
    expect(() => checkedTempoOperation({...expired(), method}, TEST_POLICY.id)).toThrow('receipt');
  });
});
