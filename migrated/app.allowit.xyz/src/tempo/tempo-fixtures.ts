import {encodeFunctionData, keccak256, type Address, type Hex} from 'viem';
import {bytes32, policyTerms, TEMPO_FACTORY_ABI, TEMPO_TOKEN_ABI, TEMPO_VAULT_ABI, type TempoConfig, type TempoMethod, type TempoOptions, type TempoPolicy, type TempoPrepared} from './tempo-contracts';
/** Local unit-test values only. Never registered or accepted as a deployed network. */
export const TEST_OWNER = '0x1111111111111111111111111111111111111111' as Address;
export const TEST_CODE = '0x6001600055' as Hex;
export const TEST_HASH = `0x${'ab'.repeat(32)}` as Hex;
export const TEST_CONFIG: TempoConfig = {enabled: true, sourceDerivedFunding: true, managedExecution: {enabled: true, executor: '0x3333333333333333333333333333333333333333', profile: 'tempo-native-managed-v1'}, network: 'tempo:localnet', chainId: 31337, rpcUrl: 'http://127.0.0.1:8545', token: '0x20c0000000000000000000000000000000000001', feeToken: '0x20c0000000000000000000000000000000000001', factory: '0x2222222222222222222222222222222222222222', executor: '0x3333333333333333333333333333333333333333', authority: '0x4444444444444444444444444444444444444444', factoryCodeHash: keccak256(TEST_CODE), vaultCodeHash: keccak256(TEST_CODE)};
export const TEST_POLICY: TempoPolicy = {id: '01'.repeat(32), profile: 'tempo-native-v1', network: TEST_CONFIG.network, chainId: TEST_CONFIG.chainId, owner: TEST_OWNER, token: TEST_CONFIG.token, executor: TEST_CONFIG.executor, authority: TEST_CONFIG.authority, factory: TEST_CONFIG.factory, vault: '0x5555555555555555555555555555555555555555', policyDigest: `0x${'02'.repeat(32)}`, requirementsDigest: `0x${'03'.repeat(32)}`, semanticRequired: true, prompt: 'Pay this recipient for useful research', totalLimit: '10', dailyLimit: '5', actionLimit: '1', expiresAt: '18446744073709551615', recipient: '0x6666666666666666666666666666666666666666'};
export function testPrepared(method: Exclude<TempoMethod, 'execute'>, id = 'request-1', options: TempoOptions = {amount: '1'}): TempoPrepared {
  const amount = BigInt((options.amount ?? '1').replace('.', ''));
  // Fixtures use independently selected ABI arguments; exact production amount tests cover fractional values separately.
  const units = options.amount === '0.25' ? 250000n : amount * 1000000n;
  let to = TEST_POLICY.vault, data: Hex;
  if (method.startsWith('approve_')) {to = TEST_CONFIG.token; data = encodeFunctionData({abi: TEMPO_TOKEN_ABI, functionName: 'approve', args: [method === 'approve_deploy' ? TEST_CONFIG.factory : TEST_POLICY.vault, units]});}
  else if (method === 'deploy') {to = TEST_CONFIG.factory; data = encodeFunctionData({abi: TEMPO_FACTORY_ABI, functionName: 'createVault', args: [bytes32(TEST_POLICY.id), TEST_CONFIG.token, TEST_CONFIG.executor, TEST_CONFIG.authority, policyTerms(TEST_POLICY), units]});}
  else if (method === 'fund') data = encodeFunctionData({abi: TEMPO_VAULT_ABI, functionName: 'fund', args: [units]});
  else if (method === 'tune') data = encodeFunctionData({abi: TEMPO_VAULT_ABI, functionName: 'tune', args: [policyTerms(TEST_POLICY, options)]});
  else data = encodeFunctionData({abi: TEMPO_VAULT_ABI, functionName: method === 'withdraw' ? 'withdrawRemaining' : 'revoke'});
  return {operation: {id, method, policyId: TEST_POLICY.id, status: 'prepared'}, transaction: {chainId: TEST_CONFIG.chainId, from: TEST_OWNER, to, data, value: '0x0', feeToken: TEST_CONFIG.feeToken}};
}
