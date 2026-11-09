import PolicyCode from './PolicyCode';
import type {MicroPolicy} from '../micro/micro-contracts';
import {readableDecimal} from '../wallet/amount-format';
import {callTyping, type TypedView} from './typed-metadata';
import TypedBudgets, {budgetDisplay} from './TypedBudgets';

/**
 * Display projections never replace the complete policy source. Typed help and budget facts apply only to the checked
 * complete source.
 */
/** A stopped policy no longer holds its allocation, so the approved amount is shown as past. */
function allocationText(policy: MicroPolicy) {
  const a = policy.allocation;
  if (!a) return policy.approvalPending ? 'Approval pending' : 'No allocation yet';
  const amount = `${readableDecimal(a.amount)} ${a.token}`;
  if (policy.status === 'cancelled') return `${policy.network === 'local:dev' ? 'Closed' : 'Revoked'} (was ${amount})`;
  if (policy.status === 'cancelling') return `${amount} approved. Revocation pending.`;
  return `${amount} approved`;
}

/** `funding` replaces the allocation row for a policy funded elsewhere, such as a Tempo vault. */
export default function PolicyDefinition({policy, typed, funding}: {policy: MicroPolicy; typed?: TypedView; funding?: {label: string; text: string}}) {
  const typing = typed && typed.state !== 'absent' && typed.state !== 'pending' && policy.code ? (site: {name: string; start: number; end: number}) => callTyping(typed, site) : undefined;
  const constructor = policy.constructorSource && policy.code.includes(policy.constructorSource) ? policy.constructorSource : undefined;
  return <>
    {policy.fundingRequest ? <dl className="facts policy-funding-request">
      <div><dt>Funding request</dt><dd>{readableDecimal(policy.fundingRequest.amount)} {policy.fundingRequest.token}</dd></div>
      <div><dt>{funding?.label ?? 'Allocation'}</dt><dd>{funding?.text ?? allocationText(policy)}</dd></div>
    </dl> : null}
    <TypedBudgets view={budgetDisplay(typed, policy.typedBudgetRequirements)} />
    {constructor ? <details className="code" open>
      <summary>Constructor (excerpt)</summary>
      <PolicyCode code={constructor} functionHelp={policy.functionHelp} label="Constructor from policy code" />
    </details> : null}
    <details className="code" open={!constructor}>
      <summary>Policy code — complete source</summary>
      <PolicyCode code={policy.code || '// No code was returned for this revision.'} calls={policy.calls} functionHelp={policy.functionHelp} typing={typing} />
    </details>
  </>;
}
