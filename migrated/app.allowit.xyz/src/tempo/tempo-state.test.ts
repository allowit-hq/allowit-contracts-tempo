import {beforeEach, describe, expect, it, vi} from 'vitest';
import {request} from '../api';
import {sha256Hex} from '../runtime/hash';
import {TempoAPI} from './tempo-api';
import {bytes32, type TempoExecutionPolicy} from './tempo-contracts';
import {TEST_CONFIG, TEST_HASH, TEST_OWNER, TEST_POLICY, testPrepared} from './tempo-fixtures';

vi.mock('../api', () => ({request: vi.fn()}));
const hash = (text: string) => sha256Hex(new TextEncoder().encode(text));
async function custodyFixture() {
  const source = 'pub fn reviewed() {}', sourceHash = await hash(source);
  const snapshot = {policyId: 'reviewed-draft', revision: 2, code: source, sourceHash, workflow: [], originalIntent: TEST_POLICY.prompt,
    requirementsDigest: TEST_POLICY.requirementsDigest, semanticRequired: TEST_POLICY.semanticRequired};
  const bindingJson = JSON.stringify(snapshot);
  const executionPolicy: TempoExecutionPolicy = {source, sourceHash, bindingJson, requirementsDigest: TEST_POLICY.requirementsDigest, semanticRequired: TEST_POLICY.semanticRequired};
  const policy = {...TEST_POLICY, policyDigest: bytes32(await hash(bindingJson))};
  const state = {owner: TEST_OWNER, token: TEST_POLICY.token, approved: true, revoked: false, balance: '4000000', spentToday: '1000000', totalSpent: '1000000'};
  const transaction = testPrepared('fund').transaction;
  const operation = {id: 'agent-paid', policyId: policy.id, method: 'execute' as const, status: 'settled' as const, transactionHash: TEST_HASH, blockNumber: '12',
    transaction: {...transaction, from: TEST_CONFIG.executor}, execution: {amountUnits: '1000000', recipient: policy.recipient}};
  return {api: new TempoAPI(TEST_CONFIG, TEST_OWNER), policy, snapshot, reply: {state, operations: [operation], pendingInputs: [], executionPolicy}};
}
beforeEach(() => vi.mocked(request).mockReset());

describe('Tempo custody remains separate from policy source presentation', () => {
  it.each([
    {owner: TEST_CONFIG.executor}, {token: TEST_CONFIG.factory}, {balance: '-1'}, {balance: '4e6'}, {balance: (1n << 256n).toString()},
    {approved: true, revoked: true}, {approved: 'true'}, {revoked: undefined}, {spentToday: '01'}, {totalSpent: 'NaN'}, {dailyLimit: '1.5'},
  ])('does not relax custody validation to recover from a damaged source: %j', async patch => {
    const f = await custodyFixture(); vi.mocked(request).mockResolvedValue({...f.reply, state: {...f.reply.state, ...patch}, executionPolicy: undefined});
    await expect(f.api.custodyState(f.policy)).rejects.toThrow();
  });
});
