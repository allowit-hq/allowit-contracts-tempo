import {useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {request} from '../../api';
import type {Session} from '../../contracts';
import type {MicroController, MicroPolicy} from '../../micro/micro-contracts';
import PolicyCode from '../../policy/PolicyCode';
import SpendingSetupHead from '../../policy/SpendingSetup';
import {Spinner} from '../../shell/Shell';
import AccountIdentity from '../../wallet/AccountIdentity';
import {chainExplorerUrl} from '../../wallet/chain-explorer';
import {matchStellarApproval, publicStellarBundle, parseStellarApprovalIntent, STELLAR_APPROVAL_FRAGMENT, type StellarApprovalIntent} from '@allowit/engine/stellar/approval-handoff';
import {checkStellarEngineIdentity, checkUnsignedStellarOwnerWindow, durableStellarOwnerProof, heldStellarOwnerProof, keptStellarOwnerRecord, observeStellarOwnerRecord, parseStellarOwnerIntent, readOwnerRecord, retainStellarOwnerProof, saveOwnerRecord, submitSavedStellarOwner, verifyFreshStellarOwner, withStellarOwnerLock, type OwnerRecord, type StellarOwnerIntent} from './owner-handoff';
import {signStellarTransaction, stellarAccountKey, verifyStellarInstallation} from './stellar-wallet';

const NETWORK = 'stellar:testnet';
const APPROVAL_JOURNAL = 'allowit.stellar.approval.v1';
type Context = {session: Session | null | undefined; network: string; fragment?:string};

const message = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;
/** Exact decimal XLM from integer stroops. */
const xlm = (stroops: number) => {
  const fraction = String(stroops % 10_000_000).padStart(7, '0').replace(/0+$/, '');
  return `${Math.floor(stroops / 10_000_000)}${fraction ? '.' + fraction : ''} XLM`;
};
const contextError = ({session, network}: Context, owner: string) =>
  session?.network !== 'stellar' || session.address !== owner ? `Sign in with the Stellar owner account ${owner}.`
    : network !== NETWORK ? 'Select Stellar Testnet to continue.' : '';

/** Shared modal shell: native focus trap, Escape and Close are held while a wallet or chain step is running. */
export function ReviewDialog({id, title, busy, close, children}: {id: string; title: string; busy: boolean; close: () => void; children: ReactNode}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const held = useRef(busy);
  held.current = busy;
  useEffect(() => {
    mounted.current = true;
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => {mounted.current = false; element?.close();};
  }, []);
  const closed = () => {
    if (!mounted.current || dialog.current?.open) return;
    // A forced close request during a wallet step reopens the dialog; the step keeps its own guards.
    if (held.current) {dialog.current?.showModal(); return;}
    close();
  };
  return <dialog className="request-review" ref={dialog} aria-labelledby={id} aria-modal="true" onCancel={event => {if (held.current) event.preventDefault();}} onClose={closed}>
    <div className="request-review-head"><h2 id={id}>{title}</h2><button type="button" className="btn btn-sm" disabled={busy} onClick={() => dialog.current?.close()}>Close</button></div>
    {children}
  </dialog>;
}

function Errors({errors}: {errors: string[]}) {
  return <>{errors.filter((e, i, all) => e && all.indexOf(e) === i).map(e => <p className="field-error" role="alert" key={e}>{e}</p>)}</>;
}

function SwitchWallet({c, owner}: {c: MicroController; owner: string}) {
  const session = c.auth.session;
  if (session?.network === 'stellar' && session.address === owner) return null;
  return <button type="button" className="btn" disabled={!!c.auth.busy} onClick={() => void c.auth.signOut().catch(() => {})}>Switch wallet</button>;
}

/** Persist the result of an exact receipt lookup. A saved label alone is not chain evidence. */
function persist(next: OwnerRecord): OwnerRecord {
  saveOwnerRecord(next);
  return next;
}
/** True while a signed proof is held only in memory because this browser could not keep it in the journal. */
const unsavedProof = (intent: StellarOwnerIntent, record: OwnerRecord | null) => {
  if (!record?.signedXdr) return false;
  try {return readOwnerRecord(intent)?.signedXdr !== record.signedXdr;} catch {return true;}
};

/** The configured service must name the same engine signer before any unsigned signature or saved replay. */
async function trustEngine(intent: StellarOwnerIntent, current: () => boolean, changed: string): Promise<void> {
  const config = await request<unknown>('native/config?network=stellar:testnet', undefined, {expectedOwner: 'stellar:' + intent.owner});
  if (!current()) throw new Error(changed);
  checkStellarEngineIdentity(intent, config);
}

function OwnerSetup({c, fragment, close}: {c: MicroController; fragment: string; close: () => void}) {
  const parsed = useMemo(() => {
    try {return {intent: parseStellarOwnerIntent(fragment), error: ''};}
    catch (error) {return {intent: null, error: message(error, 'The owner signing link is invalid.')};}
  }, [fragment]);
  const intent = parsed.intent;
  const session = c.auth.session;
  const live = useRef<Context>({session, network: c.network,fragment});
  live.current = {session, network: c.network,fragment};
  const mounted = useRef(true);
  const generation = useRef(0);
  const locked = useRef(false);
  // A verified proof the wallet returned. It survives a failed browser save, the page keeps a copy past this component
  // until it is saved, and it is never replaced by a new signature.
  const held = useRef<OwnerRecord | null>(null);
  const [view, setView] = useState<{record: OwnerRecord | null; checking: boolean; trusted: boolean; error: string; unsaved: boolean}>({record: null, checking: true, trusted: false, error: '', unsaved: false});
  const [busy, setBusy] = useState<'' | 'sign' | 'check' | 'retry'>('');
  const [consent, setConsent] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false; generation.current++;};
  }, []);
  useEffect(() => {
    const epoch = ++generation.current;
    const fresh = () => mounted.current && generation.current === epoch;
    setConsent(false);
    setView({record: null, checking: !!intent, trusted: false, error: '', unsaved: false});
    if (!intent) return;
    void (async () => {
      let record: OwnerRecord | null = null;
      try {
        record = heldStellarOwnerProof(intent, held.current) ?? readOwnerRecord(intent);
        // Opening a link only observes a saved proof under the owner lock. It never signs or broadcasts.
        if (record?.signedXdr) {
          record = await observeStellarOwnerRecord(intent, held.current);
          if (fresh()) setView({record, checking: false, trusted: false, error: '', unsaved: unsavedProof(intent, record)});
          return;
        }
        const blocked = contextError(live.current, intent.owner);
        if (blocked) throw new Error(blocked);
        checkUnsignedStellarOwnerWindow(intent);
        const current = () => fresh() && live.current.fragment===fragment && !contextError(live.current, intent.owner);
        await trustEngine(intent, current, 'The owner, network or link changed. Nothing was signed.');
        checkUnsignedStellarOwnerWindow(intent);
        if (fresh()) setView({record, checking: false, trusted: true, error: '', unsaved: false});
      } catch (error) {
        const kept = keptStellarOwnerRecord(intent, held.current) ?? record;
        if (fresh()) setView({record: kept, checking: false, trusted: false, error: message(error, 'The native setup could not be checked.'), unsaved: unsavedProof(intent, kept)});
      }
    })();
  }, [intent, session?.address, session?.network, c.network]);

  const run = async (kind: 'sign' | 'check' | 'retry', work: (fresh: () => boolean, current: () => boolean) => Promise<OwnerRecord | null>, fallback: string) => {
    if (!intent || locked.current) return;
    const epoch = generation.current;
    const fresh = () => mounted.current && generation.current === epoch;
    const current = () => fresh() && live.current.fragment===fragment && !contextError(live.current, intent.owner);
    locked.current = true;
    setBusy(kind);
    setView(v => ({...v, error: ''}));
    try {
      const record = await work(fresh, current);
      if (fresh() && record) {const unsaved = unsavedProof(intent, record); setView(v => ({...v, record, unsaved})); setConsent(false);}
    } catch (error) {
      // A known signed proof is never replaced by an unsigned or unreadable journal entry.
      const record = keptStellarOwnerRecord(intent, held.current);
      if (fresh()) setView(v => {
        const next = record?.signedXdr || !v.record?.signedXdr ? record ?? v.record : v.record;
        return {...v, record: next, unsaved: unsavedProof(intent, next), error: message(error, fallback)};
      });
    } finally {locked.current = false; if (mounted.current) setBusy('');}
  };

  const sign = () => {
    if (!intent || view.checking || !view.trusted || !consent || view.record?.signedXdr) return;
    const changed = 'The owner, network or link changed. Nothing was signed.';
    return run('sign', async (fresh, current) => {
      if (!current()) throw new Error(changed);
      return withStellarOwnerLock(intent, async () => {
        if (!current()) throw new Error(changed);
        // A saved or kept signature is recovered only. This request is never signed twice.
        const prior = heldStellarOwnerProof(intent, held.current);
        if (prior) return prior;
        await trustEngine(intent, current, changed);
        await verifyFreshStellarOwner(intent);
        if (!current()) throw new Error(changed);
        // The journal entry is written only after every check, immediately before the wallet prompt.
        checkUnsignedStellarOwnerWindow(intent);
        saveOwnerRecord({intent, status: 'unsigned'});
        // The proof scope stays this original intent even if the view, session or network changes later.
        const kept: {proof?: OwnerRecord} = {};
        const retain = (signedXdr: string) => {
          kept.proof = retainStellarOwnerProof(intent, signedXdr, proof => {
            held.current = proof;
            if (fresh()) setView(v => ({...v, record: proof, unsaved: true}));
          });
          if (fresh()) setView(v => ({...v, unsaved: false}));
        };
        try {await signStellarTransaction(intent.transactionXdr, intent.owner, NETWORK, retain);}
        catch (error) {
          if (kept.proof) throw new Error('The signed transaction is saved. Wallet checks did not complete, so nothing was sent.');
          throw error;
        }
        const proof = kept.proof;
        if (!proof) throw new Error('The wallet did not return the signed setup. Nothing was sent.');
        if (!current()) throw new Error('The owner, network or link changed after signing. The signed transaction is saved and was not sent.');
        return persist(await submitSavedStellarOwner(proof));
      });
    }, 'The setup could not be completed. Any signed transaction stays saved.');
  };

  const retry = () => {
    if (!intent || view.checking || view.record?.status !== 'unknown' || !view.record.signedXdr) return;
    const changed = 'The owner, network or link changed. The saved transaction was not sent.';
    return run('retry', async (_fresh, current) => {
      if (!current()) throw new Error(changed);
      return withStellarOwnerLock(intent, async () => {
        if (!current()) throw new Error(changed);
        // The same kept proof is saved durably before any send. The wallet is never asked again.
        const saved = durableStellarOwnerProof(intent, held.current);
        await trustEngine(intent, current, changed);
        if (!current()) throw new Error(changed);
        // A fresh receipt lookup runs first; only an unknown result sends the exact saved bytes.
        return persist(await submitSavedStellarOwner(saved));
      });
    }, 'The saved transaction could not be sent. It stays saved.');
  };

  const check = () => {
    if (!intent || view.checking || !view.record?.signedXdr) return;
    // Read-only: the lookup and its save run under the owner lock, so an older lookup cannot overwrite a newer one.
    return run('check', async () => observeStellarOwnerRecord(intent, held.current), 'Stellar status is unavailable. The signed transaction stays saved.');
  };

  const record = view.record;
  const signed = !!record?.signedXdr;
  const status = record?.status;
  const blocked = intent ? contextError({session, network: c.network}, intent.owner) : '';
  const txUrl = intent && signed && !view.unsaved ? chainExplorerUrl('tx', intent.transactionHash, NETWORK) : null;
  const errors = [parsed.error, view.checking ? '' : blocked, view.error];
  // An unsaved signed proof holds Close and Escape, like a running step.
  return <ReviewDialog id="stellar-setup-review-title" title="Review and sign" busy={!!busy || view.unsaved} close={close}>
    <Errors errors={errors}/>
    {intent ? <SwitchWallet c={c} owner={intent.owner}/> : null}
    {intent ? <div className="stack contract-funding">
      <SpendingSetupHead intro="Review these account changes before signing them in your wallet." network="Stellar Testnet" currentStep={status === 'confirmed' ? 2 : 1}/>
      <dl className="facts">
        <div><dt>Owner account</dt><dd><AccountIdentity address={intent.owner} network={NETWORK} label="owner account"/></dd></div>
        <div><dt>Agent signer</dt><dd><AccountIdentity address={intent.agent} network={NETWORK} label="agent signer"/></dd></div>
        <div><dt>Engine signer</dt><dd><AccountIdentity address={intent.engine} network={NETWORK} label="engine signer"/></dd></div>
        <div><dt>Network fee</dt><dd>{xlm(intent.feeStroops)}</dd></div>
        <div><dt>Setup transaction</dt><dd>{status === 'confirmed' ? 'Confirmed' : status === 'failed' ? 'Failed' : view.unsaved ? 'Signed, not saved' : signed ? 'Signed, not confirmed' : 'Not signed'}</dd></div>
      </dl>
      <p className="small">One transaction changes your funded account three times: it adds the agent and the engine as signers, then sets thresholds. You keep administration. Together, the agent and engine can send payments and other low- or medium-threshold operations from this account. Only you can change signers or thresholds.</p>
      <p className="small muted">These signatures do not enforce policy rules on chain. No payment is made. The network fee applies, and each added signer raises your account’s minimum XLM reserve.</p>
      <details className="native-details"><summary>Setup details and transaction</summary><dl className="facts">
        <div><dt>Request</dt><dd className="mono tempo-wrap">{intent.requestId}</dd></div>
        <div><dt>Operation 1</dt><dd>Add agent signer, weight 1</dd></div>
        <div><dt>Operation 2</dt><dd>Add engine signer, weight 1</dd></div>
        <div><dt>Operation 3</dt><dd>Owner weight 3; thresholds low 2, medium 2, high 3</dd></div>
        <div><dt>Account sequence</dt><dd className="mono">{intent.sequence}</dd></div>
        <div><dt>Sign before</dt><dd>{new Date(intent.expiresAt * 1000).toLocaleString(undefined,{timeZoneName:'short'})}</dd></div>
        <div><dt>Transaction hash</dt><dd className="mono tempo-wrap">{intent.transactionHash}</dd></div>
        <div><dt>Intent</dt><dd className="mono tempo-wrap">{intent.intentDigest}</dd></div>
        <div><dt>Unsigned transaction</dt><dd className="mono tempo-wrap">{intent.transactionXdr}</dd></div>
      </dl></details>
      {view.checking ? <p className="small muted" role="status">Checking setup…</p> : null}
      {signed && !view.checking ? <p className="small" role="status">{status === 'confirmed' ? `Setup confirmed in ledger ${record?.ledger}.` : status === 'failed' ? `The setup transaction failed in ledger ${record?.ledger}. Prepare a new request in the CLI.` : view.unsaved ? 'Signed, not saved and not sent. Keep this page open, then retry.' : 'Signed and saved, not confirmed yet. Check its status before you retry.'}{txUrl ? <> <a href={txUrl} target="_blank" rel="noreferrer noopener">View transaction</a></> : null}</p> : null}
      {signed ? <div className="btn-row">
        <button type="button" className="btn" disabled={!!busy || view.checking} onClick={() => void check()}>{busy === 'check' ? <Spinner/> : null}Check transaction status</button>
        {status === 'unknown' ? <button type="button" className="btn" disabled={!!busy || view.checking || !!blocked} onClick={() => void retry()}>{busy === 'retry' ? <Spinner/> : null}{view.unsaved?'Retry signed transaction':'Retry saved transaction'}</button> : null}
      </div> : <>
        <label className="tempo-consent"><input type="checkbox" checked={consent} disabled={!!busy || view.checking || !view.trusted} onChange={event => setConsent(event.target.checked)}/>I authorize these three changes to my Stellar Testnet account.</label>
        <div className="btn-row"><button type="button" className="btn btn-primary" disabled={!!busy || view.checking || !view.trusted || !consent || !!blocked || !!c.busy} onClick={() => void sign()}>{busy === 'sign' ? <Spinner/> : null}{busy === 'sign' ? 'Signing…' : 'Sign setup transaction'}</button></div>
      </>}
    </div> : null}
  </ReviewDialog>;
}

