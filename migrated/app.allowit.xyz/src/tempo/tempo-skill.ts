import type {TempoExecutionSnapshot} from './tempo-api';
import {checkedTempoConfig, checkedTempoPolicy, sameAddress, type TempoConfig, type TempoPolicy} from './tempo-contracts';
import {tempoManagedOrigin, tempoManagedReady, TEMPO_MANAGED_UNAVAILABLE} from './tempo-managed';

/** Public instructions only. The separate private JSON grants policy-scoped managed payment access. */
export function buildTempoSkill(config: TempoConfig, policy: TempoPolicy, snapshot: TempoExecutionSnapshot, originValue: string) {
  checkedTempoConfig(config); checkedTempoPolicy(policy, config, policy.owner);
  if (!tempoManagedReady(config)) throw new Error(TEMPO_MANAGED_UNAVAILABLE);
  if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 || !/^[a-f\d]{64}$/i.test(snapshot.sourceHash)
    || snapshot.requirementsDigest !== policy.requirementsDigest || snapshot.semanticRequired !== policy.semanticRequired) {
    throw new Error('Review the vault’s exact bound policy before creating its skill.');
  }
  const origin = tempoManagedOrigin(originValue), bundleFilename = `allowit-tempo-${policy.id}.json`;
  const token = /^[A-Za-z][A-Za-z\d ._-]{0,31}$/.test(config.tokenSymbol ?? '') ? config.tokenSymbol! : 'configured token';
  const recipient = sameAddress(policy.recipient, '0x0000000000000000000000000000000000000000')
    ? 'Any recipient admitted by the policy; choose the address required by the task.' : policy.recipient;
  const skill = `---
name: allowit-tempo-${policy.id.slice(0, 12)}
description: Request managed Tempo payments within this exact Allowit Rust policy.
---

# Allowit Tempo payments

Use the Allowit managed HTTP endpoints for this policy. No local executor wallet, signing key or CLI installation is needed. The service signs only after the exact Rust policy permits the request. The owner keeps funding, questions, stopping and returns in the Allowit website.

## This policy

- Allowit origin: ${origin}
- Network: ${policy.network}; chain ID: ${policy.chainId}. Only testnet/localnet is supported.
- Policy ID: ${policy.id}
- Vault: ${policy.vault}
- Owner: ${policy.owner}
- Managed executor: ${policy.executor}
- Asset: ${token}; token address: ${policy.token}; decimals: 6.
- Limits at download: ${policy.totalLimit} total, ${policy.dailyLimit} per UTC day, ${policy.actionLimit} per payment.
- Recipient: ${recipient}
- Bound source: revision ${snapshot.revision}; SHA256 ${snapshot.sourceHash}.
- Vault expiry (Unix seconds): ${policy.expiresAt}.

These public instructions do not grant access. Use the accompanying private **${bundleFilename}** for the managedAgent endpoint and authorization. Keep that file private. Never request an owner seed, wallet key, server signing key, browser cookie or browser session. The private export must match the origin, policy, vault, executor and exact policy digests above; stop if it does not.

## Request a payment

Send an HTTPS POST to **${origin}/api/tempo/spend** using the authorization value from the private export and Content-Type application/json. Local development uses only its exported loopback origin. Send these fields as JSON:

\`\`\`json
{
  "policyId": "${policy.id}",
  "requestId": "A_UNIQUE_REQUEST_ID",
  "recipient": "RECIPIENT_FOR_THE_AUTHORIZED_TASK",
  "amount": "0.25",
  "action": "Describe the actual purchase",
  "merchant": "Identify the actual merchant",
  "context": {"purpose": "State the actual task and evidence"}
}
\`\`\`

Replace every placeholder with the exact authorized intent. Amount is a positive decimal with at most six fractional places. Choose a fresh request ID for each new intent and preserve the exact complete JSON. Context supplied by callers is a claim, not authenticated evidence. The original Rust rules, hard limits and owner questions still apply. Never switch wallets, recipients, amounts or payment tools to bypass a refusal.

## Results and recovery

Every reply is JSON. Read the outcome from its \`decision\` field, and the payment from \`operation\` when present: \`operation.status\`, \`operation.transactionHash\` and \`operation.blockNumber\`. A settled payment looks like:

\`\`\`json
{"decision":"settled","operation":{"id":"THE_ORIGINAL_REQUEST_ID","status":"settled","transactionHash":"0x...","blockNumber":123}}
\`\`\`

- awaiting_input: the purchase is paused. Ask the owner to answer the exact saved \`question\` in Allowit. An answer signs a message and moves no funds. Tempo owner questions have no separate answer deadline; the vault expiry and the owner's stop still apply. Check status until it reports owner_answered.
- owner_answered: the owner has answered; \`approved\` shows Yes (true) or No (false). Send the spend request again once, with the identical original request ID and JSON, to continue; the policy is evaluated again with that answer, and it may still deny.
- deny: report the actual reason and stop. Do not claim a receipt or bypass the rule.
- prepared, submitted or uncertain: payment is not confirmed. Keep the original request; do not create a replacement payment.
- settled: report confirmation only when the original operation is settled with its transaction hash and verified block. Keep that exact receipt.
- failed: report the actual failure. A failure before broadcast is not an on-chain payment.

Check the original request with POST **${origin}/api/tempo/spend/status**, the same private authorization, and only this JSON:

\`\`\`json
{"policyId":"${policy.id}","requestId":"THE_ORIGINAL_REQUEST_ID"}
\`\`\`

This status endpoint never creates, signs or broadcasts a transaction. HTTP 404 with code REQUEST_NOT_FOUND means nothing is retained under that request ID and nothing was paid: either it was never received or the policy denied it, and that denial was final in its original reply.

Errors are JSON \`{"error":"..."}\`, sometimes with a \`code\`. 400 means a malformed request; 401 means the authorization was revoked or replaced; 403 means the owner stopped spending or the capability does not cover this policy; 409 means the request ID belongs to different JSON or an earlier payment is unresolved (check its status); 503 means managed execution is unavailable. No error is a payment. After a 5xx or a lost reply, check status before anything else and never use a new request ID for the same intent.
 An identical repeated spend request recovers the original proof; a changed request under the same ID must fail. Never rotate access, erase request history or create a new ID to resolve uncertainty. If managed execution is unavailable, stop and report it to the owner; do not substitute local signing.

If the original submission is unresolved, check its status first. An explicit POST to **${origin}/api/tempo/spend/resume** with the same private authorization and the same minimal policyId/requestId JSON may retry only the retained signed bytes, hash and nonce. It never prepares or signs a new payment. At most three explicit retries are allowed; expiry, stopping or revoked access blocks resubmission while the original proof remains available through status. Do not repeatedly retry or invent a replacement request.

## MPP payment authorization

The spend endpoint can authorize the payment side of a supported Tempo MPP charge. This skill does not automatically fetch paid resources or construct a service payment credential. A compatible HTTP caller must preserve the real challenge and handle the service credential flow; if that caller is unavailable, stop before paying.

Only the existing exact HTTPS GET, charge/push flow on Tempo Testnet (chain ID 42431) is supported. Localnet does not support MPP purchases. Keep the original supported challenge as mppRequest and the exact URL, amount, token, recipient and request identity. Do not use query strings, credentials, fragments, redirects or a different network. Send mppRequest unchanged with the payment request. A finalized token payment and an HTTP response are separate outcomes. Resource delivery is not independently attested; do not claim automatic delivery or provider verification.

## Owner control

The owner funds the vault with two wallet transactions: exact token approval, then funding. Approved managed payments do not need another owner transaction signature. After stopping or returning funds, new payments must fail. Downloading these instructions does not export or rotate access. Downloading the private capability again preserves existing access; use the original request during recovery. Share public transaction hashes and verified outcomes, never bearer authorization or signing material.
`;
  const prompt = `Read SKILL.md and the accompanying private ${bundleFilename}. Use only its managed HTTP payment endpoints for Tempo vault ${policy.vault} on ${policy.network} (chain ${policy.chainId}), within this exact Rust policy. No local signing wallet or CLI is required. Preserve original request IDs and JSON during recovery, report denials and owner questions, and keep payment confirmation separate from resource delivery.`;
  return {skill, prompt, bundleFilename};
}
