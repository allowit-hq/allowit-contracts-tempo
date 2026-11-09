import {describe, expect, it, vi} from 'vitest';
import {checkTempoWallet, sendTempoTransaction, type TempoProvider} from './tempo-wallet';
import {TEST_CODE, TEST_CONFIG, TEST_HASH, TEST_OWNER, testPrepared} from './tempo-fixtures';
function provider(chain = '0x7a69', owner = TEST_OWNER, code = TEST_CODE) {
  const calls: {method: string; params?: unknown}[] = [];
  const wallet: TempoProvider = {request: vi.fn(async request => {
    calls.push(request);
    if (request.method === 'eth_chainId') return chain;
    if (request.method === 'eth_accounts') return [owner];
    if (request.method === 'eth_getCode') return code;
    if (request.method === 'eth_sendTransaction') return TEST_HASH;
    throw new Error(`Unexpected wallet request ${request.method}`);
  })};
  return {wallet, calls};
}
describe('Tempo owner wallet transport', () => {
  it('refuses another chain and account before any send', async () => {
    for (const f of [provider('0x1'), provider('0x7a69', TEST_CONFIG.executor)]) {
      await expect(checkTempoWallet(f.wallet, TEST_CONFIG, TEST_OWNER)).rejects.toThrow();expect(f.calls.some(c => c.method === 'eth_sendTransaction')).toBe(false);
    }
  });
  it('refuses changed deployment bytecode before any send', async () => {
    const f = provider('0x7a69', TEST_OWNER, '0x6002');
    await expect(sendTempoTransaction(f.wallet, TEST_CONFIG, testPrepared('fund').transaction)).rejects.toMatchObject({beforeSend: true});
    expect(f.calls.some(c => c.method === 'eth_sendTransaction')).toBe(false);
  });
  it('uses Tempo transaction formatting with the explicit stablecoin fee token', async () => {
    const f = provider(); const tx = testPrepared('fund').transaction;
    expect(await sendTempoTransaction(f.wallet, TEST_CONFIG, tx)).toBe(TEST_HASH);
    const sent = f.calls.find(c => c.method === 'eth_sendTransaction');
    expect(sent).toBeDefined();
    const params = sent!.params as Record<string, unknown>[];
    expect(params[0]).toMatchObject({from: TEST_OWNER, calls: [{to: tx.to, data: tx.data, value: '0x'}], feeToken: TEST_CONFIG.feeToken});
  });
  it('sends the exact owner call through MetaMask without native-only fields', async () => {
    const f = provider(); f.wallet.isMetaMask = true;
    const tx = testPrepared('deploy').transaction;
    expect(await sendTempoTransaction(f.wallet, TEST_CONFIG, tx)).toBe(TEST_HASH);
    const sent = f.calls.filter(c => c.method === 'eth_sendTransaction');
    expect(sent).toHaveLength(1);
    expect(sent[0].params).toEqual([{chainId: '0x7a69', from: TEST_OWNER, to: tx.to, data: tx.data, value: '0x0'}]);
  });
  it('never changes envelope or retries an uncertain MetaMask send', async () => {
    const f = provider(); f.wallet.isMetaMask = true;
    const original = f.wallet.request;
    f.wallet.request = vi.fn(async args => {
      if (args.method === 'eth_sendTransaction') {f.calls.push(args); throw new Error('Wallet connection lost');}
      return original(args);
    });
    await expect(sendTempoTransaction(f.wallet, TEST_CONFIG, testPrepared('fund').transaction)).rejects.toThrow('Wallet connection lost');
    expect(f.calls.filter(c => c.method === 'eth_sendTransaction')).toHaveLength(1);
  });
  it('rechecks the selected chain after reading contract bytecode', async () => {
    let chain = '0x7a69';
    const calls: string[] = [];
    const wallet: TempoProvider = {isMetaMask: true, request: vi.fn(async args => {
      calls.push(args.method);
      if (args.method === 'eth_chainId') return chain;
      if (args.method === 'eth_accounts') return [TEST_OWNER];
      if (args.method === 'eth_getCode') {chain = '0x1'; return TEST_CODE;}
      throw new Error('Unexpected wallet send');
    })};
    await expect(sendTempoTransaction(wallet, TEST_CONFIG, testPrepared('fund').transaction)).rejects.toMatchObject({beforeSend: true});
    expect(calls).not.toContain('eth_sendTransaction');
  });
  it('rechecks the owner after contract verification instead of sending from a changed account', async () => {
    const f = provider(); f.wallet.isMetaMask = true;
    let checkedCode = false;
    const original = f.wallet.request;
    f.wallet.request = vi.fn(async args => {
      if (args.method === 'eth_getCode') checkedCode = true;
      if (args.method === 'eth_accounts' && checkedCode) return [TEST_CONFIG.executor];
      return original(args);
    });
    await expect(sendTempoTransaction(f.wallet, TEST_CONFIG, testPrepared('fund').transaction)).rejects.toMatchObject({beforeSend: true});
    expect(f.calls.some(c => c.method === 'eth_sendTransaction')).toBe(false);
  });
  it('checks native wallet scope again at the actual provider send after viem performs internal reads', async () => {
    const f = provider(); let selected = true, checkedScope = false;
    const original = f.wallet.request;
    f.wallet.request = vi.fn(async args => {
      if (args.method === 'eth_chainId' && checkedScope) selected = false;
      return original(args);
    });
    const beforeSend = vi.fn(() => {checkedScope = true; if (!selected) throw new Error('The reviewed policy changed.');});
    await expect(sendTempoTransaction(f.wallet, TEST_CONFIG, testPrepared('fund').transaction, beforeSend)).rejects.toMatchObject({beforeSend: true});
    expect(beforeSend).toHaveBeenCalledTimes(2); expect(f.calls.some(c => c.method === 'eth_sendTransaction')).toBe(false);
  });
  it('never retries a native provider send whose response was lost', async () => {
    const f = provider(), original = f.wallet.request;
    f.wallet.request = vi.fn(async args => {
      if (args.method === 'eth_sendTransaction') {f.calls.push(args); throw new Error('Native wallet response lost');}
      return original(args);
    });
    await expect(sendTempoTransaction(f.wallet, TEST_CONFIG, testPrepared('fund').transaction)).rejects.toThrow('Native wallet response lost');
    expect(f.calls.filter(c => c.method === 'eth_sendTransaction')).toHaveLength(1);
  });
  it('does not switch wallet send methods after an ambiguous native provider rejection', async () => {
    const f = provider(), original = f.wallet.request;
    f.wallet.request = vi.fn(async args => {
      if (args.method === 'eth_sendTransaction' || args.method === 'wallet_sendTransaction') {f.calls.push(args); throw Object.assign(new Error('Ambiguous wallet reply'), {code: -32602});}
      return original(args);
    });
    let failure: unknown;
    try {await sendTempoTransaction(f.wallet, TEST_CONFIG, testPrepared('fund').transaction);} catch (error) {failure = error;}
    expect(failure).toBeInstanceOf(Error); expect(failure).not.toHaveProperty('beforeSend');
    expect(f.calls.filter(c => ['eth_sendTransaction', 'wallet_sendTransaction'].includes(c.method))).toHaveLength(1);
  });
  it.each(['chainChanged', 'disconnect'])('retains %s preflight events even when chain and account reads look unchanged', async event => {
    const f = provider(); f.wallet.isMetaMask = true;
    const listeners = new Map<string, (...args: unknown[]) => void>();
    f.wallet.on = (name, listener) => {listeners.set(name, listener);};
    f.wallet.removeListener = (name, listener) => {if (listeners.get(name) === listener) listeners.delete(name);};
    const original = f.wallet.request;
    f.wallet.request = vi.fn(async args => {
      const result = await original(args);
      if (args.method === 'eth_getCode') listeners.get(event)?.();
      return result;
    });
    await expect(sendTempoTransaction(f.wallet, TEST_CONFIG, testPrepared('fund').transaction)).rejects.toMatchObject({beforeSend: true});
    expect(f.calls.some(c => c.method === 'eth_sendTransaction')).toBe(false);
    expect(listeners.size).toBe(0);
  });
  it('stops a wallet change during preflight and removes its listeners', async () => {
    const f = provider(); f.wallet.isMetaMask = true;
    const listeners = new Map<string, (...args: unknown[]) => void>();
    f.wallet.on = (name, listener) => {listeners.set(name, listener);};
    f.wallet.removeListener = (name, listener) => {if (listeners.get(name) === listener) listeners.delete(name);};
    const original = f.wallet.request;
    f.wallet.request = vi.fn(async args => {
      const result = await original(args);
      if (args.method === 'eth_getCode') listeners.get('accountsChanged')?.([TEST_CONFIG.executor]);
      return result;
    });
    await expect(sendTempoTransaction(f.wallet, TEST_CONFIG, testPrepared('fund').transaction)).rejects.toMatchObject({beforeSend: true});
    expect(f.calls.some(c => c.method === 'eth_sendTransaction')).toBe(false);
    expect(listeners.size).toBe(0);
  });
});
