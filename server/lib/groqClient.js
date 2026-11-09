/**
 * Lazy Groq client singleton.
 *
 * The AI routes used to instantiate Groq at MODULE level, which made the whole
 * server crash on boot when GROQ_API_KEY was absent — contradicting index.js's
 * startup warning ("GROQ_API_KEY is not set — AI routes will fail"), which
 * assumes the server still runs. With this helper the server always boots;
 * AI routes fail individually with a clear 503 when the key is missing.
 */

import Groq from 'groq-sdk';

const clients = new Map(); // timeout → client

export function getGroq(timeout = 30_000) {
  if (!process.env.GROQ_API_KEY) {
    const err = new Error('GROQ_API_KEY is not configured on the server');
    err.status = 503;
    throw err;
  }
  if (!clients.has(timeout)) {
    clients.set(timeout, new Groq({ apiKey: process.env.GROQ_API_KEY, timeout }));
  }
  return clients.get(timeout);
}
