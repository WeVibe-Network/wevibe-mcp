import { createHash } from 'node:crypto';
import type { AttestationMetadata, ProvenanceTier } from './types.js';

export interface AttestationProvider {
  attest(session_transcript: string, memory_content: string, model_identity: string): Promise<AttestationMetadata | null>;
}

export interface AttestationHookConfig {
  provider: AttestationProvider | null;
  enabled: boolean;
}

let _config: AttestationHookConfig = {
  provider: null,
  enabled: false,
};

export function configureAttestation(config: Partial<AttestationHookConfig>): void {
  if (config.provider !== undefined) {
    _config.provider = config.provider;
  }
  if (config.enabled !== undefined) {
    _config.enabled = config.enabled;
  }
  console.log(`wevibe-mcp: attestation hook configured — enabled=${_config.enabled}, provider=${_config.provider ? 'yes' : 'none'}`);
}

export function isAttestationEnabled(): boolean {
  return _config.enabled;
}

export function hasAttestationProvider(): boolean {
  return _config.provider !== null;
}

export async function runAttestationHook(
  session_transcript: string,
  memory_content: string,
  model_identity: string,
): Promise<AttestationMetadata | null> {
  if (!_config.enabled) {
    return null;
  }

  if (!_config.provider) {
    return null;
  }

  try {
    const result = await _config.provider.attest(session_transcript, memory_content, model_identity);
    return result;
  } catch (e) {
    console.warn(`wevibe-mcp: attestation hook failed — ${e}`);
    return null;
  }
}

export function createUnattestedMetadata(session_hash: string, model_identity: string = 'unknown'): AttestationMetadata {
  return {
    provenance: 'unattested' as ProvenanceTier,
    attestor_signature: '',
    attestation_timestamp: new Date().toISOString(),
    model_identity,
    session_hash,
    domain_tags: [],
    challenge_params: {
      audit_tier: 'sampled',
      tokens_challenged: 0,
      total_tokens: 0,
    },
  };
}

export function computeSessionHash(transcript: string): string {
  const hash = createHash('sha256').update(transcript).digest();
  return Array.from(hash as Buffer).map(b => b.toString(16).padStart(2, '0')).join('');
}