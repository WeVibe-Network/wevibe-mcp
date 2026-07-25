import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'manifest-'));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

async function readProjectManifest(workingDir: string): Promise<string[]> {
  const { read_project_manifest } = await import('../src/manifest.js');
  return read_project_manifest(workingDir);
}

describe('manifest', () => {
  describe('read_package_json', () => {
    it('reads package.json dependencies', async () => {
      const testDir = makeTempDir();
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({
        dependencies: { ws: '^8.0.0', redis: '^4.0.0' },
        devDependencies: { jest: '^29.0.0' },
      }));
      try {
        const result = await readProjectManifest(testDir);
        expect(result).toContain('ws');
        expect(result).toContain('redis');
        expect(result).toContain('jest');
      } finally {
        cleanup(testDir);
      }
    });

    it('skips scoped packages', async () => {
      const testDir = makeTempDir();
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({
        dependencies: { '@types/node': '^20.0.0', ws: '^8.0.0' },
      }));
      try {
        const result = await readProjectManifest(testDir);
        expect(result).toContain('ws');
        expect(result).not.toContain('@types/node');
      } finally {
        cleanup(testDir);
      }
    });

    it('returns empty for nonexistent file', async () => {
      const testDir = makeTempDir();
      try {
        const result = await readProjectManifest(testDir);
        expect(result).toEqual([]);
      } finally {
        cleanup(testDir);
      }
    });

    it('returns empty for invalid JSON', async () => {
      const testDir = makeTempDir();
      writeFileSync(join(testDir, 'package.json'), 'not json');
      try {
        const result = await readProjectManifest(testDir);
        expect(result).toEqual([]);
      } finally {
        cleanup(testDir);
      }
    });
  });

  describe('read_requirements_txt', () => {
    it('reads requirements.txt', async () => {
      const testDir = makeTempDir();
      writeFileSync(join(testDir, 'requirements.txt'), 'fastapi>=0.110.0\nredis==4.0.0\nws~=8.0.0\n');
      try {
        const result = await readProjectManifest(testDir);
        expect(result).toContain('fastapi');
        expect(result).toContain('redis');
        expect(result).toContain('ws');
      } finally {
        cleanup(testDir);
      }
    });

    it('strips version specifiers', async () => {
      const testDir = makeTempDir();
      writeFileSync(join(testDir, 'requirements.txt'), 'fastapi==0.110.0\nsqlalchemy>=1.4.0,<2.0.0\n');
      try {
        const result = await readProjectManifest(testDir);
        expect(result).toContain('fastapi');
        expect(result).toContain('sqlalchemy');
      } finally {
        cleanup(testDir);
      }
    });

    it('skips comments and empty lines', async () => {
      const testDir = makeTempDir();
      writeFileSync(join(testDir, 'requirements.txt'), '# comment\nfastapi>=0.110.0\n\nredis==4.0.0\n');
      try {
        const result = await readProjectManifest(testDir);
        expect(result).toContain('fastapi');
        expect(result).toContain('redis');
        expect(result).not.toContain('comment');
      } finally {
        cleanup(testDir);
      }
    });

    it('returns empty for nonexistent file', async () => {
      const testDir = makeTempDir();
      try {
        const result = await readProjectManifest(testDir);
        expect(result).toEqual([]);
      } finally {
        cleanup(testDir);
      }
    });
  });

  describe('read_pyproject_toml', () => {
    it('reads pyproject.toml dependencies', async () => {
      const testDir = makeTempDir();
      writeFileSync(join(testDir, 'pyproject.toml'), `
[project]
dependencies = [
    "fastapi>=0.110.0",
    "redis>=4.0.0",
]
`);
      try {
        const result = await readProjectManifest(testDir);
        expect(result).toContain('fastapi');
        expect(result).toContain('redis');
      } finally {
        cleanup(testDir);
      }
    });

    it('returns empty for nonexistent file', async () => {
      const testDir = makeTempDir();
      try {
        const result = await readProjectManifest(testDir);
        expect(result).toEqual([]);
      } finally {
        cleanup(testDir);
      }
    });
  });

  describe('read_cargo_toml', () => {
    it('reads Cargo.toml dependencies', async () => {
      const testDir = makeTempDir();
      writeFileSync(join(testDir, 'Cargo.toml'), `
[dependencies]
serde = "1.0"
tokio = { version = "1.0", features = ["full"] }
`);
      try {
        const result = await readProjectManifest(testDir);
        expect(result).toContain('serde');
        expect(result).toContain('tokio');
      } finally {
        cleanup(testDir);
      }
    });

    it('returns empty for nonexistent file', async () => {
      const testDir = makeTempDir();
      try {
        const result = await readProjectManifest(testDir);
        expect(result).toEqual([]);
      } finally {
        cleanup(testDir);
      }
    });
  });

  describe('read_go_mod', () => {
    it('reads go.mod require block', async () => {
      const testDir = makeTempDir();
      writeFileSync(join(testDir, 'go.mod'), `
module myapp

go 1.21

require (
    github.com/redis/go-redis/v9 v9.0.0
    github.com/valyala/fasthttp v1.0.0
)
`);
      try {
        const result = await readProjectManifest(testDir);
        expect(result.length).toBeGreaterThan(0);
      } finally {
        cleanup(testDir);
      }
    });

    it('returns empty for nonexistent file', async () => {
      const testDir = makeTempDir();
      try {
        const result = await readProjectManifest(testDir);
        expect(result).toEqual([]);
      } finally {
        cleanup(testDir);
      }
    });
  });

  describe('read_project_manifest', () => {
    it('returns empty when no manifest exists', async () => {
      const testDir = makeTempDir();
      try {
        const result = await readProjectManifest(testDir);
        expect(result).toEqual([]);
      } finally {
        cleanup(testDir);
      }
    });

    it('package.json takes precedence', async () => {
      const testDir = makeTempDir();
      writeFileSync(join(testDir, 'package.json'), '{"dependencies": {"ws": "^8.0.0"}}');
      writeFileSync(join(testDir, 'requirements.txt'), 'fastapi>=0.110.0');
      try {
        const result = await readProjectManifest(testDir);
        expect(result).toEqual(['ws']);
      } finally {
        cleanup(testDir);
      }
    });
  });
});
