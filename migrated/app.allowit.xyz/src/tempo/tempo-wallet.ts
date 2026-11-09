import {createWalletClient, custom, defineChain, hexToNumber, isAddress, keccak256, recoverMessageAddress, stringToHex, type Address, type Hex} from 'viem';
import {tempoModerato} from 'viem/chains';
import {request} from '../api';
import {checkedTempoOwnerInput, sameAddress, tempoCanonicalJson, tempoInputIdentity, type TempoConfig, type TempoOwnerInput, type TempoPolicy, type TempoTransaction} from './tempo-contracts';

export interface TempoProvider {
  isMetaMask?: boolean;
  request(args: {method: string; params?: readonly unknown[] | object}): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}
declare global {interface Window {ethereum?: TempoProvider}}
export async function walletAddress(provider: TempoProvider, prompt = false): Promise<Address> {
  const accounts = await provider.request({method: prompt ? 'eth_requestAccounts' : 'eth_accounts'});
  if (!Array.isArray(accounts) || !isAddress(accounts[0])) throw new Error('Connect an EVM wallet to continue.');
  return accounts[0];
}
export async function checkTempoWallet(provider: TempoProvider, config: TempoConfig, expectedOwner: Address) {
  const chain = await provider.request({method: 'eth_chainId'});
  if (typeof chain !== 'string' || hexToNumber(chain as Hex) !== config.chainId) throw new Error(`Select Tempo ${config.network === 'tempo:localnet' ? 'Localnet' : 'Testnet'} in your wallet (chain ${config.chainId}).`);
  if (!sameAddress(await walletAddress(provider), expectedOwner)) throw new Error('The wallet address changed. Reconnect the policy owner.');
}
/** Select the configured chain before asking the owner to sign the site-bound message. */
export async function selectTempoChain(provider: TempoProvider, config: TempoConfig): Promise<void> {
  const selected = await provider.request({method: 'eth_chainId'});
  if (typeof selected === 'string' && hexToNumber(selected as Hex) === config.chainId) return;
  const chainId = `0x${config.chainId.toString(16)}`;
  try {await provider.request({method: 'wallet_switchEthereumChain', params: [{chainId}]});}
  catch (error) {
    if ((error as {code?: number})?.code !== 4902) throw error;
    await provider.request({method: 'wallet_addEthereumChain', params: [{chainId,
      chainName: config.network === 'tempo:localnet' ? 'Tempo Localnet' : 'Tempo Moderato Testnet',
      nativeCurrency: {name: 'USD', symbol: 'USD', decimals: 18}, rpcUrls: [config.rpcUrl]}]});
    await provider.request({method: 'wallet_switchEthereumChain', params: [{chainId}]});
  }
}
export async function signInTempo(provider: TempoProvider, config: TempoConfig): Promise<Address> {
  const address = await walletAddress(provider, true);
  await selectTempoChain(provider, config);
  await checkTempoWallet(provider, config, address);
  const challenge = await request<{id: string; address: Address; message: string; origin: string; expiresAt: string}>('tempo/auth/challenge', {address});
  const expiresAt = Date.parse(challenge.expiresAt);
  if (!sameAddress(challenge.address, address) || challenge.origin !== window.location.origin || typeof challenge.message !== 'string'
    || !challenge.message.includes(challenge.origin) || !challenge.message.toLowerCase().includes(address.toLowerCase()) || !challenge.message.includes(`\nChain ID: ${config.chainId}\n`) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('The sign-in message does not match this site or wallet.');
  const signature = await provider.request({method: 'personal_sign', params: [stringToHex(challenge.message), address]});
  if (typeof signature !== 'string' || !/^0x[\da-fA-F]{130}$/.test(signature) || !sameAddress(await recoverMessageAddress({message: challenge.message, signature: signature as Hex}), address)) throw new Error('The wallet signed with a different address.');
  await checkTempoWallet(provider, config, address);
  const reply = await request<{session: {address: string; network: string}}>('tempo/auth/verify', {id: challenge.id, address, message: challenge.message, signature});
  if (!sameAddress(reply.session?.address, address) || reply.session?.network !== 'tempo') throw new Error('The service did not verify this wallet.');
  return address;
}
export async function answerTempoInput(provider: TempoProvider, config: TempoConfig, policy: TempoPolicy, input: TempoOwnerInput, approved: boolean): Promise<void> {
  await checkedTempoOwnerInput(input, policy);
  await checkTempoWallet(provider, config, policy.owner);
  const intent = {policyId: policy.id, requestId: input.requestId, approved};
  const challenge = await request<{id: string; message: string; expiresAt: string; approved: boolean; policyId: string; requestId: string}>('tempo/input/challenge', intent);
  const expiry = Date.parse(challenge.expiresAt);
  const digest = typeof challenge.message === 'string' ? /^Exact request digest: ([0-9a-f]{64})$/m.exec(challenge.message)?.[1] : undefined;
  const exact = typeof challenge.message === 'string' ? /^Exact request: (.+)$/m.exec(challenge.message)?.[1] : undefined;
  let identityMatches = false;
  try {
    const parsed = JSON.parse(exact ?? ''), identity = tempoInputIdentity(input);
    identityMatches = Object.keys(parsed).length === Object.keys(identity).length
      && Object.entries(identity).every(([key, value]) => tempoCanonicalJson(parsed[key]) === tempoCanonicalJson(value));
  } catch {/* A changed payment preview is rejected before the wallet prompt. */}
  const expected = `AllowIt Tempo owner decision\nOwner: ${policy.owner.toLowerCase()}\nChain ID: ${config.chainId}\nVault: ${policy.vault.toLowerCase()}\nPolicy: ${policy.id}\nRequest: ${input.requestId}\nExact request digest: ${digest}\nInput key: ${input.inputKey}\nQuestion: ${input.question}\nExact request: ${exact}\nApproved: ${approved}\nNonce: ${challenge.id}\nExpiration Time: ${challenge.expiresAt}`;
  if (challenge.policyId !== policy.id || challenge.requestId !== input.requestId || challenge.approved !== approved || !Number.isFinite(expiry) || expiry <= Date.now()
    || digest !== input.intentDigest || !identityMatches || challenge.message !== expected) throw new Error('The owner decision message changed the exact question or answer.');
  const signature = await provider.request({method: 'personal_sign', params: [stringToHex(challenge.message), policy.owner]});
  if (typeof signature !== 'string' || !/^0x[\da-fA-F]{130}$/.test(signature) || !sameAddress(await recoverMessageAddress({message: challenge.message, signature: signature as Hex}), policy.owner)) throw new Error('The decision was not signed by the policy owner.');
  await checkTempoWallet(provider, config, policy.owner);
  const reply = await request<{policyId: string; requestId: string; approved: boolean; status: string; executionAuthorized: boolean}>('tempo/input/answer', {...intent, id: challenge.id, message: challenge.message, signature});
  if (reply.policyId !== policy.id || reply.requestId !== input.requestId || reply.approved !== approved || reply.status !== 'answered' || reply.executionAuthorized !== false) throw new Error('The service did not record the exact owner answer.');
}
/** MetaMask uses the supported EVM owner envelope; Tempo providers retain their native fee field. */
export async function sendTempoTransaction(provider: TempoProvider, config: TempoConfig, tx: TempoTransaction, beforeSend?: () => void): Promise<Hex> {
  let changed = false;
  const walletChanged = () => {changed = true;};
  const events = ['accountsChanged', 'chainChanged', 'disconnect'];
  for (const event of events) provider.on?.(event, walletChanged);
  try {
    await checkTempoWallet(provider, config, tx.from);
    const code = await provider.request({method: 'eth_getCode', params: [config.factory, 'latest']});
    if (typeof code !== 'string' || code === '0x' || keccak256(code as Hex).toLowerCase() !== config.factoryCodeHash.toLowerCase()) throw new Error('The Tempo deployment differs from the configured contract.');
    await checkTempoWallet(provider, config, tx.from);
    if (changed) throw new Error('The wallet changed while checking the transaction. Reconnect before signing.');
    // The selected draft/owner can change while the provider performs these asynchronous
    // checks. Revalidate the UI's reviewed scope at the last point before the wallet prompt.
    beforeSend?.();
  } catch (error) {throw Object.assign(error instanceof Error ? error : new Error('The wallet could not verify the Tempo deployment.'), {beforeSend: true});}
  finally {for (const event of events) provider.removeListener?.(event, walletChanged);}
  if (provider.isMetaMask === true) {
    // Moderato disables MetaMask's native Tempo transaction transformation. Choose this
    // envelope before prompting, never retry a declined or uncertain send in another format.
    // EVM fees use Tempo's wallet fee preference/default pathUSD, not tx.feeToken.
    const hash = await provider.request({method: 'eth_sendTransaction', params: [{chainId: `0x${config.chainId.toString(16)}`, from: tx.from, to: tx.to, data: tx.data, value: '0x0'}]});
    if (typeof hash !== 'string' || !/^0x[\da-fA-F]{64}$/.test(hash)) throw new Error('The wallet returned an unreadable transaction hash. Preserve this request for recovery.');
    return hash as Hex;
  }
  const chain = defineChain({...tempoModerato, id: config.chainId, name: config.network === 'tempo:localnet' ? 'Tempo Localnet' : tempoModerato.name,
    rpcUrls: {default: {http: [config.rpcUrl]}}, feeToken: config.feeToken});
  let preventedSend = false, attemptedSend = false;
  const guardedProvider: TempoProvider = {request: args => {
    if (['eth_sendTransaction', 'wallet_sendTransaction', 'wallet_sendCalls', 'eth_sendRawTransaction'].includes(args.method)) {
      if (attemptedSend) throw new Error('The original wallet send is unresolved. Check its status before authorizing another transaction.');
      try {beforeSend?.();} catch (error) {preventedSend = true; throw error;}
      attemptedSend = true;
    }
    return provider.request(args);
  }};
  const client = createWalletClient({chain, transport: custom(guardedProvider, {retryCount: 0})});
  let hash: Hex;
  try {hash = await client.sendTransaction({account: tx.from, to: tx.to, data: tx.data, value: 0n, feeToken: config.feeToken});}
  catch (error) {
    // viem wraps provider errors; only a rejection before calling the actual send may
    // leave the original request prepared. An uncertain provider send remains uncertain.
    if (preventedSend && !attemptedSend) throw Object.assign(error instanceof Error ? error : new Error('The reviewed policy changed before sending.'), {beforeSend: true});
    throw error;
  }
  if (!/^0x[\da-fA-F]{64}$/.test(hash)) throw new Error('The wallet returned an unreadable transaction hash. Preserve this request for recovery.');
  return hash;
}
