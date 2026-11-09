import {decodeFunctionData, encodeFunctionData, isAddress, type Address, type Hex} from 'viem';
import {sha256Hex} from '../runtime/hash';

export type TempoNetwork = 'tempo:localnet' | 'tempo:testnet';
export interface TempoManagedExecution {enabled: boolean; executor: Address; profile: 'tempo-native-managed-v1'; reason?: string}
export interface TempoConfig {
  enabled: boolean; network: TempoNetwork; chainId: number; rpcUrl: string; token: Address;
  executor: Address; authority: Address; factory: Address; factoryCodeHash: Hex; vaultCodeHash?: Hex; feeToken: Address;
  tokenSymbol?: string;
  /** Additive backend capability. Older deployments still expose custody/recovery. */
  sourceDerivedFunding?: boolean;
  /** Readiness is verified by the backend; absence never disables owner custody recovery. */
  managedExecution?: TempoManagedExecution;
}
export interface TempoPolicy {
  id: string; profile: 'tempo-native-v1'; network: TempoNetwork; chainId: number; owner: Address; token: Address;
  executor: Address; authority: Address; factory: Address; vault: Address; policyDigest: Hex; requirementsDigest: Hex;
  semanticRequired: boolean; prompt: string; dailyLimit: string; actionLimit: string; totalLimit: string; expiresAt: string; recipient: Address;
}
export type TempoMethod = 'approve_deploy' | 'deploy' | 'approve_fund' | 'fund' | 'tune' | 'revoke' | 'withdraw' | 'execute';
export interface TempoOptions {amount?: string; dailyLimit?: string; actionLimit?: string; totalLimit?: string}
export interface TempoTransaction {chainId: number; from: Address; to: Address; data: Hex; value: string; feeToken?: Address}
export interface TempoOperation {id: string; policyId: string; method: TempoMethod; status: 'prepared' | 'submitted' | 'uncertain' | 'settled' | 'failed'; transactionHash?: Hex | null; transactionUrl?: string; error?: string; blockNumber?: number | string | null; transaction?: TempoTransaction; execution?: {amountUnits?: string; recipient?: Address; nonce?: number; expiresAt?: number; expiredUnexecuted?: boolean} | null;
  /** Optional purchase context and executor response reports never establish chain settlement or custody. */
  purchase?: unknown; delivery?: unknown;
}
export interface TempoPrepared {operation: TempoOperation; transaction: TempoTransaction; intent?: unknown}
export interface TempoState {owner?: Address; token?: Address; approved?: boolean; revoked?: boolean; balance: string; spent?: string; spentToday?: string; nonce?: string; totalSpent?: string; dailyLimit?: string; actionLimit?: string; totalLimit?: string}
export interface TempoExecutionPolicy {source: string; sourceHash: string; requirementsDigest: string; semanticRequired: boolean; bindingJson: string; denyBps?: number; approveBps?: number}
export interface TempoOwnerInput {
  requestId: string; policyId: string; question: string; inputKey: string; answered?: boolean; intentDigest: string;
  amount: string; recipient: Address; action: string; merchant: string; token: Address; tokenSymbol: string; context: unknown; contextRaw: string;
}
export function tempoInputIdentity(input: TempoOwnerInput) {
  return {amount: input.amount, recipient: input.recipient, action: input.action, merchant: input.merchant, token: input.token,
    tokenSymbol: input.tokenSymbol, context: input.context, contextRaw: input.contextRaw};
}
export function tempoCanonicalJson(value: unknown): string {
  function sorted(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(sorted);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, field]) => [key, sorted(field)]));
    return input;
  }
  return JSON.stringify(sorted(value));
}
export async function checkedTempoOwnerInput(input: TempoOwnerInput, policy: TempoPolicy): Promise<TempoOwnerInput> {
  if (!input || input.policyId !== policy.id || typeof input.requestId !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/.test(input.requestId)
    || typeof input.question !== 'string' || typeof input.inputKey !== 'string' || !/^[0-9a-f]{64}$/.test(input.intentDigest)
    || !nonzeroAddress(input.recipient) || (!/^0x0{40}$/i.test(policy.recipient) && !sameAddress(input.recipient, policy.recipient)) || !sameAddress(input.token, policy.token) || typeof input.tokenSymbol !== 'string'
    || typeof input.action !== 'string' || typeof input.merchant !== 'string' || typeof input.contextRaw !== 'string' || input.contextRaw.length > 65_536
    || (input.answered !== undefined && typeof input.answered !== 'boolean')) throw new Error('The owner question changed its exact payment identity.');
  if (tempoUnits(input.amount) <= 0n || input.amount !== tempoDecimal(tempoUnits(input.amount))) throw new Error('The owner question has an invalid payment amount.');
  if (tempoCanonicalJson(JSON.parse(input.contextRaw)) !== tempoCanonicalJson(input.context)) throw new Error('The owner question changed its payment context.');
  // Rust serde_json serializes these keys lexically. Hash the exact normalized context representation returned by the API.
  const identity = {action: input.action, amount: input.amount, context: input.contextRaw, merchant: input.merchant, policyId: policy.id, recipient: input.recipient.toLowerCase()};
  if (await sha256Hex(new TextEncoder().encode(JSON.stringify(identity))) !== input.intentDigest) throw new Error('The owner question changed its exact request digest.');
  return input;
}
const terms = [
  {name: 'policyDigest', type: 'bytes32'}, {name: 'requirementsDigest', type: 'bytes32'},
  {name: 'totalUnits', type: 'uint256'}, {name: 'dailyUnits', type: 'uint256'}, {name: 'actionUnits', type: 'uint256'},
  {name: 'expiresAt', type: 'uint64'}, {name: 'recipient', type: 'address'}, {name: 'semanticRequired', type: 'bool'},
] as const;
export const TEMPO_FACTORY_ABI = [{type: 'function', name: 'createVault', stateMutability: 'nonpayable', inputs: [
  {name: 'policyId', type: 'bytes32'}, {name: 'token', type: 'address'}, {name: 'executor', type: 'address'}, {name: 'authority', type: 'address'},
  {name: 'terms', type: 'tuple', components: terms}, {name: 'initialAmount', type: 'uint256'},
], outputs: [{name: 'vault', type: 'address'}]}] as const;
export const TEMPO_VAULT_ABI = [
  {type: 'function', name: 'fund', stateMutability: 'nonpayable', inputs: [{name: 'amount', type: 'uint256'}], outputs: []},
  {type: 'function', name: 'tune', stateMutability: 'nonpayable', inputs: [{name: 'terms', type: 'tuple', components: terms}], outputs: []},
  {type: 'function', name: 'revoke', stateMutability: 'nonpayable', inputs: [], outputs: []},
  {type: 'function', name: 'withdrawRemaining', stateMutability: 'nonpayable', inputs: [], outputs: []},
] as const;
export const TEMPO_TOKEN_ABI = [{type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{name: 'spender', type: 'address'}, {name: 'amount', type: 'uint256'}], outputs: [{type: 'bool'}]}] as const;
export const sameAddress = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
/** The backend proves expiry against finalized time and an unchanged nonce before setting this terminal flag. */
export function tempoExpiredUnexecuted(op: TempoOperation): boolean {
  const execution = op.execution;
  return op.method === 'execute' && op.status === 'failed' && op.transactionHash == null
    && !!execution && !Array.isArray(execution) && execution.expiredUnexecuted === true
    && typeof execution.amountUnits === 'string' && /^[1-9]\d*$/.test(execution.amountUnits)
    && isAddress(execution.recipient ?? '')
    && Number.isSafeInteger(execution.nonce) && execution.nonce! > 0
    && Number.isSafeInteger(execution.expiresAt) && execution.expiresAt! >= 0;
}
/** A service status is shown only for the selected request and its exact network/vault. */
export function checkedTempoOperation(value: unknown, policyId: string, policy?: TempoPolicy, config?: TempoConfig): TempoOperation {
  const op = value as TempoOperation;
  if (!op || typeof op.id !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(op.id) || op.policyId !== policyId
    || !['approve_deploy', 'deploy', 'approve_fund', 'fund', 'tune', 'revoke', 'withdraw', 'execute'].includes(op.method)
    || !['prepared', 'submitted', 'uncertain', 'settled', 'failed'].includes(op.status)
    || (op.transactionHash != null && !/^0x[\da-fA-F]{64}$/.test(op.transactionHash))
    || (op.blockNumber != null && !(typeof op.blockNumber === 'number' && Number.isSafeInteger(op.blockNumber) && op.blockNumber >= 0)
      && !(typeof op.blockNumber === 'string' && /^(0|[1-9]\d*)$/.test(op.blockNumber)))
    || (op.execution?.expiredUnexecuted !== undefined && typeof op.execution.expiredUnexecuted !== 'boolean')
    || (op.execution?.expiredUnexecuted === true && !tempoExpiredUnexecuted(op))
    || (['settled', 'failed'].includes(op.status) && !tempoExpiredUnexecuted(op) && (!op.transactionHash || op.blockNumber == null))) throw new Error('The Tempo operation receipt could not be verified.');
  if (policy && config) {
    const tx = op.transaction;
    const destination = op.method.startsWith('approve_') ? config.token : op.method === 'deploy' ? config.factory : policy.vault;
    if (!tx || tx.chainId !== config.chainId || !sameAddress(tx.from, op.method === 'execute' ? policy.executor : policy.owner)
      || !sameAddress(tx.to, destination) || !/^0x(?:[\da-fA-F]{2})+$/.test(tx.data) || !['0', '0x0'].includes(tx.value)
      || (tx.feeToken !== undefined && !sameAddress(tx.feeToken, config.feeToken))) throw new Error('The Tempo activity belongs to another wallet, vault or network.');
  }
  if (op.execution != null && (typeof op.execution !== 'object'
    || (op.execution.amountUnits !== undefined && (typeof op.execution.amountUnits !== 'string' || !/^(0|[1-9]\d*)$/.test(op.execution.amountUnits)))
    || (op.execution.recipient !== undefined && !isAddress(op.execution.recipient)))) throw new Error('The Tempo activity amount or recipient could not be verified.');
  return op;
}
const nonzeroAddress = (value: unknown) => typeof value === 'string' && isAddress(value) && !/^0x0{40}$/i.test(value);
export const bytes32 = (value: string): Hex => {
  const raw = value.startsWith('0x') ? value.slice(2) : value;
  if (!/^[\da-fA-F]{64}$/.test(raw)) throw new Error('The policy has an invalid fingerprint.');
  return `0x${raw.toLowerCase()}`;
};
export function tempoUnits(amount: string): bigint {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(amount)) throw new Error('Use an exact amount with up to six decimal places.');
  const [whole, fraction = ''] = amount.split('.');
  const value = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (value > (1n << 64n) - 1n) throw new Error('The amount exceeds the supported exact token range.');
  return value;
}
export function tempoDecimal(units: string | bigint): string {
  const value = BigInt(units), fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${value / 1_000_000n}${fraction ? `.${fraction}` : ''}`;
}
export function checkedTempoConfig(value: unknown): TempoConfig {
  const c = value as TempoConfig;
  if (!c || c.enabled !== true || !['tempo:localnet', 'tempo:testnet'].includes(c.network) || !Number.isSafeInteger(c.chainId) || c.chainId <= 0
    || (c.network === 'tempo:testnet' && c.chainId !== 42431) || ![c.token, c.executor, c.authority, c.factory, c.feeToken].every(nonzeroAddress)
    || !/^0x[\da-fA-F]{64}$/.test(c.factoryCodeHash) || (c.vaultCodeHash !== undefined && !/^0x[\da-fA-F]{64}$/.test(c.vaultCodeHash))) throw new Error('Tempo is not configured for this workspace.');
  const rpc = new URL(c.rpcUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(rpc.hostname);
  if (rpc.username || rpc.password || (rpc.protocol !== 'https:' && !(rpc.protocol === 'http:' && local)) || (c.network === 'tempo:localnet' && !local)) throw new Error('The Tempo network endpoint is invalid.');
  return c;
}
export function checkedTempoPolicy(value: unknown, config: TempoConfig, owner: string): TempoPolicy {
  const p = value as TempoPolicy;
  if (p && sameAddress(p.owner, owner) && isAddress(p.executor ?? '') && !sameAddress(p.executor, config.executor)) throw new Error('This vault uses a different executor from this deployment. Managed agent access is blocked. Preserve its original request records and proofs; this deployment cannot authorize new payments for that binding.');
  if (!p || p.profile !== 'tempo-native-v1' || p.network !== config.network || p.chainId !== config.chainId || !sameAddress(p.owner, owner)
    || !['token', 'executor', 'authority', 'factory'].every(k => sameAddress(p[k as keyof TempoPolicy], config[k as keyof TempoConfig]))
    || !nonzeroAddress(p.owner) || !nonzeroAddress(p.vault) || !isAddress(p.recipient) || sameAddress(p.owner, p.executor) || sameAddress(p.owner, p.authority) || sameAddress(p.executor, p.authority) || typeof p.semanticRequired !== 'boolean' || typeof p.prompt !== 'string') throw new Error('The policy belongs to another owner or network.');
  bytes32(p.id); bytes32(p.policyDigest); bytes32(p.requirementsDigest);
  for (const limit of [p.dailyLimit, p.actionLimit, p.totalLimit]) tempoUnits(limit);
  if (tempoUnits(p.actionLimit) <= 0n || tempoUnits(p.actionLimit) > tempoUnits(p.dailyLimit) || tempoUnits(p.dailyLimit) > tempoUnits(p.totalLimit)) throw new Error('The policy has invalid spending limits.');
  if (typeof p.expiresAt !== 'string' || !/^(0|[1-9]\d*)$/.test(p.expiresAt)) throw new Error('The policy expiry must be an exact integer string.');
  const expiresAt = BigInt(p.expiresAt);
  if (expiresAt < 0n || expiresAt > (1n << 64n) - 1n) throw new Error('The policy expiry is invalid.');
  return p;
}
export function policyTerms(policy: TempoPolicy, options: TempoOptions = {}) {
  return {policyDigest: bytes32(policy.policyDigest), requirementsDigest: bytes32(policy.requirementsDigest),
    totalUnits: tempoUnits(options.totalLimit ?? policy.totalLimit), dailyUnits: tempoUnits(options.dailyLimit ?? policy.dailyLimit),
    actionUnits: tempoUnits(options.actionLimit ?? policy.actionLimit), expiresAt: BigInt(policy.expiresAt), recipient: policy.recipient, semanticRequired: policy.semanticRequired};
}
/** Re-encode the owner's exact intent locally. Server-provided calldata alone is never a spending permission. */
export function checkedTempoTransaction(config: TempoConfig, policy: TempoPolicy, owner: Address, method: Exclude<TempoMethod, 'execute'>, options: TempoOptions, requestId: string, prepared: TempoPrepared): TempoTransaction {
  checkedTempoPolicy(policy, config, owner);
  const op = prepared?.operation, tx = prepared?.transaction;
  if (!op || op.id !== requestId || op.policyId !== policy.id || op.method !== method || !tx || tx.chainId !== config.chainId || !sameAddress(tx.from, owner)
    || (tx.value !== '0x0' && tx.value !== '0') || (tx.feeToken !== undefined && !sameAddress(tx.feeToken, config.feeToken))) throw new Error('The transaction does not match the reviewed request.');
  const amount = tempoUnits(options.amount ?? '0');
  if (['deploy', 'fund', 'approve_deploy', 'approve_fund'].includes(method) && amount <= 0n) throw new Error('The exact deposit amount must be greater than zero.');
  if (method === 'deploy' && amount > tempoUnits(policy.totalLimit)) throw new Error('The initial deposit exceeds the reviewed budget.');
  let to: Address, data: Hex;
  if (method === 'approve_deploy' || method === 'approve_fund') {
    if (amount <= 0n) throw new Error('Approve only the exact amount being added.');
    to = config.token; data = encodeFunctionData({abi: TEMPO_TOKEN_ABI, functionName: 'approve', args: [method === 'approve_deploy' ? config.factory : policy.vault, amount]});
  } else if (method === 'deploy') {
    to = config.factory; data = encodeFunctionData({abi: TEMPO_FACTORY_ABI, functionName: 'createVault', args: [bytes32(policy.id), policy.token, policy.executor, policy.authority, policyTerms(policy), amount]});
  } else {
    to = policy.vault;
    if (method === 'fund') data = encodeFunctionData({abi: TEMPO_VAULT_ABI, functionName: 'fund', args: [amount]});
    else if (method === 'tune') data = encodeFunctionData({abi: TEMPO_VAULT_ABI, functionName: 'tune', args: [policyTerms(policy, options)]});
    else data = encodeFunctionData({abi: TEMPO_VAULT_ABI, functionName: method === 'withdraw' ? 'withdrawRemaining' : 'revoke'});
  }
  if (!sameAddress(tx.to, to) || typeof tx.data !== 'string' || tx.data.toLowerCase() !== data.toLowerCase()) throw new Error('The wallet transaction changes the reviewed amount, recipient or policy.');
  // Decode as a second ABI shape check; trailing bytes and extra calls are rejected by the exact byte comparison.
  decodeFunctionData({abi: method.startsWith('approve_') ? TEMPO_TOKEN_ABI : method === 'deploy' ? TEMPO_FACTORY_ABI : TEMPO_VAULT_ABI, data: tx.data});
  return tx;
}