/** Binds one request ID to one approval digest in this browser. A changed approval under the same ID is rejected. */
function bindApproval(intent: StellarApprovalIntent): void {
  const key = `${APPROVAL_JOURNAL}:${intent.network}:${intent.owner}:${intent.requestId}`;
  const prior = localStorage.getItem(key);
  if (prior !== null && prior !== intent.intentDigest) throw new Error('This request ID already belongs to another approval. Nothing was signed.');
  if (prior === null) {
    localStorage.setItem(key, intent.intentDigest);
    if (localStorage.getItem(key) !== intent.intentDigest) throw new Error('The approval could not be saved in this browser. Nothing was signed.');
  }
}


function PolicyApproval({c, fragment, close}: {c: MicroController; fragment: string; close: () => void}) {
  const parsed = useMemo(() => {
    try {return {intent: parseStellarApprovalIntent(fragment), error: ''};}
    catch (error) {return {intent: null, error: message(error, 'The approval link is invalid.')};}
  }, [fragment]);
  const intent = parsed.intent;
  const session = c.auth.session;
  const latest = useRef(c);
  latest.current = c;
  const live = useRef<Context>({session, network: c.network,fragment});
  live.current = {session, network: c.network,fragment};
  const mounted = useRef(true);
  const generation = useRef(0);
  const locked = useRef(false);
  const [busy, setBusy] = useState<'' | 'approve' | 'export'>('');
  const [consent, setConsent] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false; generation.current++;};
  }, []);
  useEffect(() => {
    generation.current++;
    setConsent(false); setApproved(false); setError('');
  }, [intent, session?.address, session?.network, c.network]);
  const loading = !!intent && (c.loading || c.auth.loading || c.policiesLoaded === false);
  const stored = intent ? c.policies.find(p => p.id === intent.policyId) : undefined;
  const blocked = intent ? contextError({session, network: c.network}, intent.owner) : '';
  const matched = useMemo(() => {
    if (!intent || loading || blocked) return {policy: null, error: ''};
    // Only the owner's stored policy can be approved. The link source never creates or replaces one.
    try {return {policy: matchStellarApproval(intent, stored, session?.address ?? '', c.network), error: ''};}
    catch (e) {return {policy: null, error: message(e, 'This link differs from the stored policy. Nothing was signed.')};}
  }, [intent, loading, blocked, stored, session?.address, c.network]);

  const run = async (kind: 'approve' | 'export', work: (current: () => boolean, policy: MicroPolicy) => Promise<void>, fallback: string) => {
    if (!intent || locked.current) return;
    const epoch = generation.current;
    const fresh = () => mounted.current && generation.current === epoch;
    const current = () => {
      if(!fresh()||live.current.fragment!==fragment||contextError(live.current,intent.owner))return false;
      try{matchStellarApproval(intent,latest.current.policies.find(p=>p.id===intent.policyId),live.current.session?.address??'',live.current.network);return true;}catch{return false;}
    };
    locked.current = true;
    setBusy(kind);
    setError('');
    try {
      if (!current()) throw new Error('The owner, network or link changed. Nothing was signed.');
      const policy = matchStellarApproval(intent, latest.current.policies.find(p => p.id === intent.policyId), live.current.session?.address ?? '', live.current.network);
      await work(current, policy);
    } catch (e) {
      if (fresh()) setError(message(e, fallback));
    } finally {locked.current = false; if (mounted.current) setBusy('');}
  };

  const approve = () => {
    if (!consent || !matched.policy) return;
    return run('approve', async (current, policy) => {
      if(!navigator.locks)throw new Error('This browser cannot safely lock policy approval. Use a browser with Web Locks support.');
      await navigator.locks.request(`allowit.stellar.approval:${intent!.network}:${intent!.owner}:${intent!.requestId}`,async()=>{
        if(!current())throw new Error('The owner, network or policy changed. Nothing was signed.');
        bindApproval(intent!);
        await verifyStellarInstallation(policy, live.current.session,current);
      });
      if (!current()) throw new Error('The owner, network or link changed. Open this link again to check the approval.');
      await latest.current.refresh();
      if (current()) {setApproved(true); setConsent(false);}
    }, 'The policy could not be approved. Nothing was activated.');
  };

  const exportBundle = () => {
    if (!approved || !matched.policy) return;
    return run('export', async (current, policy) => {
      const bundle = await request<unknown>('native/export', {policyId: policy.id}, {expectedOwner: 'stellar:' + intent!.owner});
      if (!current()) throw new Error('The owner, network or link changed. Nothing was saved.');
      // The engine signer must match the independently configured same-origin service.
      const service = await request<unknown>('native/config?network=stellar:testnet', undefined, {expectedOwner: 'stellar:' + intent!.owner});
      if (!current()) throw new Error('The owner, network or link changed. Nothing was saved.');
      const file = new Blob([JSON.stringify(publicStellarBundle(bundle, policy, intent!.owner, service), null, 2) + '\n'], {type: 'application/json'});
      const url = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = url;
      link.download = `allowit-${policy.id.replace(/[^A-Za-z0-9._-]/g, '_')}-agent.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }, 'The public agent bundle could not be exported.');
  };

  const policy = matched.policy;
  const binding = intent?.binding;
  return <ReviewDialog id="stellar-approval-review-title" title="Approve policy" busy={!!busy} close={close}>
    <Errors errors={[parsed.error, loading ? '' : blocked, matched.error, error]}/>
    {intent ? <SwitchWallet c={c} owner={intent.owner}/> : null}
    {intent && binding ? <div className="stack contract-funding">
      <SpendingSetupHead intro="Review this policy before approving it for your installed wallet." network="Stellar Testnet" currentStep={approved ? 2 : 1}/>
      <dl className="facts">
        <div><dt>Policy</dt><dd>{policy?.title ?? intent.policyId}</dd></div>
        <div><dt>Revision</dt><dd>{intent.revision}</dd></div>
        <div><dt>Wallet</dt><dd><AccountIdentity address={binding.wallet} network={NETWORK} label="wallet account"/></dd></div>
        <div><dt>Owner account</dt><dd><AccountIdentity address={intent.owner} network={NETWORK} label="owner account"/></dd></div>
        <div><dt>Asset</dt><dd>{binding.assetSymbol} ({binding.assetIssuer === null ? 'native' : 'issued'})</dd></div>
        {binding.assetIssuer !== null ? <div><dt>Asset issuer</dt><dd><AccountIdentity address={binding.assetIssuer} network={NETWORK} label="asset issuer"/></dd></div> : null}
        <div><dt>Network fee limit</dt><dd>{xlm(binding.maxFeeStroops)}</dd></div>
      </dl>
      <p className="small">Approving moves no funds. Your signed message approves this exact policy for the installed wallet.</p>
      <p className="small muted">On chain, native signatures enforce only the account thresholds, not the policy rules.</p>
      <details className="native-details"><summary>Approval details and policy binding</summary><dl className="facts">
        <div><dt>Request</dt><dd className="mono tempo-wrap">{intent.requestId}</dd></div>
        <div><dt>Policy ID</dt><dd className="mono tempo-wrap">{intent.policyId}</dd></div>
        <div><dt>Source hash</dt><dd className="mono tempo-wrap">{intent.sourceHash}</dd></div>
        <div><dt>IR hash</dt><dd className="mono tempo-wrap">{intent.irHash}</dd></div>
        <div><dt>Policy instance</dt><dd className="mono tempo-wrap">{binding.policyInstance}</dd></div>
        <div><dt>Module digest</dt><dd className="mono tempo-wrap">{binding.moduleDigest}</dd></div>
        <div><dt>Asset contract</dt><dd><AccountIdentity address={binding.asset} network={NETWORK} kind="contract" label="asset contract"/></dd></div>
        <div><dt>Deployment</dt><dd className="mono tempo-wrap">{binding.deploymentId ?? 'None'}</dd></div>
        <div><dt>Intent</dt><dd className="mono tempo-wrap">{intent.intentDigest}</dd></div>
      </dl><PolicyCode code={intent.source} label="Policy source"/></details>
      {loading ? <p className="small muted" role="status">Loading policy…</p> : null}
      {approved ? <>
        <p className="small" role="status">Policy approved for this wallet.</p>
        <div className="btn-row"><button type="button" className="btn btn-primary" disabled={!!busy || !!blocked || !policy} onClick={() => void exportBundle()}>{busy === 'export' ? <Spinner/> : null}Export public agent bundle</button></div>
        <p className="small muted">The file holds public configuration only. It contains no private keys.</p>
      </> : <>
        <label className="tempo-consent"><input type="checkbox" checked={consent} disabled={!!busy || !policy} onChange={event => setConsent(event.target.checked)}/>I approve this exact policy for the installed wallet.</label>
        <div className="btn-row"><button type="button" className="btn btn-primary" disabled={!!busy || !policy || !consent || !!blocked || !!c.busy} onClick={() => void approve()}>{busy === 'approve' ? <Spinner/> : null}{busy === 'approve' ? 'Approving…' : 'Approve policy and verify wallet'}</button></div>
      </>}
    </div> : null}
  </ReviewDialog>;
}

/** Native Stellar owner links: account setup signing and existing-policy source approval. */
export default function StellarBrowserReview({c, fragment, close}: {c: MicroController; fragment: string; close: () => void}) {
  return fragment.startsWith(STELLAR_APPROVAL_FRAGMENT)
    ? <PolicyApproval c={c} fragment={fragment} close={close}/>
    : <OwnerSetup c={c} fragment={fragment} close={close}/>;
}
