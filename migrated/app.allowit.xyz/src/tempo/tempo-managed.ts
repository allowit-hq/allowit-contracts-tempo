import {checkedTempoPolicy, sameAddress, type TempoConfig, type TempoManagedExecution, type TempoPolicy} from './tempo-contracts';

export const TEMPO_MANAGED_PROFILE = 'tempo-native-managed-v1' as const;
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** Invalid managed metadata cannot invalidate separately checked owner custody. */
export function checkedTempoManagedExecution(value: unknown, config: TempoConfig, policy?: TempoPolicy): TempoManagedExecution | null {
  const managed = object(value);
  if (!managed || typeof managed.enabled !== 'boolean' || managed.profile !== TEMPO_MANAGED_PROFILE
    || !sameAddress(managed.executor, config.executor) || (policy && !sameAddress(managed.executor, policy.executor))) return null;
  return {enabled: managed.enabled, executor: config.executor, profile: TEMPO_MANAGED_PROFILE,
    ...(typeof managed.reason === 'string' ? {reason: managed.reason.slice(0, 300)} : {})};
}
export function tempoManagedReady(config: TempoConfig, policy?: TempoPolicy, state?: unknown): boolean {
  return checkedTempoManagedExecution(config.managedExecution, config, policy)?.enabled === true
    && (!policy || checkedTempoManagedExecution(state, config, policy)?.enabled === true);
}
export const TEMPO_MANAGED_UNAVAILABLE = 'Managed payments are unavailable for this deployment. Your vault and original requests remain available for owner recovery.';

export interface TempoManagedAgent {
  endpoint: string; statusEndpoint: string; resumeEndpoint: string; authorization: string; recovery: 'repeat-identical-request';
  paymentKind: 'direct-token-transfer'; deliveryAttested: false; executor: TempoPolicy['executor'];
  policyId: string; policyDigest: string; requirementsDigest: string; requestSchema: Record<string, unknown>;
}
export interface TempoManagedExport {version: 1; profile: typeof TEMPO_MANAGED_PROFILE; origin: string; policy: TempoPolicy; managedAgent: TempoManagedAgent}
export function tempoManagedOrigin(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use the exact Allowit origin for managed payments.');
  return url.origin;
}
function endpoint(value: unknown, path: string, origin: string): string {
  if (typeof value !== 'string' || ![path, new URL(path, origin).href].includes(value)) throw new Error('The managed agent export changed its payment endpoint.');
  return new URL(path, origin).href;
}
/** Only explicit fields enter the private handoff; RPC credentials and signing material are never forwarded. */
export function checkedTempoManagedExport(value: unknown, config: TempoConfig, policy: TempoPolicy, originValue: string): TempoManagedExport {
  if (!tempoManagedReady(config)) throw new Error(TEMPO_MANAGED_UNAVAILABLE);
  const reply = object(value), managed = object(reply?.managedAgent), origin = tempoManagedOrigin(originValue);
  const returnedPolicy = checkedTempoPolicy(reply?.policy, config, policy.owner);
  const fields: (keyof TempoPolicy)[] = ['id', 'profile', 'network', 'chainId', 'owner', 'token', 'executor', 'authority', 'factory', 'vault', 'policyDigest', 'requirementsDigest', 'semanticRequired', 'prompt', 'dailyLimit', 'actionLimit', 'totalLimit', 'expiresAt', 'recipient'];
  const insensitive: (keyof TempoPolicy)[] = ['owner', 'token', 'executor', 'authority', 'factory', 'vault', 'recipient', 'policyDigest', 'requirementsDigest'];
  if (fields.some(key => insensitive.includes(key) ? String(returnedPolicy[key]).toLowerCase() !== String(policy[key]).toLowerCase() : returnedPolicy[key] !== policy[key])) throw new Error('The managed agent export changed its exact policy binding.');
  if (!managed || managed.recovery !== 'repeat-identical-request' || managed.paymentKind !== 'direct-token-transfer' || managed.deliveryAttested !== false
    || !sameAddress(managed.executor, policy.executor) || managed.policyId !== policy.id
    || String(managed.policyDigest).toLowerCase() !== policy.policyDigest.toLowerCase()
    || String(managed.requirementsDigest).toLowerCase() !== policy.requirementsDigest.toLowerCase()
    || reply?.version !== 1 || reply.profile !== 'tempo-native-v1'
    || typeof reply.capability !== 'string' || !/^tempo-executor\.[A-Za-z0-9_-]{1,2000}$/.test(reply.capability)
    || managed.authorization !== `Bearer ${reply.capability}`) throw new Error('The managed agent export could not be verified.');
  const schema = object(managed.requestSchema);
  const descriptors = {policyId: policy.id, requestId: 'stable-request-id', recipient: 'exact-recipient-address', amount: 'decimal-token-amount', action: 'exact-action', merchant: 'exact-merchant-or-empty-string'};
  if (!schema || Object.entries(descriptors).some(([key, expected]) => schema[key] !== expected)
    || !object(schema.context) || Object.keys(schema.context as object).length) throw new Error('The managed agent request schema could not be verified.');
  const managedAgent: TempoManagedAgent = {endpoint: endpoint(managed.endpoint, '/api/tempo/spend', origin), statusEndpoint: endpoint(managed.statusEndpoint, '/api/tempo/spend/status', origin), resumeEndpoint: endpoint(managed.resumeEndpoint, '/api/tempo/spend/resume', origin),
    authorization: managed.authorization as string, recovery: 'repeat-identical-request', paymentKind: 'direct-token-transfer', deliveryAttested: false,
    executor: policy.executor, policyId: policy.id, policyDigest: policy.policyDigest, requirementsDigest: policy.requirementsDigest,
    requestSchema: {...descriptors, context: {}}};
  const publicPolicy = Object.fromEntries(fields.map(key => [key, policy[key]])) as unknown as TempoPolicy;
  return {version: 1, profile: TEMPO_MANAGED_PROFILE, origin, policy: publicPolicy, managedAgent};
}
