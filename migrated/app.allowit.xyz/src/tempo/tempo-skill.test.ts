import {describe, expect, it} from 'vitest';
import type {TempoExecutionSnapshot} from './tempo-api';
import {TEST_CONFIG, TEST_POLICY} from './tempo-fixtures';
import {buildTempoSkill} from './tempo-skill';
const origin = 'https://allowit.example';
const snapshot: TempoExecutionSnapshot = {policyId: 'bound-shared-draft', revision: 2, code: 'reviewed source', sourceHash: 'ab'.repeat(32), workflow: [], originalIntent: 'Do not reproduce arbitrary authoring text', requirementsDigest: TEST_POLICY.requirementsDigest, semanticRequired: TEST_POLICY.semanticRequired};
describe('Tempo managed public instructions', () => {
  it('does not serialize capability, RPC credentials, arbitrary authoring or extra object fields', () => {
    const secret = 'private-marker-do-not-serialize';
    const config = {...TEST_CONFIG, rpcUrl: 'http://127.0.0.1:8545/?api_key=' + secret, tokenSymbol: 'bad\n' + secret, capability: secret};
    const policy = {...TEST_POLICY, prompt: secret, capability: secret};
    const {skill, prompt} = buildTempoSkill(config, policy, {...snapshot, code: secret, originalIntent: secret}, origin);
    expect(skill + prompt).not.toContain(secret); expect(skill).not.toContain(config.rpcUrl); expect(skill).not.toContain('Bearer ');
  });
});
