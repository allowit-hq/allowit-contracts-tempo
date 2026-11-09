# Migrated Tempo code

This folder holds Tempo code that left the shared AllowIt repositories during the vendor plugin separation (2026-11-08).
The files are verbatim copies. Each file keeps its original path under the folder of its origin repository.

## Status

- The code is not wired to the SDK plugin contract. A later backport moves the useful parts behind the `allowit-sdk` plugin registration.
- The code is not built or tested here. No workspace, package or CI configuration includes this folder.
- Some files are whole copies of mixed files. They also contain shared code and terms of other vendors. Keep only the Tempo parts in the backport.

## Origins

- `app.allowit.xyz/`: [allowit-hq/app.allowit.xyz](https://github.com/allowit-hq/app.allowit.xyz) at `4ddb47c28a9087083ad6f3f361e0e7cc1b834a24` (branch `vendor-plugin-separation`).
- `allowit-engine/`: [allowit-hq/allowit-engine](https://github.com/allowit-hq/allowit-engine) at `13a3ef982aacaaa5417d34d4a8eb5253c5fcc05c` (`main`).

## Origin paths

### allowit-engine

- `crates/allowit-server/TEMPO-MPP.md`

### app.allowit.xyz

- `.github/workflows/fast.yml`
- `package.json`
- `playwright.tempo-ui.config.ts`
- `scripts/tests/frontend-server.test.mjs`
- `server-proxy/production.mjs`
- `src/App.tsx`
- `src/TopNav.tsx`
- `src/delegate/DelegateAllowanceRecovery.tsx`
- `src/delegate/useDelegateWorkspace.ts`
- `src/main.tsx`
- `src/micro/useMicro.ts`
- `src/native-vault/DeploymentReview.tsx`
- `src/native-vault/deployment-handoff.test.ts`
- `src/policy/PolicyDefinition.tsx`
- `src/policy/RevokeDialog.tsx`
- `src/policy/policy-close.ts`
- `src/policy/policy-glass.css`
- `src/shell/Shell.tsx`
- `src/tempo/TempoPurchaseDetails.tsx`
- `src/tempo/TempoSignIn.tsx`
- `src/tempo/TempoStopAll.tsx`
- `src/tempo/TempoVault.tsx`
- `src/tempo/evm-wallets.ts`
- `src/tempo/tempo-api.test.ts`
- `src/tempo/tempo-api.ts`
- `src/tempo/tempo-contracts.test.ts`
- `src/tempo/tempo-contracts.ts`
- `src/tempo/tempo-expiry.test.ts`
- `src/tempo/tempo-fixtures.ts`
- `src/tempo/tempo-managed.test.ts`
- `src/tempo/tempo-managed.ts`
- `src/tempo/tempo-mpp.test.tsx`
- `src/tempo/tempo-mpp.ts`
- `src/tempo/tempo-signin.test.ts`
- `src/tempo/tempo-skill.test.ts`
- `src/tempo/tempo-skill.ts`
- `src/tempo/tempo-source.test.ts`
- `src/tempo/tempo-state.test.ts`
- `src/tempo/tempo-stop-all.test.tsx`
- `src/tempo/tempo-view.test.ts`
- `src/tempo/tempo-view.ts`
- `src/tempo/tempo-wallet.test.ts`
- `src/tempo/tempo-wallet.ts`
- `src/tempo/tempo.css`
- `src/vendors/stellar/AdkOwnerHandoff.tsx`
- `src/vendors/stellar/StellarBrowserReview.tsx`
- `src/wallet/ChainPicker.tsx`
- `src/wallet/chain-explorer.test.ts`
- `src/wallet/chain-explorer.ts`
- `src/wallet/chain-picker.css`
- `src/wallet/networks.ts`
- `tests/tempo-ui-boundaries.spec.ts`
- `vite.config.ts`
