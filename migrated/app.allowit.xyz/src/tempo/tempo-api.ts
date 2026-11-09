import type {Address, Hex} from 'viem';
import {request} from '../api';
import {sha256Hex} from '../runtime/hash';
import {checkedTempoManagedExecution, checkedTempoManagedExport, tempoManagedReady, TEMPO_MANAGED_UNAVAILABLE} from './tempo-managed';
import type {TempoManagedExecution} from './tempo-contracts';
import {checkedTempoConfig, checkedTempoPolicy, checkedTempoTransaction, checkedTempoOwnerInput, checkedTempoOperation, sameAddress, bytes32, tempoUnits, type TempoConfig, type TempoExecutionPolicy, type TempoOwnerInput, type TempoMethod, type TempoOperation, type TempoOptions, type TempoPolicy, type TempoPrepared, type TempoState, type TempoTransaction} from './tempo-contracts';

export interface TempoCustodyState {
  state: TempoState | null;
  operations: TempoOperation[];
  pendingInputs: TempoOwnerInput[];
  executionPolicy: TempoExecutionPolicy | null;
  /** Only a verified immutable snapshot may associate a vault with a draft. */
  boundExecutionPolicyId: string | null;
  boundSnapshot: TempoExecutionSnapshot | null;
  /** Source presentation is separate from verified owner custody and its recovery controls. */
  sourceError: string;
  activityError: string;
  inputError: string;
  managedExecution?: TempoManagedExecution | null;
}
interface TempoStateReply {state: TempoState | null; operations?: TempoOperation[]; pendingInputs?: TempoOwnerInput[]; executionPolicy?: TempoExecutionPolicy; managedExecution?: unknown}

async function checkedCustodyReply(reply: TempoStateReply, policy: TempoPolicy, config: TempoConfig, owner: Address, recovery = false) {
  if (!reply || reply.state === undefined || (reply.state !== null && (typeof reply.state !== 'object' || Array.isArray(reply.state)))) throw new Error('The current vault state could not be verified.');
  if (reply.state?.owner !== undefined && !sameAddress(reply.state.owner, owner)) throw new Error('The vault belongs to another wallet.');
  if (reply.state?.token !== undefined && !sameAddress(reply.state.token, policy.token)) throw new Error('The vault uses another token.');
  const integer = (value: unknown) => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && BigInt(value) <= (1n << 256n) - 1n;
  if (reply.state && (typeof reply.state.approved !== 'boolean' || typeof reply.state.revoked !== 'boolean' || (reply.state.approved && reply.state.revoked)
    || ['balance', 'spentToday', 'totalSpent'].some(field => !integer(reply.state![field as keyof TempoState])))) throw new Error('The vault balances or approval status could not be verified.');
  if (reply.state && ['dailyLimit', 'actionLimit', 'totalLimit', 'spent'].some(field => reply.state![field as keyof TempoState] !== undefined && !integer(reply.state![field as keyof TempoState]))) throw new Error('The current vault limits could not be verified.');
  const pendingInputs: TempoOwnerInput[] = [], operations: TempoOperation[] = [];
  let inputError = '', activityError = '';
  try {
    if (!Array.isArray(reply.pendingInputs ?? [])) throw new Error('The owner questions could not be read.');
    for (const input of reply.pendingInputs ?? []) {
      try {pendingInputs.push(await checkedTempoOwnerInput(input, policy));}
      catch (error) {if (!recovery) throw error; inputError = 'Some owner questions could not be verified and are unavailable.';}
    }
  } catch (error) {if (!recovery) throw error; inputError = 'The owner questions could not be verified and are unavailable.';}
  try {
    if (!Array.isArray(reply.operations ?? [])) throw new Error('The vault activity could not be read.');
    for (const operation of reply.operations ?? []) {
      try {operations.push(checkedTempoOperation(operation, policy.id, policy, config));}
      catch (error) {if (!recovery) throw error; activityError = 'Some vault activity could not be verified and is omitted.';}
    }
  } catch (error) {if (!recovery) throw error; activityError = 'The vault activity could not be verified and is unavailable.';}
  // Ancillary activity/questions cannot invalidate otherwise checked owner custody.
  // Omitted activity is never presented as a confirmed payment or failed chain transaction.
  return {state: reply.state, operations, pendingInputs, activityError, inputError};
}

