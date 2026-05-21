import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setLlmProvider, getLlmProvider, hasLlmProvider } from '../src/llm.js';
import type { LlmProvider, LlmChatOptions } from '../src/llm.js';

describe('LLM provider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('setLlmProvider', () => {
    it('sets a provider that can be retrieved', () => {
      const mock: LlmProvider = { chat: async () => 'response' };
      setLlmProvider(mock);
      expect(hasLlmProvider()).toBe(true);
    });
  });

  describe('hasLlmProvider', () => {
    it('returns true when provider is set', () => {
      const mock: LlmProvider = { chat: async () => 'response' };
      setLlmProvider(mock);
      expect(hasLlmProvider()).toBe(true);
    });
  });

  describe('LlmProvider.chat via getLlmProvider', () => {
    it('getLlmProvider returns the set provider and chat works', async () => {
      setLlmProvider({
        chat: async () => JSON.stringify({ keywords: [{ term: 'test', weight: 50 }] }),
      });
      const provider = getLlmProvider();
      const result = await provider.chat('system prompt', 'user message');
      expect(result).toContain('keywords');
      expect(JSON.parse(result).keywords[0].term).toBe('test');
    });

    it('getLlmProvider passes parameters through to provider', async () => {
      let capturedSystem = '';
      let capturedUser = '';
      let capturedOptions: any = null;
      setLlmProvider({
        chat: async (sys, user, opts) => {
          capturedSystem = sys;
          capturedUser = user;
          capturedOptions = opts;
          return 'ok';
        },
      });
      await getLlmProvider().chat('test system', 'test user', { temperature: 0.5, jsonFormat: true });
      expect(capturedSystem).toBe('test system');
      expect(capturedUser).toBe('test user');
      expect(capturedOptions?.temperature).toBe(0.5);
      expect(capturedOptions?.jsonFormat).toBe(true);
    });

    it('getLlmProvider propagates provider errors', async () => {
      setLlmProvider({
        chat: async () => { throw new Error('provider error'); },
      });
      await expect(getLlmProvider().chat('sys', 'user')).rejects.toThrow('provider error');
    });

    it('hasLlmProvider reflects configured state', () => {
      expect(typeof hasLlmProvider).toBe('function');
    });
  });
});