import {useEffect, useId, useRef, type ReactNode} from 'react';
import {Check, ChevronRight, CircleAlert, CircleCheck, ExternalLink, Info, Undo2, X} from 'lucide-react';
import {Spinner} from '../shell/Shell';
import './revoke-policies.css';
import '../native-vault/native-revoke-dialog.css';

/** One owner action started from the revoke dialog. `ok` is null while it runs. */
export interface RevokeRun {method: 'close' | 'withdraw' | 'revoke'; amount: string | null; before: string | null; ok: boolean | null; error: string; /** Operations that existed before this action, and those already finished then: an older result never stands in for it. */ priorIds: readonly string[]; priorFinal: readonly string[]}

/** What a chain's vault can say about itself. Every chain uses the same dialog; only these facts differ. */
export interface RevokeCopy {
  token: string;
  /** Network name in progress and pending results, e.g. Devnet or Tempo Testnet. */
  network: string;
  /** What "Close and return everything" does on this chain. */
  returnText: string;
  /** What remains after spending stops without a return. */
  stopText: string;
  /** Result after everything was returned. */
  returnedText: string;
  /** How funds left after a stop come back, e.g. "until you withdraw it or close the vault". */
  keptUntil: string;
  stopLabel: string;
}

/** The result of the action that just ran, read from the chain's own records. */
export interface RevokeOutcome {final: boolean; expired: boolean; link?: string}

const STEPS = (network: string) => [
  {label: 'Preparing the transaction', phases: ['returning', 'withdrawing', 'revoke', 'preparing']},
  {label: 'Confirm in your wallet', phases: ['signing']},
  {label: `Waiting for ${network} to finalize`, phases: ['sending']},
];

interface Props {
  open: boolean;
  /** The dialog was opened: the chain clears its previous run. */
  onOpen: () => void;
  /** The dialog element closed; focus returns to whatever opened it. */
  onClosed: () => void;
  /** Escape, the close button or a click outside; ignored while an action runs. */
  requestClose: () => void;
  copy: RevokeCopy;
  busy: boolean;
  /** The chain's current phase, which drives the progress steps. */
  phase: string;
  reading: boolean;
  /** Remaining balance as a decimal, or null when it is not known. */
  balance: string | null;
  run: RevokeRun | null;
  outcome: RevokeOutcome | undefined;
  /** Nothing is left in the vault. */
  vaultGone: boolean;
  /** A chain-specific option shown before "Close and return everything", such as a partial withdrawal. */
  partial?: ReactNode;
  returnAll: {label: string; blocker?: string; disabled: boolean; spinning: boolean; run: () => void};
  /** `label` replaces the chain's usual stop label, e.g. for a retry. */
  stop: {label?: string; disabled: boolean; spinning: boolean; run: () => void};
  notice?: string;
  error?: string;
  onDone: () => void;
  onRetry: () => void;
}

/** Before revoking, shows the vault balance and the owner's ways to stop the agent and get funds back. The same dialog on every chain. */
export default function RevokeDialog({open, onOpen, onClosed, requestClose, copy, busy, phase, reading, balance, run, outcome, vaultGone, partial, returnAll, stop, notice, error, onDone, onRetry}: Props) {
  const dialog = useRef<HTMLDialogElement>(null), opener = useRef<HTMLElement | null>(null);
  const id = useId();
  useEffect(() => {
    const element = dialog.current;
    if (open && !element?.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      onOpen();
      element?.showModal();
    } else if (!open && element?.open) element.close();
  }, [open]);
  useEffect(() => () => dialog.current?.close(), []);
  const running = run?.ok === null;
  const closed = () => {
    onClosed();
    const target = opener.current;
    if (target?.isConnected && !(target as HTMLButtonElement).disabled) target.focus();
  };
  const steps = STEPS(copy.network);
  const stepIndex = Math.max(0, steps.findIndex(step => step.phases.includes(phase)));
  return <dialog ref={dialog} className="revoke-policies-dialog native-revoke-dialog" aria-labelledby={`${id}-title`}
    onClose={closed} onCancel={event => {event.preventDefault(); requestClose();}}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const r = event.currentTarget.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) requestClose();
    }}>
    <header className="native-revoke-header">
      <h2 id={`${id}-title`}>{run ? {close: 'Close and return everything', withdraw: 'Withdraw part', revoke: 'Stop agent spending'}[run.method] : 'Revoke this policy?'}</h2>
      <button type="button" className="native-revoke-close" aria-label="Close" autoFocus disabled={busy || running} onClick={requestClose}><X size={18} aria-hidden="true" /></button>
    </header>

    {running ? <div className="native-revoke-progress" role="status" aria-live="polite">
      <p className="native-revoke-progress-title">{run.method === 'close' ? `Returning ${run.before ?? 'the remaining'} ${copy.token}` : run.method === 'withdraw' ? `Withdrawing ${run.amount} ${copy.token}` : 'Stopping agent spending'}</p>
      <ol className="native-revoke-steps">
        {steps.map((step, i) => <li key={step.label} data-step={i < stepIndex ? 'done' : i === stepIndex ? 'current' : 'next'}>
          <span className="native-revoke-step-mark" aria-hidden="true">{i < stepIndex ? <Check size={13} strokeWidth={3} /> : null}</span>
          {step.label}
        </li>)}
      </ol>
      <p className="native-revoke-progress-note">Keep this window open. Nothing leaves the vault until your wallet signs.</p>
    </div> : run && run.ok !== null ? <Outcome run={run} outcome={outcome} copy={copy} balance={balance} vaultGone={vaultGone} onDone={onDone} onRetry={onRetry} /> : <>
    <div className="native-revoke-balance">
      <span className="native-revoke-label">Remaining in the vault</span>
      <strong role="status">{reading ? <><Spinner /> Reading the vault…</> : balance === null ? 'Not available' : `${balance} ${copy.token}`}</strong>
      <p><Info size={14} aria-hidden="true" />Spent funds have already reached their recipients and cannot be returned.</p>
    </div>

    {partial}

    <section className="native-revoke-option native-revoke-option-danger" aria-labelledby={`${id}-return`}>
      <div className="native-revoke-option-head">
        <span className="native-revoke-icon" aria-hidden="true"><Undo2 size={16} /></span>
        <h3 id={`${id}-return`}>Close and return everything</h3>
      </div>
      <p>{copy.returnText}</p>
      {returnAll.blocker ? <p className="native-revoke-blocker">{returnAll.blocker}</p> : null}
      <button type="button" className="btn btn-primary btn-danger native-revoke-cta" disabled={returnAll.disabled} onClick={returnAll.run}>
        {returnAll.spinning ? <Spinner /> : null}{returnAll.label}
      </button>
    </section>

    <details className="native-revoke-more">
      <summary><ChevronRight size={16} aria-hidden="true" />Stop spending without returning funds</summary>
      <div className="native-revoke-more-body">
        <p>{copy.stopText}</p>
        <button type="button" className="btn" disabled={stop.disabled} onClick={stop.run}>{stop.spinning ? <Spinner /> : null}{stop.label ?? copy.stopLabel}</button>
      </div>
    </details>

    {notice ? <p className="revoke-policies-success native-revoke-notice" role="status">{notice}</p> : null}
    {error && !run ? <p className="field-error native-revoke-notice" role="alert">{error}</p> : null}
    </>}
  </dialog>;
}

