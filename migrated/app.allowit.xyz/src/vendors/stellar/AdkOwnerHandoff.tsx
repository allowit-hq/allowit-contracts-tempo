import {useEffect, useMemo, useRef, useState, type FormEvent} from 'react';
import {admitPortableBuild} from '@allowit/engine/policy/portable-admission';
import {adkAgentPrompt, adkParamLines, parseAdkOwnerLink} from '@allowit/stellar/adk-owner-link';
import {adkOwnerKey, deployAdkOwnerDraft, readAdkOwnerJournal, type AdkOwnerHost} from '@allowit/stellar/adk-owner-workflow';
import {request} from '../../api';
import type {MicroController} from '../../micro/micro-contracts';
import PolicyCode from '../../policy/PolicyCode';
import SpendingSetupHead from '../../policy/SpendingSetup';
import {Spinner} from '../../shell/Shell';
import {verifyStellarInstallation} from './stellar-wallet';
import {ReviewDialog} from './StellarBrowserReview';

const host: AdkOwnerHost = {request, verifyInstallation: verifyStellarInstallation, admitPortableBuild};

export default function AdkOwnerHandoff({c, fragment, close}: {c: MicroController; fragment: string; close: () => void}) {
  const link = useMemo(() => {
    try {return parseAdkOwnerLink(fragment);}
    catch {return null;}
  }, [fragment]);
  const [agent, setAgent] = useState('');
  const [amount, setAmount] = useState('');
  const [locked, setLocked] = useState(false);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof deployAdkOwnerDraft>> | null>(null);
  const [copied, setCopied] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  const session = c.auth.session;
  const identity = `${session?.network ?? ''}:${session?.address ?? ''}:${c.network}:${fragment}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false;};
  }, []);
  useEffect(() => {
    setAgent('');
    setAmount('');
    setError('');
    setLocked(false);
    setResult(null);
    setCopied(false);
    if (!link || !session?.address) return;
    try {
      const record = readAdkOwnerJournal(adkOwnerKey(session.address, link.proposal));
      if (!record) return;
      setAgent(record.agent);
      setAmount(record.amount);
      setLocked(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The saved wallet setup could not be read.');
      setLocked(true);
    }
  }, [link, session?.address]);

  async function deploy(event: FormEvent) {
    event.preventDefault();
    if (busy.current || !link || session?.network !== 'stellar' || c.network !== 'stellar:testnet') return;
    busy.current = true;
    const current = () => mounted.current && identityRef.current === identity;
    setError('');
    setWorking('Preparing the reviewed policy…');
    try {
      const deployed = await deployAdkOwnerDraft({
        host, proposal: link.proposal, session, agent: agent.trim(), amount: amount.trim(), current,
        onStep: step => {if (current()) setWorking(step);},
      });
      if (!current()) return;
      setResult(deployed);
      void c.refresh().then(() => {if (current()) c.select(deployed.policyId);}).catch(() => {});
    } catch (error) {
      if (current()) {
        setError(error instanceof Error ? error.message : 'The wallet setup could not be completed.');
        try {setLocked(!!readAdkOwnerJournal(adkOwnerKey(session.address, link.proposal)));}
        catch {setLocked(true);}
      }
    } finally {
      busy.current = false;
      if (mounted.current) setWorking('');
    }
  }
  const prompt = result && link
    ? adkAgentPrompt(link.workPrompt, location.origin, result.policyId, result.wallet, agent.trim())
    : '';
  const copy = async () => {
    try {await navigator.clipboard.writeText(prompt); setCopied(true);}
    catch {setError('Copy failed. Select and copy the prompt.');}
  };
  const download = () => {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([result.publicProfile], {type: 'application/json'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'allowit-stellar-profile.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return <ReviewDialog id="adk-owner-review-title" title="Review and sign" busy={!!working} close={close}>
    {!link ? <p className="field-error" role="alert">The agent policy link is invalid.</p> : null}
    {link ? <div className="stack contract-funding">
      <SpendingSetupHead intro={link.proposal.title} network="Stellar Testnet" currentStep={result ? 2 : 1}/>
      {result ? <>
        <p className="small" role="status">Your wallet is funded and the policy is active.</p>
        <label className="field">Agent prompt<textarea className="mono harness-textarea" readOnly value={prompt} onFocus={event => event.currentTarget.select()}/></label>
        <div className="btn-row"><button className="btn" type="button" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy prompt'}</button>
          <button className="btn" type="button" onClick={download}>Download public profile</button></div>
      </> : <>
        <p className="small">{link.proposal.explanation}</p>
        <details className="native-details"><summary>Setup details and policy binding</summary>
          <dl className="facts"><div><dt>Revision</dt><dd>{link.proposal.revision}</dd></div>
            <div><dt>Source hash</dt><dd className="mono tempo-wrap">{link.proposal.sourceHash}</dd></div>
            {adkParamLines(link.proposal.params).map(line => <div key={line.key}><dt>{line.label}</dt><dd className="mono tempo-wrap">{line.value}</dd></div>)}</dl>
          <PolicyCode code={link.proposal.code} label="Policy source"/>
        </details>
        <label className="field">Agent prompt<textarea className="mono harness-textarea" readOnly value={link.workPrompt}/></label>
        <form className="stack" onSubmit={event => void deploy(event)}>
          <label className="field">Agent public key<input value={agent} maxLength={56} required spellCheck={false} autoComplete="off" disabled={locked || !!working} onChange={event => setAgent(event.target.value)}/></label>
          <label className="field">Funding amount (XLM)<input value={amount} inputMode="decimal" required disabled={locked || !!working} onChange={event => setAmount(event.target.value)}/></label>
          <p className="small muted">Review the deployment and funding transactions in your wallet before signing.</p>
          <div className="btn-row"><button type="submit" className="btn btn-primary" disabled={!!working || !agent || !amount || c.network !== 'stellar:testnet'}>{working ? <Spinner/> : null}{locked ? 'Resume deployment and funding' : 'Deploy and fund'}</button></div>
        </form>
        {working ? <p className="small" role="status">{working}</p> : null}
      </>}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
    </div> : null}
  </ReviewDialog>;
}