export class TempoAPI {
  constructor(readonly config: TempoConfig, readonly owner: Address) {}
  static async config() {return checkedTempoConfig(await request('tempo/config'));}
  async generate(input: {prompt?: string; dailyLimit?: string; actionLimit?: string; totalLimit: string; recipient?: string; semanticRequired?: boolean; executionPolicyId?: string; executionSource?: string; expectedRevision?: number; expectedSourceHash?: string}) {
    const {policy, executionPolicy} = await request<{policy: unknown; executionPolicy?: TempoExecutionPolicy}>('tempo/generate', {network: this.config.network, ...input});
    const checked = checkedTempoPolicy(policy, this.config, this.owner);
    if (input.executionPolicyId) {
      // A vault for a reviewed draft takes its intent and semantic requirement from that draft's exact snapshot.
      if (!executionPolicy) throw new Error('The compiled policy is unavailable for owner review.');
      const reviewed = await checkedExecutionPolicy(executionPolicy, checked);
      const snapshot = JSON.parse(reviewed.bindingJson) as TempoExecutionSnapshot;
      if (snapshot.policyId !== input.executionPolicyId) throw new Error('The vault is bound to a different policy.');
      if ((input.expectedRevision !== undefined && snapshot.revision !== input.expectedRevision)
        || (input.expectedSourceHash !== undefined && bytes32(snapshot.sourceHash) !== bytes32(input.expectedSourceHash))) throw new Error('The vault changed the reviewed policy revision.');
      if ((input.dailyLimit !== undefined && checked.dailyLimit !== input.dailyLimit)
        || (input.actionLimit !== undefined && checked.actionLimit !== input.actionLimit)
        || checked.totalLimit !== input.totalLimit
        || (input.recipient !== undefined && !sameAddress(checked.recipient, input.recipient || '0x0000000000000000000000000000000000000000'))) throw new Error('The vault changed the requested limits or recipient.');
      if (input.dailyLimit === undefined || input.actionLimit === undefined) {
        if (!Number.isSafeInteger(input.expectedRevision) || !input.expectedSourceHash
          || tempoUnits(checked.dailyLimit) > 50_000_000n
          || !sameAddress(checked.recipient, '0x0000000000000000000000000000000000000000')) throw new Error('The policy-derived vault terms could not be verified.');
      }
      return {policy: checked, executionPolicy: reviewed};
    }
    if (checked.prompt !== input.prompt || checked.dailyLimit !== input.dailyLimit || checked.actionLimit !== input.actionLimit || checked.totalLimit !== input.totalLimit || !sameAddress(checked.recipient, input.recipient)) throw new Error('The generated policy changed the requested limits or recipient.');
    if (input.semanticRequired !== checked.semanticRequired) throw new Error('The generated policy changed the requested Jev requirement.');
    if (checked.semanticRequired && (!executionPolicy || !executionPolicy.semanticRequired || bytes32(executionPolicy.requirementsDigest) !== bytes32(checked.requirementsDigest) || typeof executionPolicy.source !== 'string' || !executionPolicy.source)) throw new Error('The compiled semantic policy is unavailable for owner review.');
    if (input.executionSource && executionPolicy?.source !== input.executionSource) throw new Error('The compiler returned a different policy source.');
    return {policy: checked, executionPolicy: executionPolicy ? await checkedExecutionPolicy(executionPolicy, checked) : null};
  }
  async policies(): Promise<TempoPolicy[]> {
    const {policies} = await request<{policies: unknown[]}>('tempo/policies');
    if (!Array.isArray(policies)) throw new Error('The saved Tempo policies could not be read.');
    return policies.map(policy => checkedTempoPolicy(policy, this.config, this.owner));
  }
  async state(policy: TempoPolicy): Promise<TempoCustodyState> {
    checkedTempoPolicy(policy, this.config, this.owner);
    const reply = await request<TempoStateReply>('tempo/state', {policyId: policy.id});
    const custody = await checkedCustodyReply(reply, policy, this.config, this.owner);
    const executionPolicy = reply.executionPolicy ? await checkedExecutionPolicy(reply.executionPolicy, policy) : null;
    const boundSnapshot = executionPolicy ? await checkedExecutionSnapshot(executionPolicy.bindingJson, policy) : null;
    return {...custody, executionPolicy, boundExecutionPolicyId: boundSnapshot?.policyId ?? null, boundSnapshot, sourceError: '', managedExecution: checkedTempoManagedExecution(reply.managedExecution, this.config, policy)};
  }
  /** A failed source presentation must not hide verified custody or prevent owner recovery. */
  async custodyState(policy: TempoPolicy): Promise<TempoCustodyState> {
    checkedTempoPolicy(policy, this.config, this.owner);
    const reply = await request<TempoStateReply>('tempo/state', {policyId: policy.id});
    const custody = await checkedCustodyReply(reply, policy, this.config, this.owner, true);
    let boundSnapshot: TempoExecutionSnapshot | null = null, executionPolicy: TempoExecutionPolicy | null = null;
    let sourceError = '';
    try {
      boundSnapshot = await checkedExecutionSnapshot(reply.executionPolicy?.bindingJson, policy);
      executionPolicy = await checkedExecutionPolicy(reply.executionPolicy!, policy);
    } catch (error) {
      // A valid immutable binding may still identify the owner's vault when its source
      // presentation is damaged. Neither case grants new spending permission.
      sourceError = error instanceof Error ? error.message : 'The vault policy source could not be verified.';
    }
    return {...custody, executionPolicy, boundExecutionPolicyId: boundSnapshot?.policyId ?? null, boundSnapshot, sourceError, managedExecution: checkedTempoManagedExecution(reply.managedExecution, this.config, policy)};
  }
  async prepare(policy: TempoPolicy, requestId: string, method: Exclude<TempoMethod, 'execute'>, options: TempoOptions) {
    const prepared = await request<TempoPrepared>('tempo/prepare', {policyId: policy.id, requestId, method, options});
    checkedTempoTransaction(this.config, policy, this.owner, method, options, requestId, prepared);
    return prepared;
  }
  async recover(policyId: string, requestId: string, transactionHash?: Hex): Promise<TempoOperation> {
    const {operation} = await request<{operation: TempoOperation}>(transactionHash ? 'tempo/submit' : 'tempo/recover', {policyId, requestId, ...(transactionHash ? {transactionHash} : {})});
    checkedTempoOperation(operation, policyId);
    if (operation.id !== requestId || (transactionHash && operation.transactionHash?.toLowerCase() !== transactionHash.toLowerCase())) throw new Error('The service returned a different operation receipt.');
    return operation;
  }
  async export(policy: TempoPolicy, origin: string) {
    checkedTempoPolicy(policy, this.config, this.owner);
    if (!tempoManagedReady(this.config)) throw new Error(TEMPO_MANAGED_UNAVAILABLE);
    const reply = await request<unknown>('tempo/export', {policyId: policy.id}, {expectedOwner: `tempo:${this.owner}`});
    return checkedTempoManagedExport(reply, this.config, policy, origin);
  }
}
export interface TempoExecutionSnapshot {policyId: string; revision: number; code: string; sourceHash: string; workflow: unknown[]; originalIntent: string; requirementsDigest: string; semanticRequired: boolean}
/** Verify the immutable snapshot independently of the displayed source response. */
export async function checkedExecutionSnapshot(bindingJson: unknown, policy: TempoPolicy): Promise<TempoExecutionSnapshot> {
  if (typeof bindingJson !== 'string' || bytes32(await sha256Hex(new TextEncoder().encode(bindingJson))) !== bytes32(policy.policyDigest)) throw new Error('The displayed source is not bound to the vault policy.');
  const snapshot = JSON.parse(bindingJson);
  if (!snapshot || typeof snapshot.policyId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(snapshot.policyId) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !Array.isArray(snapshot.workflow)
    || typeof snapshot.code !== 'string' || !snapshot.code || bytes32(snapshot.sourceHash) !== bytes32(await sha256Hex(new TextEncoder().encode(snapshot.code))) || snapshot.originalIntent !== policy.prompt
    || bytes32(snapshot.requirementsDigest) !== bytes32(policy.requirementsDigest) || snapshot.semanticRequired !== policy.semanticRequired) throw new Error('The reviewed source differs from the exact vault policy snapshot.');
  return snapshot;
}
export async function checkedExecutionPolicy(source: TempoExecutionPolicy, policy: TempoPolicy) {
  if (typeof source.source !== 'string' || !source.source || source.semanticRequired !== policy.semanticRequired || bytes32(source.requirementsDigest) !== bytes32(policy.requirementsDigest)
    || bytes32(source.sourceHash) !== bytes32(await sha256Hex(new TextEncoder().encode(source.source)))) throw new Error('The displayed source changed its exact compiled policy binding.');
  const snapshot = await checkedExecutionSnapshot(source.bindingJson, policy);
  if (snapshot.code !== source.source || bytes32(snapshot.sourceHash) !== bytes32(source.sourceHash)) throw new Error('The reviewed source differs from the exact vault policy snapshot.');
  return source;
}

