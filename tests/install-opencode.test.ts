import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  mergeMcpEntry,
  mergeTuiPluginEntry,
  removeMcpEntry,
  removeTuiPluginEntry,
} from '../src/admin.js';

const pluginRelPath = './tui/wevibe.tsx';
const adminScript = '/abs/wevibe-mcp/dist/admin.js';
const serverScript = '/abs/wevibe-mcp/dist/server.js';

describe('install-opencode merge helpers', () => {
  it('mergeTuiPluginEntry adds WeVibe plugin and preserves other keys/plugins', () => {
    const existing = {
      '$schema': 'https://opencode.ai/tui.json',
      theme: 'dark',
      plugin: [['./tui/other.tsx', { demo: true }]],
    } as Record<string, unknown>;

    const merged = mergeTuiPluginEntry(existing, pluginRelPath, { adminScript, node: 'node' });

    expect((merged.plugin as unknown[]).length).toBe(2);
    expect((merged.plugin as unknown[])[0]).toEqual(['./tui/other.tsx', { demo: true }]);
    expect((merged.plugin as unknown[])[1]).toEqual([
      pluginRelPath,
      { adminScript, node: 'node' },
    ]);
    expect(merged.theme).toBe('dark');
    expect(merged['$schema']).toBe('https://opencode.ai/tui.json');
  });

  it('mergeTuiPluginEntry updates existing WeVibe options in-place', () => {
    const existing = {
      '$schema': 'https://opencode.ai/tui.json',
      plugin: [
        [pluginRelPath, { adminScript: '/old/admin.js', node: '/usr/bin/node' }],
        ['./tui/other.tsx', { keep: 'me' }],
      ],
      extra: { untouched: true },
    } as Record<string, unknown>;

    const merged = mergeTuiPluginEntry(existing, pluginRelPath, { adminScript, node: 'node' });
    const mergedPlugins = merged.plugin as unknown[];

    expect(mergedPlugins[0]).toEqual([pluginRelPath, { adminScript, node: 'node' }]);
    expect(mergedPlugins[1]).toEqual(['./tui/other.tsx', { keep: 'me' }]);
    expect(merged.extra).toEqual({ untouched: true });
  });

  it('removeTuiPluginEntry removes only the WeVibe plugin tuple', () => {
    const existing = {
      plugin: [
        [pluginRelPath, { adminScript, node: 'node' }],
        ['./tui/other.tsx', { enabled: true }],
      ],
      keep: 'value',
    } as Record<string, unknown>;

    const removed = removeTuiPluginEntry(existing, pluginRelPath);
    expect(removed.plugin).toEqual([['./tui/other.tsx', { enabled: true }]]);
    expect(removed.keep).toBe('value');
  });

  it('mergeMcpEntry sets mcp.wevibe while preserving other mcp/top-level keys', () => {
    const existing = {
      '$schema': 'https://opencode.ai/config.json',
      providers: {
        anthropic: { apiKey: 'env:ANTHROPIC_API_KEY' },
      },
      mcp: {
        other: {
          type: 'local',
          command: ['node', '/tmp/other.js'],
          enabled: true,
        },
      },
    } as Record<string, unknown>;

    const merged = mergeMcpEntry(existing, 'node', serverScript);
    const mcp = merged.mcp as Record<string, unknown>;

    expect(mcp.other).toEqual({
      type: 'local',
      command: ['node', '/tmp/other.js'],
      enabled: true,
    });
    expect(mcp.wevibe).toEqual({
      type: 'local',
      command: ['node', serverScript],
      enabled: true,
    });
    expect(merged.providers).toEqual({
      anthropic: { apiKey: 'env:ANTHROPIC_API_KEY' },
    });
  });

  it('removeMcpEntry removes mcp.wevibe and preserves sibling servers/keys', () => {
    const existing = {
      providers: {
        openai: { apiKey: 'env:OPENAI_API_KEY' },
      },
      mcp: {
        wevibe: {
          type: 'local',
          command: ['node', serverScript],
          enabled: true,
        },
        other: {
          type: 'local',
          command: ['node', '/tmp/other.js'],
          enabled: false,
        },
      },
    } as Record<string, unknown>;

    const removed = removeMcpEntry(existing);
    expect((removed.mcp as Record<string, unknown>).other).toEqual({
      type: 'local',
      command: ['node', '/tmp/other.js'],
      enabled: false,
    });
    expect((removed.mcp as Record<string, unknown>).wevibe).toBeUndefined();
    expect(removed.providers).toEqual({
      openai: { apiKey: 'env:OPENAI_API_KEY' },
    });
  });

  it('merge helpers are idempotent at object level', () => {
    const baseTui = {
      '$schema': 'https://opencode.ai/tui.json',
      plugin: [['./tui/other.tsx', { demo: true }]],
    } as Record<string, unknown>;
    const mergedTui = mergeTuiPluginEntry(baseTui, pluginRelPath, { adminScript, node: 'node' });
    const mergedTuiAgain = mergeTuiPluginEntry(mergedTui, pluginRelPath, { adminScript, node: 'node' });
    expect(mergedTuiAgain).toEqual(mergedTui);

    const baseMcp = {
      '$schema': 'https://opencode.ai/config.json',
      mcp: {
        other: {
          type: 'local',
          command: ['node', '/tmp/other.js'],
          enabled: true,
        },
      },
    } as Record<string, unknown>;
    const mergedMcp = mergeMcpEntry(baseMcp, 'node', serverScript);
    const mergedMcpAgain = mergeMcpEntry(mergedMcp, 'node', serverScript);
    expect(mergedMcpAgain).toEqual(mergedMcp);
  });

  it('preserves pre-existing opencode config blocks from a temp --config-dir fixture', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-oc-'));
    try {
      const opencodePath = path.join(configDir, 'opencode.json');
      const seeded = {
        '$schema': 'https://opencode.ai/config.json',
        providers: {
          anthropic: { apiKey: 'env:ANTHROPIC_API_KEY' },
        },
        mcp: {
          other: {
            type: 'local',
            command: ['node', '/tmp/other.js'],
            enabled: true,
          },
        },
      };
      fs.writeFileSync(opencodePath, JSON.stringify(seeded, null, 2));

      const parsed = JSON.parse(fs.readFileSync(opencodePath, 'utf8')) as Record<string, unknown>;
      const merged = mergeMcpEntry(parsed, 'node', serverScript);
      const mergedMcp = merged.mcp as Record<string, unknown>;

      expect(merged.providers).toEqual(seeded.providers);
      expect(mergedMcp.other).toEqual(seeded.mcp.other);
      expect(mergedMcp.wevibe).toEqual({
        type: 'local',
        command: ['node', serverScript],
        enabled: true,
      });
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});
