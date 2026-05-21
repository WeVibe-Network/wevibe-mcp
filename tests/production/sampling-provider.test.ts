import { describe, it, expect, vi } from 'vitest';
import { createSamplingProvider } from '../../src/llm-sampling.js';

function createMockServer(response: { type: string; text: string }) {
  return {
    createMessage: vi.fn().mockResolvedValue({
      content: response,
    }),
  };
}

describe('MCP sampling provider', () => {
  it('creates a provider that implements LlmProvider', () => {
    const mockServer = createMockServer({ type: 'text', text: 'response' });
    const provider = createSamplingProvider(mockServer as any);
    expect(typeof provider.chat).toBe('function');
  });

  it('chat returns text from server response', async () => {
    const mockServer = createMockServer({ type: 'text', text: '{"keywords": []}' });
    const provider = createSamplingProvider(mockServer as any);
    const result = await provider.chat('system prompt', 'user message');
    expect(result).toBe('{"keywords": []}');
  });

  it('chat passes system prompt and user message to server', async () => {
    const mockServer = createMockServer({ type: 'text', text: 'ok' });
    const provider = createSamplingProvider(mockServer as any);
    await provider.chat('my system prompt', 'my user message');
    
    expect(mockServer.createMessage).toHaveBeenCalledTimes(1);
    const callArgs = mockServer.createMessage.mock.calls[0][0];
    expect(callArgs.systemPrompt).toBe('my system prompt');
    const userMsg = callArgs.messages.find((m: any) => m.role === 'user');
    expect(userMsg).toBeDefined();
  });

  it('chat passes maxTokens from options', async () => {
    const mockServer = createMockServer({ type: 'text', text: 'ok' });
    const provider = createSamplingProvider(mockServer as any);
    await provider.chat('sys', 'user', { maxTokens: 2048 });
    
    const callArgs = mockServer.createMessage.mock.calls[0][0];
    expect(callArgs.maxTokens).toBe(2048);
  });

  it('chat throws on non-text response', async () => {
    const mockServer = {
      createMessage: vi.fn().mockResolvedValue({
        content: { type: 'image', data: 'base64...' },
      }),
    };
    const provider = createSamplingProvider(mockServer as any);
    await expect(provider.chat('sys', 'user')).rejects.toThrow();
  });

  it('chat propagates server errors', async () => {
    const mockServer = {
      createMessage: vi.fn().mockRejectedValue(new Error('sampling not supported')),
    };
    const provider = createSamplingProvider(mockServer as any);
    await expect(provider.chat('sys', 'user')).rejects.toThrow('sampling not supported');
  });
});