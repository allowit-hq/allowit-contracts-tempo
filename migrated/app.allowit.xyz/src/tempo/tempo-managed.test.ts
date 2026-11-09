import {afterEach, describe, expect, it, vi} from 'vitest';
import {checkedTempoManagedExport, tempoManagedReady} from './tempo-managed';
import {TempoAPI} from './tempo-api';
import {TEST_CONFIG, TEST_OWNER, TEST_POLICY} from './tempo-fixtures';
const origin = 'https://allowit.example';
const exported = () => ({version: 1, profile: 'tempo-native-v1', policy: {...TEST_POLICY}, capability: 'tempo-executor.private_fixture_capability', config: {rpcUrl: 'private-marker'}, managedAgent: {endpoint: '/api/tempo/spend', statusEndpoint: '/api/tempo/spend/status', resumeEndpoint: '/api/tempo/spend/resume', authorization: 'Bearer tempo-executor.private_fixture_capability', recovery: 'repeat-identical-request', paymentKind: 'direct-token-transfer', deliveryAttested: false, executor: TEST_POLICY.executor, policyId: TEST_POLICY.id, policyDigest: TEST_POLICY.policyDigest, requirementsDigest: TEST_POLICY.requirementsDigest, requestSchema: {policyId: TEST_POLICY.id, requestId: 'stable-request-id', recipient: 'exact-recipient-address', amount: 'decimal-token-amount', action: 'exact-action', merchant: 'exact-merchant-or-empty-string', context: {}}}});
afterEach(() => vi.unstubAllGlobals());
describe('Tempo managed handoff boundaries', () => {
  it('requires both verified deployment and policy readiness', () => {
    expect(tempoManagedReady(TEST_CONFIG)).toBe(true);
    expect(tempoManagedReady(TEST_CONFIG, TEST_POLICY, TEST_CONFIG.managedExecution)).toBe(true);
    expect(tempoManagedReady(TEST_CONFIG, TEST_POLICY)).toBe(false);
    expect(tempoManagedReady({...TEST_CONFIG, managedExecution: undefined})).toBe(false);
  });
  it('projects only verified private payment authority and same-origin endpoints', () => {
    const value = exported(); Object.assign(value, {privateKey: 'private-marker'}); Object.assign(value.policy, {rpcUrl: 'private-marker'}); Object.assign(value.managedAgent.requestSchema, {transport: {key: 'private-marker'}});
    const checked = checkedTempoManagedExport(value, TEST_CONFIG, TEST_POLICY, origin);
    expect(checked.profile).toBe('tempo-native-managed-v1'); expect(checked.managedAgent.endpoint).toBe(origin + '/api/tempo/spend'); expect(checked.managedAgent.statusEndpoint).toBe(origin + '/api/tempo/spend/status');
    expect(checked.managedAgent.authorization).toBe(value.managedAgent.authorization); expect(JSON.stringify(checked)).not.toContain('private-marker'); expect(checked).not.toHaveProperty('config'); expect(checked).not.toHaveProperty('capability');
  });
  it.each([{endpoint: 'https://other.example/api/tempo/spend'}, {statusEndpoint: '/api/tempo/execute'}, {resumeEndpoint: 'https://other.example/api/tempo/spend/resume'}, {authorization: 'Bearer other'}, {executor: TEST_OWNER}, {policyId: 'other'}, {policyDigest: '0x' + 'ff'.repeat(32)}, {requirementsDigest: '0x' + 'ff'.repeat(32)}, {deliveryAttested: true}, {recovery: 'new-request'}, {paymentKind: 'automatic-delivery'}])('rejects changed managed binding %j', patch => {const value = exported(); Object.assign(value.managedAgent, patch); expect(() => checkedTempoManagedExport(value, TEST_CONFIG, TEST_POLICY, origin)).toThrow();});
  it('compares the full policy binding including prompt case and lifetime ceilings', () => {for (const patch of [{prompt: TEST_POLICY.prompt.toUpperCase()}, {totalLimit: '11'}, {expiresAt: '2000000000'}]) {const value = exported(); Object.assign(value.policy, patch); expect(() => checkedTempoManagedExport(value, TEST_CONFIG, TEST_POLICY, origin)).toThrow();}});
  it('never requests a private export when readiness is absent', async () => {const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); await expect(new TempoAPI({...TEST_CONFIG, managedExecution: undefined}, TEST_OWNER).export(TEST_POLICY, origin)).rejects.toThrow('unavailable'); expect(fetch).not.toHaveBeenCalled();});
});
