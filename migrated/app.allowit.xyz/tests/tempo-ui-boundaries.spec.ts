import {expect, test, type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {zeroAddress} from 'viem';
import {TEST_CONFIG, TEST_HASH, TEST_OWNER, TEST_POLICY, testPrepared} from '../src/tempo/tempo-fixtures';

/** Fixture-only refusal, recovery and display tests in the current shared workspace.
 * Wallet reads use local fixtures and every signature/send is refused. These fixtures are not chain-acceptance evidence or demo material. */
const source = 'use allowit::v1::prelude::*;\nasync fn execute(_ctx: &Context) -> PolicyResult { Ok(()) }';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const sourceHash = hash(source), now = new Date().toISOString();
/** Opens the shared revoke dialog from a vault's "Stop and return funds" section. */
async function openRevoke(page: Page, scope: Page | ReturnType<Page['locator']> = page) {
  await scope.getByRole('button', {name: 'Continue revoke…', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Revoke this policy?'});
  await expect(dialog).toBeVisible();
  return dialog;
}
const draft = {id: 'tempo-draft-fixture', title: 'Research purchases', explanation: 'Allow research purchases.', code: source, language: 'allowit-rust-v1', sourceHash, irHash: '04'.repeat(32),
  workflow: [], calls: [], functionHelp: [], requests: [], spentUnits: 0, mint: '', network: 'tempo:testnet', limit: '', token: 'USDC', revision: 1, status: 'draft',
  turns: [], createdAt: now, updatedAt: now, activity: [], originalIntent: TEST_POLICY.prompt};
type FixtureOptions = {managedConfig?: 'missing' | 'disabled' | 'mismatched'; managedState?: 'missing' | 'disabled' | 'mismatched' | 'fresh-disabled'; export?: boolean; invalidExport?: boolean; onExport?: () => void; active?: boolean; revoked?: boolean; sourceDerivedFunding?: boolean; requestedAmount?: string; generate?: boolean; onGenerate?: (input: unknown) => void; failRefresh?: boolean; delayedFirstState?: Promise<void>; delayedSecondState?: Promise<void>;
  onStateRead?: (count: number) => void; firstStateFails?: boolean; sourceMismatch?: boolean; draftMismatch?: boolean; bindingMissing?: boolean; activity?: boolean; expiredActivity?: boolean; duplicateVault?: boolean; failAfterStateRead?: number;
  mpp?: 'reported' | 'unavailable' | 'invalid' | 'forged' | 'pending' | 'unreported'};

async function workspace(page: Page, bound = false, options: FixtureOptions = {}) {
  const baseConfig = {...TEST_CONFIG, sourceDerivedFunding: options.sourceDerivedFunding ?? true, managedExecution: options.managedConfig === 'missing' ? undefined : {...TEST_CONFIG.managedExecution!, enabled: options.managedConfig !== 'disabled', executor: options.managedConfig === 'mismatched' ? TEST_OWNER : TEST_CONFIG.executor}};
  const config = options.mpp ? {...baseConfig, network: 'tempo:testnet', chainId: 42431, rpcUrl: 'https://rpc.moderato.tempo.xyz'} : baseConfig;
  const bindingJson = JSON.stringify({policyId: draft.id, revision: 1, sourceHash, irHash: draft.irHash, code: source, originalIntent: TEST_POLICY.prompt,
    workflow: [], requirementsDigest: TEST_POLICY.requirementsDigest, semanticRequired: true});
  const vault = {...TEST_POLICY, network: config.network, chainId: config.chainId, recipient: zeroAddress, policyDigest: `0x${hash(bindingJson)}`};
  const otherVault = {...vault, id: '07'.repeat(32), vault: '0x7777777777777777777777777777777777777777'};
  const networkDraft = {...draft, network: config.network};
  const originalDraft = options.requestedAmount ? {...networkDraft, fundingRequest: {amount: options.requestedAmount, token: 'USDC'}} : networkDraft;
  const visibleDraft = options.draftMismatch ? {...originalDraft, revision: 2, code: source + '\n// revised', sourceHash: hash(source + '\n// revised')} : originalDraft;
  const presentedSource = options.sourceMismatch ? source + '\n// substituted' : source;
  const mutations: string[] = []; let stateReads = 0, hasVault = bound;
  await page.addInitScript(({config, owner}) => {
    const fixture = window as unknown as {__tempoWalletCalls: number; __tempoWalletSends: number; ethereum: unknown};
    fixture.__tempoWalletCalls = 0; fixture.__tempoWalletSends = 0;
    fixture.ethereum = {request: (args: {method: string}) => {
      fixture.__tempoWalletCalls++;
      if (args.method === 'eth_chainId') return Promise.resolve(`0x${config.chainId.toString(16)}`);
      if (args.method === 'eth_accounts') return Promise.resolve([owner]);
      fixture.__tempoWalletSends++; throw new Error('This refusal/display test must not sign or send.');
    }};
  }, {config, owner: TEST_OWNER});
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/tempo/generate' && options.generate) {
      options.onGenerate?.(route.request().postDataJSON()); hasVault = true;
      await route.fulfill({json: {policy: vault, executionPolicy: {source, sourceHash, bindingJson, requirementsDigest: vault.requirementsDigest, semanticRequired: true}}}); return;
    }
    if (path === '/api/tempo/export' && options.export) {
      options.onExport?.();
      const capability = 'tempo-executor.private_fixture_capability';
      await route.fulfill({json: {version: 1, profile: 'tempo-native-v1', policy: vault, capability, config: {...config, rpcUrl: 'private-transport-marker'}, managedAgent: {
        endpoint: options.invalidExport ? 'https://wrong.example/api/tempo/spend' : '/api/tempo/spend', statusEndpoint: '/api/tempo/spend/status', resumeEndpoint: '/api/tempo/spend/resume', authorization: 'Bearer ' + capability,
        recovery: 'repeat-identical-request', paymentKind: 'direct-token-transfer', deliveryAttested: false, executor: config.executor, policyId: vault.id, policyDigest: vault.policyDigest, requirementsDigest: vault.requirementsDigest,
        requestSchema: {policyId: vault.id, requestId: 'stable-request-id', recipient: 'exact-recipient-address', amount: 'decimal-token-amount', action: 'exact-action', merchant: 'exact-merchant-or-empty-string', context: {}, transport: {key: 'private-transport-marker'}},
      }}}); return;
    }
    const stateRead = path === '/api/tempo/state' ? ++stateReads : 0;
    if (stateRead) options.onStateRead?.(stateRead);
    if (stateRead === 1 && options.delayedFirstState) await options.delayedFirstState;
    if (stateRead === 2 && options.delayedSecondState) await options.delayedSecondState;
    if ((stateRead > 1 && options.failRefresh) || (stateRead === 1 && options.firstStateFails) || (options.failAfterStateRead !== undefined && stateRead > options.failAfterStateRead)) {
      await route.fulfill({status: 503, json: {error: 'Read-only state unavailable'}}); return;
    }
    const purchase = {protocol: 'mpp', method: 'GET', url: 'https://service.example/paid', origin: 'https://service.example',
      requestDigest: `0x${'12'.repeat(32)}`, challengeDigest: `0x${'34'.repeat(32)}`, chainId: config.chainId, token: TEST_POLICY.token,
      recipient: TEST_POLICY.recipient, amountUnits: options.mpp === 'invalid' ? '2000000' : '1000000', memo: `0x${'56'.repeat(32)}`};
    const delivery = options.mpp === 'unreported' ? undefined : {status: options.mpp === 'unavailable' ? 'response_unavailable' : 'response_reported',
      reportedBy: 'executor', transactionHash: options.mpp === 'forged' ? `0x${'cd'.repeat(32)}` : TEST_HASH, challengeDigest: purchase.challengeDigest,
      httpStatus: options.mpp === 'unavailable' ? 503 : 200, reportedAt: '2026-10-13T01:00:00Z',
      receipt: {status: 'success', method: 'tempo', reference: TEST_HASH, timestamp: '2026-10-13T01:00:00Z'},
      responseDigest: `0x${'90'.repeat(32)}`, responseBytes: 42};
    const payment = {id: 'fixture-agent-payment', policyId: vault.id, method: 'execute', status: options.mpp === 'pending' ? 'submitted' : 'settled',
      transactionHash: TEST_HASH, blockNumber: options.mpp === 'pending' ? undefined : '123',
      transaction: {...testPrepared('fund').transaction, chainId: config.chainId, from: config.executor}, execution: {amountUnits: '1000000', recipient: TEST_POLICY.recipient},
      ...(options.mpp ? {purchase, delivery} : {})};
    const expired = {...payment, id: 'fixture-expired-request', status: 'failed', transactionHash: undefined, blockNumber: undefined,
      execution: {amountUnits: '1000000', expiredUnexecuted: true}};
    const reply = path === '/api/tempo/config' ? config
      : path === '/api/session' ? {session: {address: TEST_OWNER, network: 'tempo', expiresAt: new Date(Date.now() + 3600_000).toISOString()}}
      : path === '/api/micro/policies' ? {policies: [visibleDraft]}
      : path === '/api/tempo/policies' ? {policies: hasVault ? options.duplicateVault ? [vault, otherVault] : [vault] : []}
      : path === '/api/tempo/state' ? {
        managedExecution: options.managedState === 'missing' ? undefined : {...TEST_CONFIG.managedExecution!, enabled: options.managedState !== 'disabled' && !(options.managedState === 'fresh-disabled' && stateRead > 1), executor: options.managedState === 'mismatched' ? TEST_OWNER : TEST_CONFIG.executor},
        state: options.active ? {owner: TEST_OWNER, token: TEST_POLICY.token, approved: !options.revoked, revoked: !!options.revoked,
          balance: stateRead === 1 && options.delayedFirstState ? '5000000' : '4000000', spentToday: '1000000', totalSpent: '1000000'} : null,
        operations: options.expiredActivity ? [expired] : options.activity || options.mpp ? [payment] : [], pendingInputs: [],
        executionPolicy: options.bindingMissing ? undefined : {source: presentedSource, sourceHash: hash(presentedSource), bindingJson,
          requirementsDigest: vault.requirementsDigest, semanticRequired: true},
      } : null;
    if (reply) {await route.fulfill({json: reply}); return;}
    if (route.request().method() === 'GET' || path === '/api/micro/runs') {await route.fulfill({status: 404, json: {error: 'Not found'}}); return;}
    mutations.push(path); await route.fulfill({status: 500, json: {error: 'Unexpected mutation in no-send test'}});
  });
  await page.goto('/?native=1&chain=tempo', {waitUntil: 'domcontentloaded'});
  await page.getByRole('navigation', {name: 'Policies'}).getByRole('button', {name: /Research purchases/}).first().click();
  return mutations;
}
const walletCalls = (page: Page) => page.evaluate(() => (window as unknown as {__tempoWalletCalls: number}).__tempoWalletCalls);

