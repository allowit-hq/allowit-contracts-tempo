import {afterEach, describe, expect, it, vi} from 'vitest';
import {sha256Hex} from '../runtime/hash';
import {checkedExecutionPolicy, TempoAPI} from './tempo-api';
import {bytes32, type TempoExecutionPolicy} from './tempo-contracts';
import {TEST_CONFIG, TEST_OWNER, TEST_POLICY} from './tempo-fixtures';
import {zeroAddress} from 'viem';
afterEach(() => vi.unstubAllGlobals());
const hash = (text: string) => sha256Hex(new TextEncoder().encode(text));
async function sourceFixture() {
  const source = 'pub fn reviewed() {}', sourceHash = await hash(source);
  const snapshot = {policyId: 'execution-source', revision: 0, sourceHash, irHash: 'b'.repeat(64), code: source, originalIntent: TEST_POLICY.prompt,
    workflow: [], requirementsDigest: TEST_POLICY.requirementsDigest, semanticRequired: TEST_POLICY.semanticRequired};
  const bindingJson = JSON.stringify(snapshot);
  const execution: TempoExecutionPolicy = {source, sourceHash, bindingJson, requirementsDigest: TEST_POLICY.requirementsDigest, semanticRequired: TEST_POLICY.semanticRequired};
  return {execution, policy: {...TEST_POLICY, recipient: zeroAddress, policyDigest: bytes32(await hash(bindingJson))}, snapshot};
}
describe('Tempo owner source review binding', () => {
  it('refuses a newer source, changed funding or missing review on the derived path', async () => {
    const f = await sourceFixture();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({policy: f.policy, executionPolicy: f.execution})));
    const input = {executionPolicyId: f.snapshot.policyId, expectedRevision: f.snapshot.revision, expectedSourceHash: f.snapshot.sourceHash, totalLimit: f.policy.totalLimit};
    const api = new TempoAPI(TEST_CONFIG, TEST_OWNER);
    await expect(api.generate({...input, expectedRevision: 3})).rejects.toThrow('reviewed policy revision');
    await expect(api.generate({...input, expectedSourceHash: 'e'.repeat(64)})).rejects.toThrow('reviewed policy revision');
    await expect(api.generate({...input, totalLimit: '9'})).rejects.toThrow('requested limits');
    await expect(api.generate({...input, expectedSourceHash: undefined})).rejects.toThrow('could not be verified');
  });
  it('accepts only the source in the exact on-chain policy snapshot bytes', async () => {
    const f = await sourceFixture();expect(await checkedExecutionPolicy(f.execution, f.policy)).toBe(f.execution);
    await expect(checkedExecutionPolicy({...f.execution, bindingJson: JSON.stringify(f.snapshot, null, 2)}, f.policy)).rejects.toThrow('vault policy');
  });
  it('substituting both displayed source and its hash cannot preserve the policy binding', async () => {
    const f = await sourceFixture(), source = 'pub fn substituted() {}';
    await expect(checkedExecutionPolicy({...f.execution, source, sourceHash: await hash(source)}, f.policy)).rejects.toThrow('snapshot');
  });
});
