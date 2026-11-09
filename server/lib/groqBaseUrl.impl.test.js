import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { groqJsonCall } from './groqJson.js';

function startFakeGroqServer() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    res.statusCode = 403;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      error: {
        message: 'VPN blocked this request',
        type: 'invalid_request_error',
        code: 'geo_blocked',
      },
    }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr !== 'object') return reject(new Error('missing server address'));
      resolve({
        baseURL: `http://127.0.0.1:${addr.port}/openai/v1`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

describe('groq client base URL override (m-1)', () => {
  it('sends requests to GROQ_BASE_URL (fake Groq server)', async () => {
    const fake = await startFakeGroqServer();
    const prevKey = process.env.GROQ_API_KEY;
    const prevBase = process.env.GROQ_BASE_URL;
    process.env.GROQ_API_KEY = 'gsk_test_key';
    process.env.GROQ_BASE_URL = fake.baseURL;

    try {
      await expect(
        groqJsonCall({
          model: 'dummy-model',
          fallbackModel: null,
          messages: [{ role: 'user', content: 'hello' }],
          maxTokens: 16,
          timeoutMs: 3000,
          label: 'm1-groq-base-url',
        }),
      ).rejects.toMatchObject({ status: 403 });

      expect(fake.requests.length).toBeGreaterThan(0);
      expect(fake.requests[0].url).toContain('/chat/completions');
    } finally {
      if (prevKey === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = prevKey;
      if (prevBase === undefined) delete process.env.GROQ_BASE_URL;
      else process.env.GROQ_BASE_URL = prevBase;
      await fake.close();
    }
  });
});