async function retainOriginal(page: Page, terminal = false, method: 'fund' | 'approve_deploy' = 'fund') {
  const record = {version: 1, owner: TEST_OWNER, chainId: TEST_CONFIG.chainId, policyId: TEST_POLICY.id, id: 'original-prepare-1', method, options: {amount: '1'},
    phase: terminal ? 'observed' : 'preparing', ...(terminal ? {transactionHash: TEST_HASH,
      operation: {id: 'original-prepare-1', policyId: TEST_POLICY.id, method, status: 'settled', transactionHash: TEST_HASH, blockNumber: '7'}} : {})};
  await page.evaluate(async record => {
    const opened = indexedDB.open('allowit-tempo-v1', 1); opened.onupgradeneeded = () => opened.result.createObjectStore('requests');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error);});
    const scope = `${record.chainId}.${record.owner.toLowerCase()}.${record.policyId}`;
    const tx = db.transaction('requests', 'readwrite', {durability: 'strict'});
    tx.objectStore('requests').put(record, `${scope}:request:${record.id}`); tx.objectStore('requests').put(record, `${scope}:spending:latest`);
    await new Promise<void>((resolve, reject) => {tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);}); db.close();
  }, record);
  return record;
}

test('Tempo prepares funding from the reviewed revision and shows final ceilings before any signature', async ({page}, info) => {
  const sent: unknown[] = [], errors: string[] = [], consoleErrors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (message.type() === 'error' && !message.text().includes('404 (Not Found)')) consoleErrors.push(message.text());});
  const mutations = await workspace(page, false, {generate: true, onGenerate: input => sent.push(input)});
  await page.getByLabel('Amount to fund').fill('10');
  await page.getByRole('button', {name: 'Review and sign', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Review funding'});
  await expect(page).toHaveTitle('Research purchases – Allowit'); await expect(page).toHaveURL(/\/?\?native=1&chain=tempo/);
  await expect(dialog).toBeVisible();
  expect(sent).toEqual([{network: TEST_CONFIG.network, executionPolicyId: draft.id, expectedRevision: 1, expectedSourceHash: sourceHash, totalLimit: '10'}]);
  await expect(dialog).toContainText('Daily limit'); await expect(dialog).toContainText('Per payment');
  await expect(dialog).toContainText('two transaction signatures');
  await expect(dialog.getByRole('button', {name: 'Approve in wallet', exact: true})).toBeDisabled();
  expect(mutations).toEqual([]); expect(errors).toEqual([]); expect(consoleErrors).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as {__tempoWalletSends: number}).__tempoWalletSends)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.ALLOWIT_UX_EVIDENCE_DIR) {await mkdir(process.env.ALLOWIT_UX_EVIDENCE_DIR, {recursive: true}); await page.screenshot({path: join(process.env.ALLOWIT_UX_EVIDENCE_DIR, `tempo-funding-${info.project.name}.png`)});}
  await dialog.getByLabel(/I authorize these transactions on Tempo/).check();
  const confirm = dialog.getByRole('button', {name: 'Approve in wallet', exact: true}); await confirm.scrollIntoViewIfNeeded(); await expect(confirm).toBeVisible(); await expect(confirm).toBeEnabled();
  if (process.env.ALLOWIT_UX_EVIDENCE_DIR) await page.screenshot({path: join(process.env.ALLOWIT_UX_EVIDENCE_DIR, `tempo-funding-actions-${info.project.name}.png`)});
  expect(await page.evaluate(() => (window as unknown as {__tempoWalletSends: number}).__tempoWalletSends)).toBe(0);
});

