import {useEffect, useState} from 'react';
import {ChevronRight, ExternalLink, LoaderCircle, Signature, Wallet} from 'lucide-react';
import {ChainSelect} from '../wallet/ChainPicker';
import NetworkPicker from '../wallet/NetworkPicker';
import WalletIcon from '../wallet/WalletIcon';
import {ErrorBanners, type Banner} from '../shell/Shell';
import {TempoAPI} from './tempo-api';
import type {TempoConfig} from './tempo-contracts';
import {signInTempo} from './tempo-wallet';
import {SUGGESTED_WALLETS, rememberWallet, selectTempoChain, useEvmWallets} from './evm-wallets';
import './tempo.css';

/** The Tempo sign-in card: pick an EVM wallet, switch it to Tempo, sign one message. The server sets the session. */
export default function TempoSignIn({busy, errors, onSignedIn}: {busy: boolean; errors: Banner[]; onSignedIn: () => Promise<void>}) {
  const wallets = useEvmWallets();
  const [config, setConfig] = useState<TempoConfig | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    TempoAPI.config().then(c => {if (live) setConfig(c);}, e => {if (live) setError(e instanceof Error ? e.message : 'Tempo is not configured.');});
    return () => {live = false;};
  }, []);
  async function pick(id: string) {
    const wallet = wallets.find(w => w.id === id);
    if (!config || !wallet || pending) return;
    setPending(id); setError('');
    try {
      await selectTempoChain(wallet.provider, config);
      await signInTempo(wallet.provider, config);
      rememberWallet(id);
      await onSignedIn();
    } catch (e) {
      // EIP-1193 code 4001: the owner declined in the wallet.
      setError((e as {code?: number})?.code === 4001 ? `${wallet.name} declined the request. Choose a wallet to try again.` : e instanceof Error ? e.message : 'Sign-in could not finish.');
    } finally {setPending(null);}
  }
  const off = busy || !!pending || !config;
  const network = config?.network === 'tempo:localnet' ? 'Localnet' : 'Testnet';
  const waiting = wallets.find(w => w.id === pending)?.name;
  const banners: Banner[] = [...errors, ...(error ? [{key: 'tempo-signin', text: error, dismiss: () => setError('')}] : [])];
  return <section className="auth-card tempo-signin" aria-labelledby="si-title">
    <div className="auth-head">
      <h1 id="si-title" className="auth-title">Sign in with a Tempo wallet</h1>
      <p className="auth-lede">Choose a wallet, then approve a message to prove you hold the address.</p>
    </div>
    {banners.length > 0 ? <div className="auth-errors"><ErrorBanners errors={banners} /></div> : null}
    <div className="auth-network">
      <div className="auth-network-text">
        <span className="auth-network-label">Blockchain</span>
        <span className="auth-network-hint" id="si-chain-hint">Wallets for this chain are listed below.</span>
      </div>
      <ChainSelect chain="tempo" disabled={busy || !!pending} describedBy="si-chain-hint" />
    </div>
    <div className="auth-network">
      <div className="auth-network-text">
        <span className="auth-network-label">Network</span>
        <span className="auth-network-hint" id="si-network-hint">New policies are created on this network.</span>
      </div>
      <NetworkPicker networks={[{id: config?.network ?? 'tempo:testnet', label: network}]} network={config?.network ?? 'tempo:testnet'} disabled={off} describedBy="si-network-hint" onChange={() => {}} />
    </div>
    {wallets.length === 0 ? <p className="auth-empty-title tempo-signin-empty"><Wallet size={16} aria-hidden="true" />No EVM wallet found in this browser.</p> : null}
    <ul className="auth-wallets" aria-label="Wallets">
      {wallets.map(w => <li key={w.id}>
        <button type="button" className={`auth-wallet${pending === w.id ? ' is-waiting' : ''}`} disabled={off} onClick={() => void pick(w.id)}>
          <span className="auth-wallet-icon"><WalletIcon src={w.icon} /></span>
          <span className="auth-wallet-name">{pending === w.id ? `Waiting for ${w.name}…` : w.name}</span>
          <span className="auth-wallet-end" aria-hidden="true">{pending === w.id ? <LoaderCircle className="spin" size={16} /> : <ChevronRight size={16} />}</span>
        </button>
      </li>)}
      {SUGGESTED_WALLETS.filter(s => !wallets.some(w => w.id === s.id)).map(s => <li key={s.id}>
        <a className="auth-wallet tempo-wallet-install" href={s.href} target="_blank" rel="noreferrer">
          <span className="auth-wallet-icon"><WalletIcon src={s.icon} /></span>
          <span className="auth-wallet-name">{s.name}<small className="tempo-wallet-hint">Not installed</small></span>
          <span className="auth-wallet-end">Install<ExternalLink size={13} aria-hidden="true" /></span>
        </a>
      </li>)}
    </ul>
    {wallets.length === 0 ? <p className="auth-local-link small">Install a wallet, then reload this page.</p> : null}
    <p className="auth-status" role="status">{waiting ? `Approve the network and message in ${waiting} to continue.` : ''}</p>
    <p className="auth-note"><Signature size={14} aria-hidden="true" /><span>Your wallet is asked to add or switch to Tempo {network}, then to sign a message. No transaction, no fee and no spending permission.</span></p>
  </section>;
}