/** The result of one action: what reached the wallet and what is left, or that nothing moved and why. */
function Outcome({run, outcome, copy, balance, vaultGone, onDone, onRetry}: {run: RevokeRun; outcome?: RevokeOutcome; copy: RevokeCopy; balance: string | null; vaultGone: boolean; onDone: () => void; onRetry: () => void}) {
  const final = !!outcome?.final, token = copy.token;
  // Signed but never accepted and no longer able to land: nothing moved.
  if (!final && outcome?.expired) return <div className="native-revoke-outcome" data-tone="failed" role="alert">
    <span className="native-revoke-outcome-mark" aria-hidden="true"><CircleAlert size={28} /></span>
    <h3>{run.method === 'withdraw' ? 'The withdrawal expired' : run.method === 'revoke' ? 'The revoke expired' : 'The return expired'}</h3>
    <p>{copy.network} did not accept the transaction before it expired.</p>
    <p className="native-revoke-outcome-note">{run.method === 'revoke' ? 'The agent can still spend within the policy.' : `Nothing moved: your ${token} is still in the vault${run.before ? ` (${run.before} ${token})` : ''}.`} Try again to sign a fresh transaction.</p>
    <div className="native-revoke-outcome-actions">
      <button type="button" className="btn btn-primary" autoFocus onClick={onRetry}>Try again</button>
    </div>
  </div>;
  if (!run.ok) return <div className="native-revoke-outcome" data-tone="failed" role="alert">
    <span className="native-revoke-outcome-mark" aria-hidden="true"><CircleAlert size={28} /></span>
    <h3>{run.method === 'revoke' ? 'Spending was not stopped' : 'Nothing was returned'}</h3>
    <p>{run.error}</p>
    <p className="native-revoke-outcome-note">{run.method === 'revoke' ? 'The agent can still spend within the policy.' : `Your ${token} is still in the vault${run.before ? ` (${run.before} ${token})` : ''}.`}</p>
    <div className="native-revoke-outcome-actions">
      <button type="button" className="btn btn-primary" autoFocus onClick={onRetry}>Try again</button>
    </div>
  </div>;
  const title = run.method === 'close' ? (final ? `${run.before ?? 'All'} ${token} returned` : 'Return sent')
    : run.method === 'withdraw' ? (final ? `${run.amount} ${token} returned` : 'Withdrawal sent')
    : 'Agent spending stopped';
  const detail = run.method === 'close'
    ? (final ? copy.returnedText : `${copy.network} has not finalized the return yet. Your ${token} arrives once it does.`)
    : run.method === 'withdraw'
      ? (final ? (vaultGone ? 'The vault is now empty.' : `${balance ?? '—'} ${token} stays in the vault for the agent to spend within the policy.`) : `${copy.network} has not finalized the withdrawal yet. Your ${token} arrives once it does.`)
      : `${balance ?? 'Any remaining'} ${token} stays in the vault ${copy.keptUntil}.`;
  return <div className="native-revoke-outcome" data-tone={final || run.method === 'revoke' ? 'done' : 'pending'} role="status">
    <span className="native-revoke-outcome-mark" aria-hidden="true">{final || run.method === 'revoke' ? <CircleCheck size={28} /> : <Spinner />}</span>
    <h3>{title}</h3>
    <p>{detail}</p>
    {outcome?.link ? <a className="native-revoke-outcome-link" href={outcome.link} target="_blank" rel="noreferrer">View transaction<ExternalLink size={13} aria-hidden="true" /></a> : null}
    <div className="native-revoke-outcome-actions">
      <button type="button" className="btn btn-primary" autoFocus onClick={onDone}>Done</button>
    </div>
  </div>;
}
