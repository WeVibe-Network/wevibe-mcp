import fs from 'node:fs';
import path from 'node:path';

import { CHAIN_VERSION, canonicalJson, sha256Hex, type ChainLink } from './types.js';

function comparePathBytes(a: string, b: string): number {
  return Buffer.from(a).compare(Buffer.from(b));
}

function chainFilePath(goalDirPath: string): string {
  return path.join(goalDirPath, 'chain.jsonl');
}

/**
 * Canonical delta preimage:
 * - one line per changed path, sorted by byte-wise path order
 * - A <path> <newHash>
 * - R <path> <oldHash>
 * - M <path> <oldHash> <newHash>
 *
 * Empty delta preimage is the empty string; hash = sha256Hex('').
 */
export function diffHashFor(
  prevFiles: Array<{ path: string; sha256: string }> | null,
  nextFiles: Array<{ path: string; sha256: string }>,
): string {
  const prevMap = new Map((prevFiles ?? []).map((entry) => [entry.path, entry.sha256]));
  const nextMap = new Map(nextFiles.map((entry) => [entry.path, entry.sha256]));

  const changedPaths = new Set<string>([...prevMap.keys(), ...nextMap.keys()]);
  const entries: string[] = [];

  for (const filePath of [...changedPaths].sort(comparePathBytes)) {
    const oldHash = prevMap.get(filePath);
    const newHash = nextMap.get(filePath);

    if (oldHash === undefined && newHash !== undefined) {
      entries.push(`A ${filePath} ${newHash}`);
      continue;
    }

    if (oldHash !== undefined && newHash === undefined) {
      entries.push(`R ${filePath} ${oldHash}`);
      continue;
    }

    if (oldHash !== undefined && newHash !== undefined && oldHash !== newHash) {
      entries.push(`M ${filePath} ${oldHash} ${newHash}`);
    }
  }

  return sha256Hex(entries.join('\n'));
}

/**
 * Canonical link preimage is UTF-8 newline-separated fields in this order:
 * prev\nstate_hash\ndiff_hash\nts\nsession_id\ncause
 *
 * `prev` is the previous link's `link_hash`; genesis `prev` is `seal.state0_hash`
 * to bind the chain to the seal.
 */
export function computeLinkHash(input: {
  prev: string;
  state_hash: string;
  diff_hash: string;
  ts: string;
  session_id: string;
  cause: string;
}): string {
  return sha256Hex([input.prev, input.state_hash, input.diff_hash, input.ts, input.session_id, input.cause].join('\n'));
}

export async function readChain(goalDirPath: string): Promise<ChainLink[]> {
  const filePath = chainFilePath(goalDirPath);
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const links: ChainLink[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length === 0) {
      throw new Error('chain_corrupt');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error('chain_corrupt');
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('chain_corrupt');
    }

    const link = parsed as ChainLink;
    if (link.v !== CHAIN_VERSION || link.index !== i) {
      throw new Error('chain_corrupt');
    }

    if (i > 0) {
      const prev = links[i - 1];
      if (link.prev !== prev.link_hash) {
        throw new Error('chain_corrupt');
      }
    }

    links.push(link);
  }

  return links;
}

export async function readChainHead(goalDirPath: string): Promise<ChainLink | null> {
  const links = await readChain(goalDirPath);
  return links.length > 0 ? links[links.length - 1] : null;
}

export async function appendLink(
  goalDirPath: string,
  seal: { state0_hash: string },
  input: {
    ts: string;
    session_id: string;
    cause: string;
    kind: 'state' | 'gap';
    detector?: 'watcher' | 'attach_mismatch';
    state_hash: string;
    diff_hash: string;
  },
): Promise<ChainLink> {
  if (input.kind === 'gap' && input.detector === undefined) {
    throw new Error('chain_corrupt');
  }
  if (input.kind === 'state' && input.detector !== undefined) {
    throw new Error('chain_corrupt');
  }

  const head = await readChainHead(goalDirPath);
  const index = head === null ? 0 : head.index + 1;
  const prev = head === null ? seal.state0_hash : head.link_hash;

  const linkBase: Omit<ChainLink, 'link_hash'> = {
    v: CHAIN_VERSION,
    index,
    prev,
    state_hash: input.state_hash,
    diff_hash: input.diff_hash,
    ts: input.ts,
    session_id: input.session_id,
    cause: input.cause,
    kind: input.kind,
    ...(input.detector === undefined ? {} : { detector: input.detector }),
    state_alg: 'walk-v1',
  };

  const link: ChainLink = {
    ...linkBase,
    link_hash: computeLinkHash({
      prev: linkBase.prev,
      state_hash: linkBase.state_hash,
      diff_hash: linkBase.diff_hash,
      ts: linkBase.ts,
      session_id: linkBase.session_id,
      cause: linkBase.cause,
    }),
  };

  fs.mkdirSync(goalDirPath, { recursive: true });
  fs.appendFileSync(chainFilePath(goalDirPath), `${canonicalJson(link)}\n`, 'utf8');
  return link;
}
