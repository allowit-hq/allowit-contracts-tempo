import {describe, expect, it} from 'vitest';
import {encodeFunctionData, maxUint256} from 'viem';
import {checkedTempoConfig, checkedTempoPolicy, checkedTempoTransaction, tempoUnits, TEMPO_FACTORY_ABI, TEMPO_TOKEN_ABI, policyTerms, bytes32, type TempoPrepared} from './tempo-contracts';
import {TEST_CONFIG, TEST_OWNER, TEST_POLICY, testPrepared} from './tempo-fixtures';

describe('Tempo owner intent binding', () => {
  it.each(['chainId', 'from', 'to', 'value', 'feeToken'] as const)('rejects changed %s before opening the wallet', field => {
    const prepared = testPrepared('fund');
    Object.assign(prepared.transaction, {[field]: field === 'chainId' ? 42431 : field === 'value' ? '0x1' : TEST_CONFIG.authority});
    expect(() => checkedTempoTransaction(TEST_CONFIG, TEST_POLICY, TEST_OWNER, 'fund', {amount: '1'}, 'request-1', prepared)).toThrow();
  });
  it('rejects unlimited approval and another spender', () => {
    for (const [spender, amount] of [[TEST_CONFIG.factory, maxUint256], [TEST_CONFIG.authority, 1000000n]] as const) {
      const prepared = testPrepared('approve_deploy');
      prepared.transaction.data = encodeFunctionData({abi: TEMPO_TOKEN_ABI, functionName: 'approve', args: [spender, amount]});
      expect(() => checkedTempoTransaction(TEST_CONFIG, TEST_POLICY, TEST_OWNER, 'approve_deploy', {amount: '1'}, 'request-1', prepared)).toThrow();
    }
  });
  it('rejects modified deployment terms including the semantic flag', () => {
    for (const patch of [{recipient: TEST_CONFIG.authority}, {dailyUnits: 5000001n}, {semanticRequired: false}, {expiresAt: 0n}, {policyDigest: bytes32('ff'.repeat(32))}]) {
      const prepared = testPrepared('deploy');
      prepared.transaction.data = encodeFunctionData({abi: TEMPO_FACTORY_ABI, functionName: 'createVault', args: [bytes32(TEST_POLICY.id), TEST_CONFIG.token, TEST_CONFIG.executor, TEST_CONFIG.authority, {...policyTerms(TEST_POLICY), ...patch}, 1000000n]});
      expect(() => checkedTempoTransaction(TEST_CONFIG, TEST_POLICY, TEST_OWNER, 'deploy', {amount: '1'}, 'request-1', prepared)).toThrow();
    }
  });
  it('rejects another request, method and trailing calldata', () => {
    const changes = [{operation: {...testPrepared('fund').operation, id: 'other'}}, {operation: {...testPrepared('fund').operation, method: 'revoke'}}, {transaction: {...testPrepared('fund').transaction, data: `${testPrepared('fund').transaction.data}00`}}];
    for (const patch of changes) expect(() => checkedTempoTransaction(TEST_CONFIG, TEST_POLICY, TEST_OWNER, 'fund', {amount: '1'}, 'request-1', {...testPrepared('fund'), ...patch} as TempoPrepared)).toThrow();
  });
  it('uses exact six-decimal integer arithmetic', () => {
    expect(tempoUnits('0.000001')).toBe(1n); expect(tempoUnits('9007199254.740993')).toBe(9007199254740993n);
    for (const value of ['1e2', '-1', '0.0000001', '01', 'NaN', '1,000']) expect(() => tempoUnits(value)).toThrow();
  });
  it('rejects unsupported mainnet or local network endpoint', () => {
    for (const patch of [{network: 'tempo:mainnet'}, {network: 'tempo:testnet', chainId: 4217}, {rpcUrl: 'http://evil.example'}, {rpcUrl: 'https://rpc.moderato.tempo.xyz'}, {feeToken: 'invalid'}]) expect(() => checkedTempoConfig({...TEST_CONFIG, ...patch})).toThrow();
    expect(checkedTempoConfig({...TEST_CONFIG, feeToken: TEST_CONFIG.authority}).feeToken).toBe(TEST_CONFIG.authority);
  });
  it('rejects another policy owner or authority', () => {
    for (const patch of [{owner: TEST_CONFIG.executor}, {authority: TEST_CONFIG.executor}, {chainId: 42431}, {policyDigest: 'bad'}]) expect(() => checkedTempoPolicy({...TEST_POLICY, ...patch}, TEST_CONFIG, TEST_OWNER)).toThrow();
  });
});
