import { describe, it, expect, vi } from 'vitest';
import { groqJsonCall } from './groqJson.js';

const completionWith = (content) => ({ choices: [{ message: { content } }] });
const clientOf = (create) => ({ chat: { completions: { create } } });

const baseOpts = {
  model: 'primary-model',
  maxTokens: 1000,
  messages: [{ role: 'user', content: 'hi' }],
  label: 'test',
};

describe('groqJsonCall', () => {
  it('returns the parsed object for clean JSON content', async () => {
    const create = vi.fn().mockResolvedValue(completionWith('{"transactions":[{"type":"BUY"}]}'));
    const out = await groqJsonCall({ ...baseOpts, client: clientOf(create) });
    expect(out).toEqual({ transactions: [{ type: 'BUY' }] });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({
      model: 'primary-model',
      max_tokens: 1000,
      response_format: { type: 'json_object' },
    });
  });

  it('recovers fenced / truncated content via the tolerant parser', async () => {
    const fenced = '```json\n{"transactions":[{"type":"SELL"}]}\n```';
    const out = await groqJsonCall({ ...baseOpts, client: clientOf(vi.fn().mockResolvedValue(completionWith(fenced))) });
    expect(out).toEqual({ transactions: [{ type: 'SELL' }] });

    const truncated = '{"transactions":[{"type":"BUY"},{"type":"SE';
    const out2 = await groqJsonCall({ ...baseOpts, client: clientOf(vi.fn().mockResolvedValue(completionWith(truncated))) });
    expect(out2).toEqual({ transactions: [{ type: 'BUY' }] });
  });

  it('retries once after a 429 honouring retry-after', async () => {
    const err429 = Object.assign(new Error('rate limited'), {
      status: 429,
      headers: { 'retry-after': '0.01' },
    });
    const create = vi.fn()
      .mockRejectedValueOnce(err429)
      .mockResolvedValueOnce(completionWith('{"transactions":[]}'));
    const out = await groqJsonCall({ ...baseOpts, client: clientOf(create) });
    expect(out).toEqual({ transactions: [] });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('salvages complete rows from a json_validate_failed error', async () => {
    const err = Object.assign(new Error('json validate failed'), {
      status: 400,
      error: { error: {
        code: 'json_validate_failed',
        failed_generation: '{"transactions":[{"type":"BUY","isin":"US1"},{"type":"SELL","isi',
      } },
    });
    const out = await groqJsonCall({ ...baseOpts, client: clientOf(vi.fn().mockRejectedValue(err)) });
    expect(out).toEqual({ transactions: [{ type: 'BUY', isin: 'US1' }] });
  });

  it('falls back to the secondary model when the primary is decommissioned', async () => {
    const gone = Object.assign(new Error('model gone'), {
      status: 400,
      error: { error: { code: 'model_decommissioned' } },
    });
    const create = vi.fn()
      .mockRejectedValueOnce(gone)
      .mockResolvedValueOnce(completionWith('{"transactions":[]}'));
    const out = await groqJsonCall({ ...baseOpts, fallbackModel: 'backup-model', client: clientOf(create) });
    expect(out).toEqual({ transactions: [] });
    expect(create.mock.calls[1][0].model).toBe('backup-model');
  });

  it('re-throws unrecoverable errors for the caller to decide', async () => {
    const boom = Object.assign(new Error('upstream exploded'), { status: 500 });
    await expect(groqJsonCall({ ...baseOpts, client: clientOf(vi.fn().mockRejectedValue(boom)) }))
      .rejects.toThrow('upstream exploded');
  });

  it('returns null when the content is beyond salvage', async () => {
    const out = await groqJsonCall({ ...baseOpts, client: clientOf(vi.fn().mockResolvedValue(completionWith('sorry, I cannot'))) });
    expect(out).toBeNull();
  });
});