for (const managedConfig of ['missing', 'disabled', 'mismatched'] as const) test('Managed Tempo deployment ' + managedConfig + ' blocks new funding without signing', async ({page}) => {
  const mutations = await workspace(page, false, {managedConfig});
  await expect(page.locator('#p-approve').locator('..').locator('.native-setup-blockers')).toContainText('Managed payments are unavailable');
  await expect(page.getByRole('button', {name: 'Review and sign', exact: true})).toBeDisabled();
  expect(mutations).toEqual([]); expect(await walletCalls(page)).toBe(0);
});
for (const managedState of ['missing', 'disabled', 'mismatched'] as const) test('Managed Tempo policy readiness ' + managedState + ' blocks agent access and retains owner recovery', async ({page}) => {
  const mutations = await workspace(page, true, {active: true, managedState});
  await expect(page.locator('#p-handoff').locator('..')).toContainText('Managed payments are unavailable');
  await expect(page.getByRole('button', {name: 'Export agent capability', exact: true})).toBeDisabled();
  await expect(page.getByRole('button', {name: 'Copy skill', exact: true})).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'Add funds', exact: true})).toBeDisabled();
  await expect(page.locator('.tempo-balance')).toContainText('4');
  {const dialog = await openRevoke(page); await expect(dialog.getByRole('button', {name: 'Close and return all tokens', exact: true})).toBeEnabled(); await dialog.getByText('Stop spending without returning funds', {exact: true}).click(); await expect(dialog.getByRole('button', {name: 'Revoke vault', exact: true})).toBeEnabled();}
  expect(mutations).toEqual([]); expect(await walletCalls(page)).toBe(0);
});
test('Managed Tempo fresh readiness loss blocks original funding before any signature', async ({page}) => {
  const mutations = await workspace(page, true, {active: true, managedState: 'fresh-disabled'}); await retainOriginal(page);
  await page.getByRole('button', {name: 'Check vault status', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Approve the original transaction', exact: true})).toBeDisabled();
  await expect(page.getByRole('button', {name: 'Continue revoke…', exact: true})).toBeEnabled();
  expect(mutations).toEqual([]); expect(await page.evaluate(() => (window as unknown as {__tempoWalletSends: number}).__tempoWalletSends)).toBe(0);
});