export interface TempoRecord {version: 1; owner: Address; chainId: number; policyId: string; id: string; method: Exclude<TempoMethod, 'execute'>; options: TempoOptions; phase: 'preparing' | 'prepared' | 'sending' | 'declined' | 'observed'; prepared?: TempoPrepared; transactionHash?: Hex; operation?: TempoOperation}
export interface TempoStore {channel?: string; read(): Promise<TempoRecord | null>; write(record: TempoRecord, updateLatest?: boolean): Promise<void>; entries(channel?: string): Promise<TempoRecord[]>; locked<T>(run: () => Promise<T>): Promise<T>}
export const tempoChannel = (method: TempoMethod) => method === 'revoke' || method === 'withdraw' ? method : 'spending';
/** Corrupted saved requests cannot disappear silently and authorize a fresh transaction. */
export function checkedTempoRecord(value: unknown, config: TempoConfig, owner: Address, policy: TempoPolicy): TempoRecord {
  const record = value as TempoRecord;
  if (!record || record.version !== 1 || !sameAddress(record.owner, owner) || record.chainId !== config.chainId || record.policyId !== policy.id
    || typeof record.id !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(record.id)
    || !['approve_deploy', 'deploy', 'approve_fund', 'fund', 'tune', 'revoke', 'withdraw'].includes(record.method)
    || !['preparing', 'prepared', 'sending', 'declined', 'observed'].includes(record.phase)
    || !record.options || typeof record.options !== 'object' || Array.isArray(record.options)
    || Object.entries(record.options).some(([key, amount]) => !['amount', 'dailyLimit', 'actionLimit', 'totalLimit'].includes(key) || typeof amount !== 'string')
    || (record.transactionHash !== undefined && !/^0x[\da-fA-F]{64}$/.test(record.transactionHash))) throw new Error('The saved Tempo request could not be verified. Keep its original identity before signing again.');
  for (const amount of Object.values(record.options)) tempoUnits(amount!);
  if (record.prepared) checkedTempoTransaction(config, policy, owner, record.method, record.options, record.id, record.prepared);
  if (record.operation) {
    const operation = checkedTempoOperation(record.operation, policy.id);
    if (operation.id !== record.id || operation.method !== record.method || (record.transactionHash && operation.transactionHash && operation.transactionHash.toLowerCase() !== record.transactionHash.toLowerCase())) throw new Error('The saved Tempo receipt changed the original request.');
  }
  return record;
}
export function tempoStore(config: TempoConfig, owner: Address, policy: TempoPolicy, channel = 'spending'): TempoStore {
  const scope = `${config.chainId}.${owner.toLowerCase()}.${policy.id}`, key = `${scope}:${channel}`;
  async function database() {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const opened = indexedDB.open('allowit-tempo-v1', 1);
      opened.onupgradeneeded = () => opened.result.createObjectStore('requests');
      opened.onsuccess = () => resolve(opened.result);
      opened.onerror = () => reject(new Error('Enable device storage before signing a Tempo request.'));
    });
  }
  async function committed<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await database();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction('requests', mode, {durability: 'strict'});
        const result = action(tx.objectStore('requests'));
        tx.oncomplete = () => resolve(result.result as T);
        tx.onabort = tx.onerror = () => reject(new Error('The Tempo request could not be preserved. No additional transaction should be sent.'));
      });
    } finally {db.close();}
  }
  return {
    channel,
    async read() {
      const record = await committed<TempoRecord | undefined>('readonly', store => store.get(key + ':latest'));
      if (!record) return null;
      return checkedTempoRecord(record, config, owner, policy);
    },
    async write(record, updateLatest = true) {
      await committed('readwrite', store => {
        const saved = store.put(record, scope + ':request:' + record.id);
        return updateLatest ? store.put(record, key + ':latest') : saved;
      });
    },
    async entries(selectedChannel) {
      const entries = await committed<TempoRecord[]>('readonly', store => store.getAll(IDBKeyRange.bound(scope + ':request:', scope + ':request:\uffff')));
      // Emergency channels remain independent of spending history; their own latest and
      // selected records are still validated before a status check or wallet send.
      return entries.filter(record => selectedChannel === undefined || tempoChannel(record?.method) === selectedChannel)
        .map(record => checkedTempoRecord(record, config, owner, policy));
    },
    async locked(run) {
      if (!navigator.locks) throw new Error('This browser cannot safely serialize Tempo operations.');
      return navigator.locks.request('allowit-tempo-v1:' + scope, {mode: 'exclusive'}, run);
    },
  };
}
export const terminalTempoOperation = (operation?: TempoOperation) => operation?.status === 'settled' || operation?.status === 'failed';
export const pendingTempoRecord = (record: TempoRecord | null) => !!record && !terminalTempoOperation(record.operation);

