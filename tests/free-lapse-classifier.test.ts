import { describe, expect, it } from 'vitest';

import {
  classifyFreeModelLapse,
  LlmHttpError,
  stripFreeSuffix,
} from '../src/llm-openai-compat.js';

describe('stripFreeSuffix', () => {
  it('removes :free suffix and keeps non-free slugs untouched', () => {
    expect(stripFreeSuffix('deepseek/deepseek-r1:free')).toBe('deepseek/deepseek-r1');
    expect(stripFreeSuffix('deepseek/deepseek-r1:FREE')).toBe('deepseek/deepseek-r1');
    expect(stripFreeSuffix('openai/gpt-4.1-mini')).toBe('openai/gpt-4.1-mini');
  });
});

describe('classifyFreeModelLapse', () => {
  it('classifies a 404 no-endpoints response for :free models as lapsed', () => {
    const result = classifyFreeModelLapse(
      new LlmHttpError(404, 'no endpoints found for x/y:free'),
      'x/y:free',
    );

    expect(result.lapsed).toBe(true);
    expect(result.proposed_paid_slug).toBe('x/y');
  });

  it('classifies any 404 on :free models as lapsed even with unrelated body', () => {
    const result = classifyFreeModelLapse(
      new LlmHttpError(404, 'upstream responded with unknown route signature'),
      'x/y:free',
    );

    expect(result).toMatchObject({
      lapsed: true,
      http_status: 404,
      proposed_paid_slug: 'x/y',
    });
  });

  it('does not classify a non-:free 404 as lapsed', () => {
    const result = classifyFreeModelLapse(
      new LlmHttpError(404, 'no endpoints found for x/y'),
      'x/y',
    );

    expect(result).toEqual({ lapsed: false });
  });

  it('does not classify timeout-like 500 responses on :free models as lapsed', () => {
    const result = classifyFreeModelLapse(
      new LlmHttpError(500, 'gateway timeout while contacting upstream provider'),
      'x/y:free',
    );

    expect(result).toEqual({ lapsed: false });
  });

  it('does not classify generic non-HTTP errors as lapsed', () => {
    const result = classifyFreeModelLapse(new Error('timeout'), 'x/y:free');

    expect(result).toEqual({ lapsed: false });
  });
});
