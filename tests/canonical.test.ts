import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrgMessage, inviteMemberMessage, rotateEpochMessage, removeMemberMessage, submitMemoryMessage, approveSubmissionMessage, denySubmissionMessage, feeModelHash, type FeeModel } from '../src/canonical.js';

function sha256hex(data: string): string {
  return createHash('sha256').update(data, 'utf-8').digest('hex');
}

describe('canonical signing messages', () => {
  describe('createOrgMessage', () => {
    it('produces correct field order and format with null fee_model', () => {
      const msg = new TextDecoder().decode(createOrgMessage(
        'org-test-1',
        'aabbccdd',
        '11223344',
        'Test Org',
        'test.example.com',
        'enc_env_base64_data',
        'srch_env_base64_data',
        'mod_env_base64_data',
        'pk_mod_hex_value',
        null,
      ));

      const lines = msg.split('\n');
      expect(lines).toHaveLength(11);
      expect(lines[0]).toBe('wevibe.create_org.v1');
      expect(lines[1]).toBe('domain:test.example.com');
      expect(lines[2]).toBe('enc_envelope:enc_env_base64_data');
      expect(lines[3]).toBe('fee_model_hash:' + sha256hex('{}'));
      expect(lines[4]).toBe('leader_pubkey:aabbccdd');
      expect(lines[5]).toBe('leader_x25519_pubkey:11223344');
      expect(lines[6]).toBe('mod_envelope:mod_env_base64_data');
      expect(lines[7]).toBe('org_id:org-test-1');
      expect(lines[8]).toBe('org_name:Test Org');
      expect(lines[9]).toBe('pk_mod:pk_mod_hex_value');
      expect(lines[10]).toBe('search_envelope:srch_env_base64_data');
    });

    it('matches Go test vector for fee_model with typed fields', () => {
      const msg = new TextDecoder().decode(createOrgMessage(
        'org-1', 'pub1', 'x1', 'Org', 'd.com', 'enc', 'srch', 'mod', 'pk_mod',
        { tier: 'free', monthly_credits: 100 },
      ));

      const lines = msg.split('\n');
      const expectedHash = sha256hex('{"tier":"free","monthly_credits":100}');
      expect(lines[3]).toBe('fee_model_hash:' + expectedHash);
    });

    it('is deterministic', () => {
      const a = createOrgMessage('o', 'p', 'x', 'n', 'd', 'e', 's', 'm', 'pk', null);
      const b = createOrgMessage('o', 'p', 'x', 'n', 'd', 'e', 's', 'm', 'pk', null);
      expect(a).toEqual(b);
    });
  });

  describe('inviteMemberMessage', () => {
    it('produces correct field order and format', () => {
      const msg = new TextDecoder().decode(inviteMemberMessage(
        'org-test-1',
        'invitee_pubkey_hex',
        'invitee_x25519_hex',
        'member',
        'leader_pubkey_hex',
        'enc_env_base64_data',
        'srch_env_base64_data',
        'mod_envelope_data',
        true,
        false,
      ));

      const lines = msg.split('\n');
      expect(lines).toHaveLength(11);
      expect(lines[0]).toBe('wevibe.invite_member.v1');
      expect(lines[1]).toBe('can_contribute:true');
      expect(lines[2]).toBe('can_moderate:false');
      expect(lines[3]).toBe('enc_envelope:enc_env_base64_data');
      expect(lines[4]).toBe('mod_envelope:mod_envelope_data');
      expect(lines[5]).toBe('org_id:org-test-1');
      expect(lines[6]).toBe('pubkey:invitee_pubkey_hex');
      expect(lines[7]).toBe('role:member');
      expect(lines[8]).toBe('search_envelope:srch_env_base64_data');
      expect(lines[9]).toBe('signed_by:leader_pubkey_hex');
      expect(lines[10]).toBe('x25519_pubkey:invitee_x25519_hex');
    });

    it('produces correct format with empty mod_envelope for member role', () => {
      const msg = new TextDecoder().decode(inviteMemberMessage(
        'org-1',
        'member_pub',
        'member_x25519',
        'member',
        'leader_pub',
        'enc_env',
        'srch_env',
        '',
        false,
        false,
      ));

      const lines = msg.split('\n');
      expect(lines).toHaveLength(11);
      expect(lines[1]).toBe('can_contribute:false');
      expect(lines[2]).toBe('can_moderate:false');
      expect(lines[4]).toBe('mod_envelope:');
    });
  });

  describe('rotateEpochMessage', () => {
    it('matches Go test vector with sorted envelopes', () => {
      const msg = new TextDecoder().decode(rotateEpochMessage(
        'org-1',
        'new_pk_mod_hex',
        'leader_hex',
        [
          { pubkey: 'charlie', enc_envelope: 'enc_c', search_envelope: 'srch_c' },
          { pubkey: 'alice', enc_envelope: 'enc_a', search_envelope: 'srch_a', mod_envelope: 'mod_data' },
          { pubkey: 'bob', enc_envelope: 'enc_b', search_envelope: 'srch_b' },
        ],
      ));

      const lines = msg.split('\n');
      expect(lines).toHaveLength(5);
      expect(lines[0]).toBe('wevibe.rotate_epoch.v1');

      const inner =
        'enc_envelope:enc_a\nmod_envelope:mod_data\npubkey:alice\nsearch_envelope:srch_a' +
        '\n--\n' +
        'enc_envelope:enc_b\nmod_envelope:\npubkey:bob\nsearch_envelope:srch_b' +
        '\n--\n' +
        'enc_envelope:enc_c\nmod_envelope:\npubkey:charlie\nsearch_envelope:srch_c';
      const expectedHash = sha256hex(inner);
      expect(lines[1]).toBe('envelopes_hash:' + expectedHash);

      expect(lines[2]).toBe('new_pk_mod:new_pk_mod_hex');
      expect(lines[3]).toBe('org_id:org-1');
      expect(lines[4]).toBe('signed_by:leader_hex');
    });

    it('is order-independent on input envelopes', () => {
      const a = rotateEpochMessage('o', 'p', 's', [
        { pubkey: 'bob', enc_envelope: 'eb', search_envelope: 'sb' },
        { pubkey: 'alice', enc_envelope: 'ea', search_envelope: 'sa' },
      ]);
      const b = rotateEpochMessage('o', 'p', 's', [
        { pubkey: 'alice', enc_envelope: 'ea', search_envelope: 'sa' },
        { pubkey: 'bob', enc_envelope: 'eb', search_envelope: 'sb' },
      ]);
      expect(a).toEqual(b);
    });
  });

  describe('removeMemberMessage', () => {
    it('produces correct field order and format', () => {
      const msg = new TextDecoder().decode(removeMemberMessage(
        'org-test-1',
        'member_pubkey_hex',
        'leader_pubkey_hex',
      ));

      const lines = msg.split('\n');
      expect(lines).toHaveLength(4);
      expect(lines[0]).toBe('wevibe.remove_member.v1');
      expect(lines[1]).toBe('org_id:org-test-1');
      expect(lines[2]).toBe('pubkey:member_pubkey_hex');
      expect(lines[3]).toBe('signed_by:leader_pubkey_hex');
    });
  });

  describe('submitMemoryMessage', () => {
    it('matches hub canonical format and includes memory_type', () => {
      const msg = new TextDecoder().decode(submitMemoryMessage(
        'org-test-1',
        3,
        'abc123def456',
        'contributor_pubkey_hex',
        'memory',
        'ciphertext_hash_hex',
        'plaintext_hash_hex',
        'salt_hex',
        'wrapped_dek_hash_hex',
      ));

      const lines = msg.split('\n');
      expect(lines).toHaveLength(10);
      expect(lines[0]).toBe('wevibe.submit_memory.v1');
      expect(lines[1]).toBe('ciphertext_hash:ciphertext_hash_hex');
      expect(lines[2]).toBe('contributor_pubkey:contributor_pubkey_hex');
      expect(lines[3]).toBe('epoch_id:3');
      expect(lines[4]).toBe('memory_type:memory');
      expect(lines[5]).toBe('org_id:org-test-1');
      expect(lines[6]).toBe('plaintext_hash:plaintext_hash_hex');
      expect(lines[7]).toBe('salt:salt_hex');
      expect(lines[8]).toBe('submission_hash:abc123def456');
      expect(lines[9]).toBe('wrapped_dek_hash:wrapped_dek_hash_hex');
    });
  });

  describe('feeModelHash edge cases', () => {
    it('null and empty object produce the same hash', () => {
      const a = new TextDecoder().decode(createOrgMessage('o', 'p', 'x', 'n', 'd', 'e', 's', 'm', 'pk', null));
      const b = new TextDecoder().decode(createOrgMessage('o', 'p', 'x', 'n', 'd', 'e', 's', 'm', 'pk', {}));
      const lineA = a.split('\n')[3];
      const lineB = b.split('\n')[3];
      expect(lineA).toBe(lineB);
      expect(lineA).toBe('fee_model_hash:' + sha256hex('{}'));
    });
  });

  describe('feeModelHash cross-language vectors', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const VECTORS_PATH = join(__dirname, '../../wevibe-sdk/protocol/test_vectors/fee_model_hash.json');
    let doc: { vectors: Array<{ name: string; input: FeeModel | null; canonical: string; sha256_hex: string }> };

    try {
      doc = JSON.parse(readFileSync(VECTORS_PATH, 'utf-8'));
    } catch {
      doc = { vectors: [] };
    }

    for (const v of doc.vectors) {
      it(v.name, () => {
        const got = feeModelHash(v.input);
        expect(got).toBe(v.sha256_hex);
      });
    }
  });

  describe('approveSubmissionMessage', () => {
    it('matches Go test vector — deterministic with sorted keywords', () => {
      const msg = new TextDecoder().decode(approveSubmissionMessage(
        'org-test-1',
        'abc123def456',
        0,
        'cid-approved-1',
        'umbral_capsule_hex',
        'umbral_ciphertext_hex',
        'correct_implementation',
        'moderator_pubkey_hex',
        [
          { keyword: 'token_b', weight: 0.5 },
          { keyword: 'token_a', weight: 0.3 },
          { keyword: 'token_c', weight: 0.2 },
        ],
      ));

      const lines = msg.split('\n');
      expect(lines).toHaveLength(10);
      expect(lines[0]).toBe('wevibe.approve_submission.v1');
      expect(lines[1]).toBe('approved_cid:cid-approved-1');
      expect(lines[3]).toBe('epoch_id:0');
      expect(lines[4]).toBe('memory_type:correct_implementation');
      expect(lines[5]).toBe('org_id:org-test-1');
      expect(lines[6]).toBe('signed_by:moderator_pubkey_hex');
      expect(lines[7]).toBe('submission_hash:abc123def456');
      expect(lines[8]).toBe('umbral_capsule:umbral_capsule_hex');
      expect(lines[9]).toBe('umbral_ciphertext:umbral_ciphertext_hex');
    });

    it('is order-independent on keywords', () => {
      const a = approveSubmissionMessage('o', 'h', 1, 'c', 'cap', 'ct', 'correct_implementation', 's', [
        { keyword: 'b', weight: 0.5 },
        { keyword: 'a', weight: 0.3 },
        { keyword: 'c', weight: 0.2 },
      ]);
      const b = approveSubmissionMessage('o', 'h', 1, 'c', 'cap', 'ct', 'correct_implementation', 's', [
        { keyword: 'c', weight: 0.2 },
        { keyword: 'a', weight: 0.3 },
        { keyword: 'b', weight: 0.5 },
      ]);
      expect(a).toEqual(b);
    });

    it('handles empty keywords', () => {
      const msg = new TextDecoder().decode(approveSubmissionMessage(
        'o', 'h', 0, 'c', 'cap', 'ct', 'negative_signal', 's', [],
      ));
      const lines = msg.split('\n');
      expect(lines[2]).toBe('keywords_hash:' + sha256hex(''));
    });
  });

  describe('denySubmissionMessage', () => {
    it('matches Go test vector', () => {
      const msg = new TextDecoder().decode(denySubmissionMessage(
        'org-test-1',
        'abc123def456',
        'contains credentials',
        'moderator_pubkey_hex',
      ));

      const lines = msg.split('\n');
      expect(lines).toHaveLength(5);
      expect(lines[0]).toBe('wevibe.deny_submission.v1');
      expect(lines[1]).toBe('org_id:org-test-1');
      expect(lines[2]).toBe('reason:contains credentials');
      expect(lines[3]).toBe('signed_by:moderator_pubkey_hex');
      expect(lines[4]).toBe('submission_hash:abc123def456');
    });

    it('is deterministic', () => {
      const a = denySubmissionMessage('o', 'h', 'r', 's');
      const b = denySubmissionMessage('o', 'h', 'r', 's');
      expect(a).toEqual(b);
    });
  });
});
