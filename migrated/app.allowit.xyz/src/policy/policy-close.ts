import type {MicroController, MicroPolicy} from '../micro/micro-contracts';
import {hasNativeAttachment} from '../native-vault/native-bound';
import {fundingPath, hasDelegatedAuthority, newSetupAllowed, runtimeOf} from '../runtime/runtime';
import {isTempoNetwork} from '../wallet/networks';

type SetupViews = Pick<MicroController, 'setup'>;

/** Whether this policy can be cancelled or discarded from its card and the policy list. */
export function cancelOffered(c: SetupViews, policy: MicroPolicy) {
  if (hasDelegatedAuthority(policy)) return false;
  if (hasNativeAttachment(policy)) return false;
  const runtime = runtimeOf(policy), caps = runtime.capabilities;
  const setupView = runtime.kind === 'contract-wallet' ? c.setup.view(policy.id) : null;
  return policy.status !== 'cancelled' && (
    (runtime.kind === 'owner-wallet' && fundingPath(policy) !== 'authorization' && (caps.revoke || policy.status === 'draft'))
    || (runtime.kind === 'contract-wallet' && newSetupAllowed(policy) && !!caps.discard && (setupView?.phase === 'idle' || setupView?.phase === 'prepared')));
}

/** Why the list's close button cannot close a policy. `revoke` means the policy page has the way forward. */
export interface CloseBlock {reason: string; revoke: boolean}

/**
 * The reason a policy stays in the list when its close button is pressed, or null when it can close.
 * Native vaults are not covered: their close button opens the revoke dialog instead.
 * `tempoActive` is whether a Tempo policy has a vault that still needs revoking.
 */
export function closeBlocker(c: SetupViews, policy: MicroPolicy, tempoActive = false): CloseBlock | null {
  if (policy.status === 'cancelled') return null;
  if (isTempoNetwork(policy.network)) return tempoActive ? {reason: 'This policy has an active Tempo vault. Revoke it first.', revoke: true} : null;
  if (cancelOffered(c, policy)) return null;
  if (policy.status === 'cancelling') return {reason: 'Cancellation is in progress. The policy leaves the list once it finishes.', revoke: false};
  if (fundingPath(policy) === 'authorization') return {reason: 'A budget authorization has nothing to revoke here. Open the policy to manage it.', revoke: false};
  const runtime = runtimeOf(policy);
  if (runtime.kind === 'contract-wallet' && newSetupAllowed(policy) && runtime.capabilities.discard) return {reason: 'Vault setup is in progress. Finish or recover it on the policy page first.', revoke: false};
  return {reason: 'This policy cannot be closed from the list. Open it to see what you can do.', revoke: false};
}

/**
 * The policy card renders its cancel control, which also runs the list's close button.
 * A Devnet draft without a vault stays on the wallet allocation flow and can be discarded.
 */
export function cancelControlShown(c: SetupViews, policy: MicroPolicy) {
  return !isTempoNetwork(policy.network) && cancelOffered(c, policy);
}
