import {afterEach, describe, expect, it, vi} from 'vitest';
import {privateKeyToAccount} from 'viem/accounts';
import type {Hex} from 'viem';
import * as api from '../api';
import {answerTempoInput, signInTempo, type TempoProvider} from './tempo-wallet';
import {TEST_CONFIG, TEST_POLICY} from './tempo-fixtures';
import {sha256Hex} from '../runtime/hash';
import {checkedTempoOwnerInput, type TempoOwnerInput} from './tempo-contracts';

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const ORIGIN = 'http://127.0.0.1:5173';
const EXPIRES = new Date(Date.now() + 60_000).toISOString();
afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();});
async function ownerInput(): Promise<TempoOwnerInput> {
  const input = {policyId: TEST_POLICY.id, requestId: 'request-123', inputKey: 'review', question: 'Approve this research payment?', amount: '1', recipient: TEST_POLICY.recipient,
    action: 'transfer', merchant: 'research', token: TEST_POLICY.token, tokenSymbol: 'AlphaUSD', context: {reason: 'paper'}, contextRaw: '{"reason":"paper"}', intentDigest: ''};
  input.intentDigest = await sha256Hex(new TextEncoder().encode(JSON.stringify({action: input.action, amount: input.amount, context: input.contextRaw, merchant: input.merchant, policyId: input.policyId, recipient: input.recipient.toLowerCase()})));
  return input;
}
function wallet() {
  let signed = false, changeAfterSign = false;
  const provider: TempoProvider = {request: vi.fn(async ({method, params}) => {
    if (method === 'eth_chainId') return signed && changeAfterSign ? '0x1' : '0x7a69';
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account.address];
    if (method === 'personal_sign') {signed = true;return account.signMessage({message: {raw: (params as string[])[0] as Hex}});}
    throw new Error('Unexpected wallet request');
  })};
  return {provider, changeAfterSign: () => {changeAfterSign = true;}};
}
describe('Tempo exact owner signatures', () => {
  it('accepts the API and CLI request ID punctuation without allowing message separators', async () => {
    const input = {...await ownerInput(), requestId: 'task.alpha:42'};
    expect(await checkedTempoOwnerInput(input, TEST_POLICY)).toBe(input);
    for (const requestId of ['task/alpha:42', 'task\nalpha:42', 'short']) await expect(checkedTempoOwnerInput({...input, requestId}, TEST_POLICY)).rejects.toThrow('payment identity');
  });
  it('signs the origin and chain-bound one-use message and sends only verifier fields', async () => {
    vi.stubGlobal('window', {location: {origin: ORIGIN}});
    const message = `${account.address}\nSign in to AllowIt Tempo.\nURI: ${ORIGIN}\nChain ID: 31337\nNonce: one-use`;
    const request = vi.spyOn(api, 'request').mockResolvedValueOnce({id: 'one-use', address: account.address, message, origin: ORIGIN, expiresAt: EXPIRES}).mockResolvedValueOnce({session: {address: account.address, network: 'tempo'}});
    const f = wallet();
    expect(await signInTempo(f.provider, TEST_CONFIG)).toBe(account.address);
    const body = request.mock.calls[1][1] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['address', 'id', 'message', 'signature']);
    expect(body.message).toBe(message);expect(body.signature).toMatch(/^0x[\da-f]{130}$/);
  });
  it('invalid expiry or a different chain is rejected before signing', async () => {
    vi.stubGlobal('window', {location: {origin: ORIGIN}});
    const request = vi.spyOn(api, 'request').mockResolvedValue({id: 'id', address: account.address, message: `${account.address} ${ORIGIN}\nChain ID: 1\n`, origin: ORIGIN, expiresAt: 'not a date'});
    const f = wallet();await expect(signInTempo(f.provider, TEST_CONFIG)).rejects.toThrow('sign-in');
    expect(request).toHaveBeenCalledOnce();expect(vi.mocked(f.provider.request).mock.calls.some(([request]) => request.method === 'personal_sign')).toBe(false);
  });
  it('wallet chain changes during the message prompt invalidate sign-in before verification', async () => {
    vi.stubGlobal('window', {location: {origin: ORIGIN}});
    const message = `${account.address} ${ORIGIN}\nChain ID: 31337\n`;
    const request = vi.spyOn(api, 'request').mockResolvedValue({id: 'id', address: account.address, message, origin: ORIGIN, expiresAt: EXPIRES});
    const f = wallet();f.changeAfterSign();await expect(signInTempo(f.provider, TEST_CONFIG)).rejects.toThrow('Select Tempo');expect(request).toHaveBeenCalledOnce();
  });
  it('a challenge substituting the answer or request never reaches the signer', async () => {
    const policy = {...TEST_POLICY, owner: account.address}, input = await ownerInput();
    vi.spyOn(api, 'request').mockResolvedValue({id: 'id', message: 'Approve something else', expiresAt: EXPIRES, approved: false, policyId: policy.id, requestId: 'other-request'});
    const f = wallet();await expect(answerTempoInput(f.provider, TEST_CONFIG, policy, input, true)).rejects.toThrow('exact question');
    expect(vi.mocked(f.provider.request).mock.calls.some(([request]) => request.method === 'personal_sign')).toBe(false);
  });
  it('a payment amount substituted in the preview cannot reach the signer', async () => {
    const policy = {...TEST_POLICY, owner: account.address}, input = {...await ownerInput(), amount: '2'};
    const request = vi.spyOn(api, 'request');
    const f = wallet();await expect(answerTempoInput(f.provider, TEST_CONFIG, policy, input, true)).rejects.toThrow('request digest');
    expect(request).not.toHaveBeenCalled();expect(vi.mocked(f.provider.request).mock.calls.some(([request]) => request.method === 'personal_sign')).toBe(false);
  });
});
