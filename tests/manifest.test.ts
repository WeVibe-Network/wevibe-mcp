import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), 'wevibe-test-manifest-' + Date.now());

function cleanup() {
  try {
    if (existsSync(TEST_DIR)) {
      for (const f of require('node:fs').readdirSync(TEST_DIR)) {
        unlinkSync(join(TEST_DIR, f));
      }
      rmdirSync(TEST_DIR);
    }
  } catch { }
}

describe('manifest', () => {
  afterEach(cleanup);

  describe('read_package_json', () => {
    it('reads package.json dependencies', async () => {
      const { read_package_json } = await import('../src/manifest.js');
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(join(TEST_DIR, 'package.json'), JSON.stringify({
        dependencies: { ws: '^8.0.0', redis: '^4.0.0' },
        devDependencies: { jest: '^29.0.0' },
      }));
      const result = read_package_json(join(TEST_DIR, 'package.json'));
      expect(result).toContain('ws');
      expect(result).toContain('redis');
      expect(result).toContain('jest');
    });

    it('skips scoped packages', async () => {
      const { read_package_json } = await import('../src/manifest.js');
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(join(TEST_DIR, 'package.json'), JSON.stringify({
        dependencies: { '@types/node': '^20.0.0', ws: '^8.0.0' },
      }));
      const result = read_package_json(join(TEST_DIR, 'package.json'));
      expect(result).toContain('ws');
      expect(result).not.toContain('@types/node');
    });

    it('returns empty for nonexistent file', async () => {
      const { read_package_json } = await import('../src/manifest.js');
      const result = read_package_json('/nonexistent.json');
      expect(result).toEqual([]);
    });

    it('returns empty for invalid JSON', async () => {
      const { read_package_json } = await import('../src/manifest.js');
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(join(TEST_DIR, 'bad.json'), 'not json');
      const result = read_package_json(join(TEST_DIR, 'bad.json'));
      expect(result).toEqual([]);
    });
  });

  describe('read_requirements_txt', () => {
    it('reads requirements.txt', async () => {
      const { read_requirements_txt } = await import('../src/manifest.js');
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(join(TEST_DIR, 'requirements.txt'), 'fastapi>=0.110.0\nredis==4.0.0\nws~=8.0.0\n');
      const result = read_requirements_txt(join(TEST_DIR, 'requirements.txt'));
      expect(result).toContain('fastapi');
      expect(result).toContain('redis');
      expect(result).toContain('ws');
    });

    it('strips version specifiers', async () => {
      const { read_requirements_txt } = await import('../src/manifest.js');
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(join(TEST_DIR, 'requirements.txt'), 'fastapi==0.110.0\nsqlalchemy>=1.4.0,<2.0.0\n');
      const result = read_requirements_txt(join(TEST_DIR, 'requirements.txt'));
      expect(result).toContain('fastapi');
      expect(result).toContain('sqlalchemy');
    });

    it('skips comments and empty lines', async () => {
      const { read_requirements_txt } = await import('../src/manifest.js');
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(join(TEST_DIR, 'requirements.txt'), '# comment\nfastapi>=0.110.0\n\nredis==4.0.0\n');
      const result = read_requirements_txt(join(TEST_DIR, 'requirements.txt'));
      expect(result).toContain('fastapi');
      expect(result).toContain('redis');
      expect(result).not.toContain('comment');
    });

    it('returns empty for nonexistent file', async () => {
      const { read_requirements_txt } = await import('../src/manifest.js');
      const result = read_requirements_txt('/nonexistent.txt');
      expect(result).toEqual([]);
    });
  });

  describe('read_pyproject_toml', () => {
    it('reads pyproject.toml dependencies', async () => {
      const { read_pyproject_toml } = await import('../src/manifest.js');
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(join(TEST_DIR, 'pyproject.toml'), `
[project]
dependencies = [
    "fastapi>=0.110.0",
    "redis>=4.0.0",
]
`);
      const result = read_pyproject_toml(join(TEST_DIR, 'pyproject.toml'));
      expect(result).toContain('fastapi');
      expect(result).toContain('redis');
    });

    it('returns empty for nonexistent file', async () => {
      const { read_pyproject_toml } = await import('../src/manifest.js');
      const result = read_pyproject_toml('/nonexistent.toml');
      expect(result).toEqual([]);
    });
  });

  describe('read_cargo_toml', () => {
    it('reads Cargo.toml dependencies', async () => {
      const { read_cargo_toml } = await import('../src/manifest.js');
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(join(TEST_DIR, 'Cargo.toml'), `
[dependencies]
serde = "1.0"
tokio = { version = "1.0", features = ["full"] }
`);
      const result = read_cargo_toml(join(TEST_DIR, 'Cargo.toml'));
      expect(result).toContain('serde');
      expect(result).toContain('tokio');
    });

    it('returns empty for nonexistent file', async () => {
      const { read_cargo_toml } = await import('../src/manifest.js');
      const result = read_cargo_toml('/nonexistent.toml');
      expect(result).toEqual([]);
    });
  });

  describe('read_go_mod', () => {
    it('reads go.mod require block', async () => {
      const { read_go_mod } = await import('../src/manifest.js');
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(join(TEST_DIR, 'go.mod'), `
module myapp

go 1.21

require (
    github.com/redis/go-redis/v9 v9.0.0
    github.com/valyala/fasthttp v1.0.0
)
`);
      const result = read_go_mod(join(TEST_DIR, 'go.mod'));
      expect(result.length).toBeGreaterThan(0);
    });

    it('returns empty for nonexistent file', async () => {
      const { read_go_mod } = await import('../src/manifest.js');
      const result = read_go_mod('/nonexistent.mod');
      expect(result).toEqual([]);
    });
  });

  describe('read_project_manifest', () => {
    it('returns empty when no manifest exists', async () => {
      const { read_project_manifest } = await import('../src/manifest.js');
      mkdirSync(TEST_DIR, { recursive: true });
      const result = await read_project_manifest(TEST_DIR);
      expect(result).toEqual([]);
    });

    it('package.json takes precedence', async () => {
      const { read_project_manifest } = await import('../src/manifest.js');
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(join(TEST_DIR, 'package.json'), '{"dependencies": {"ws": "^8.0.0"}}');
      writeFileSync(join(TEST_DIR, 'requirements.txt'), 'fastapi>=0.110.0');
      const result = await read_project_manifest(TEST_DIR);
      expect(result).toEqual(['ws']);
    });
  });
});