/** An uncertain wallet send is never repeated. Only its exact request and returned hash may be reconciled. */
export class TempoLifecycle {
  private busy = false;
  constructor(readonly api: TempoAPI, readonly policy: TempoPolicy, readonly store: TempoStore, readonly send: (tx: TempoTransaction) => Promise<Hex>) {}
  async recover(requestId?: string): Promise<TempoRecord | null> {
    return this.store.locked(async () => {
    const latest = await this.store.read();
    const record = requestId ? (await this.store.entries(this.store.channel)).find(saved => saved.id === requestId) : latest;
    if (!record) return null;
    if (!sameAddress(record.owner, this.api.owner) || record.chainId !== this.api.config.chainId || record.policyId !== this.policy.id) throw new Error('The saved request belongs to another owner or network.');
    const operation = await this.api.recover(this.policy.id, record.id, record.transactionHash);
    if (operation.method !== record.method) throw new Error('The receipt changed the saved operation.');
    const phase = operation.status === 'prepared' ? record.phase : 'observed';
    const result: TempoRecord = {...record, phase, operation};
    await this.store.write(result, latest?.id === record.id);
    return result;
    });
  }
  async submit(method: Exclude<TempoMethod, 'execute'>, options: TempoOptions = {}, progress?: (phase: string) => void, originalRequestId?: string): Promise<TempoRecord> {
    if (this.busy) throw new Error('Another Tempo operation is in progress.');
    this.busy = true;
    try {return await this.store.locked(async () => {
      const entries = await this.store.entries(tempoChannel(method)), prior = await this.store.read();
      const selected = originalRequestId ? entries.find(saved => saved.id === originalRequestId) : null;
      if (originalRequestId && (!selected || selected.version !== 1 || selected.chainId !== this.api.config.chainId || !sameAddress(selected.owner, this.api.owner)
        || selected.policyId !== this.policy.id || selected.method !== method || JSON.stringify(selected.options) !== JSON.stringify(options))) throw new Error('The original request does not match this owner, vault or reviewed transaction.');
      if (selected && (terminalTempoOperation(selected.operation) || selected.transactionHash || !['prepared', 'preparing', 'declined'].includes(selected.phase))) throw new Error('Check the original status before authorizing this transaction again.');
      if (selected && pendingTempoRecord(prior) && prior!.id !== selected.id) throw new Error('Recover the other unresolved request before approving this original transaction.');
      if (entries.some(saved => pendingTempoRecord(saved) && tempoChannel(saved.method) === tempoChannel(method) && saved.id !== (selected?.id ?? prior?.id))) throw new Error('Recover the earlier unresolved request before authorizing another transaction.');
      if (pendingTempoRecord(prior) && !['prepared', 'preparing', 'declined'].includes(prior!.phase)) throw new Error('Recover the previous request before authorizing another transaction.');
      const same = prior && prior.method === method && JSON.stringify(prior.options) === JSON.stringify(options);
      if (pendingTempoRecord(prior) && !same) throw new Error('Keep the original request unchanged until it is resolved.');
      let record: TempoRecord = selected ?? (same && !terminalTempoOperation(prior!.operation) ? prior! : {version: 1, owner: this.api.owner, chainId: this.api.config.chainId, policyId: this.policy.id, id: crypto.randomUUID(), method, options, phase: 'preparing'});
      await this.store.write(record);
      progress?.('Preparing the exact transaction…');
      const prepared = record.prepared ?? await this.api.prepare(this.policy, record.id, method, options);
      const tx = checkedTempoTransaction(this.api.config, this.policy, this.api.owner, method, options, record.id, prepared);
      record = {...record, prepared, phase: 'prepared'};
      await this.store.write(record);
      progress?.('Approve the transaction in your wallet.');
      record = {...record, phase: 'sending'};
      await this.store.write(record);
      let hash: Hex;
      try {hash = await this.send(tx);}
      catch (error) {
        if ((error as {code?: number})?.code === 4001 || (error as {cause?: {code?: number}})?.cause?.code === 4001) {
          record = {...record, phase: 'declined'}; await this.store.write(record);
        } else if ((error as {beforeSend?: boolean})?.beforeSend === true) {
          record = {...record, phase: 'prepared'}; await this.store.write(record);
        }
        throw error;
      }
      record = {...record, transactionHash: hash};
      try {await this.store.write(record);}
      catch {throw new Error(`Your wallet returned transaction ${hash}, but this device could not preserve its hash. Keep this hash and the original request ID; do not authorize another transaction.`);}
      progress?.('Checking the transaction receipt…');
      try {
        const operation = await this.api.recover(this.policy.id, record.id, hash);
        record = {...record, operation, phase: 'observed'};
        await this.store.write(record);
      } catch { /* The hash remains saved. Recover never signs or sends a second transaction. */ }
      return record;
    });
    } finally {this.busy = false;}
  }
}
