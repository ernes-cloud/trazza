/**
 * Vision diagnostic for the AI import.
 *
 * Run from the server/ folder (so dotenv picks up server/.env with GROQ_API_KEY):
 *   node scripts/check-vision.mjs                 # list models + tiny smoke test
 *   node scripts/check-vision.mjs /path/img.png   # send a REAL image file
 *
 * With a file path it sends THAT image (as a base64 data-URL, exactly like the
 * app does) to GROQ_VISION_MODEL with the real extraction instruction, and
 * prints the model's answer + token usage. That isolates whether the problem is
 * the image data, the model, or our front-end encoding.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import Groq from 'groq-sdk';
import { VISION_SYSTEM_PROMPT } from '../prompts/freeformImport.js';

const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
// Join all args so an unquoted path with spaces still works.
const filePath = process.argv.slice(2).join(' ') || undefined;

if (!process.env.GROQ_API_KEY) {
  console.error('GROQ_API_KEY missing — run this from the server/ folder so server/.env loads.');
  process.exit(1);
}

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY, timeout: 60_000 });

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
// 4×4 white PNG (1×1 is rejected by Groq as "invalid image data").
const TEST_IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAQAAABDH8tnAAAAEUlEQVR42mP8/5+hgYGBgQEAJQMD/1Y8Xc8AAAAASUVORK5CYII=';

console.log(`\nGROQ_VISION_MODEL = ${VISION_MODEL}`);

if (!filePath) {
  try {
    console.log('\n── Available models ──');
    const models = await groq.models.list();
    const ids = (models.data || []).map(m => m.id).sort();
    ids.forEach(id => console.log('  ', id));
    console.log('  GROQ_VISION_MODEL present?', ids.includes(VISION_MODEL) ? 'YES' : 'NO');
  } catch (e) { console.error('models.list failed:', e?.status, e?.message); }
}

const dataUrl = filePath
  ? `data:${MIME[extname(filePath).toLowerCase()] || 'image/png'};base64,${readFileSync(filePath).toString('base64')}`
  : TEST_IMG;

const prompt = filePath
  ? 'Read this image of a broker statement and list every transaction or holding you can see (ticker, type, quantity, price, date). If you can read ANY text, transcribe the financial rows. Answer in plain text.'
  : 'What colour is this image? Answer in one word.';

console.log(`\n── Test A: permissive prompt ${filePath ? `(${filePath}, ${dataUrl.length} chars)` : '(built-in 4×4 image)'} ──`);
try {
  const r = await groq.chat.completions.create({
    model: VISION_MODEL,
    temperature: 0,
    max_tokens: 400,
    messages: [
      { role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl } },
      ] },
    ],
  });
  console.log('  served model :', r.model);
  console.log('  usage        :', JSON.stringify(r.usage));
  console.log('  answer       :', r.choices[0]?.message?.content);
  console.log('\n  → If prompt_tokens jumps to hundreds/thousands, the image WAS ingested.');
} catch (e) {
  console.error('  vision call FAILED:', e?.status, e?.error?.error?.message || e?.message);
}

// Test B reproduces the EXACT app call (strict prompt + json mode) so we can see
// whether the prompt is what makes the app return {transactions:[]}.
if (filePath) {
  console.log('\n── Test B: EXACT app call (strict VISION_SYSTEM_PROMPT + json mode) ──');
  try {
    const r = await groq.chat.completions.create({
      model: VISION_MODEL,
      temperature: 0.1,
      max_tokens: 6000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'user', content: [
          { type: 'text', text: `${VISION_SYSTEM_PROMPT}\n\nNow read the attached image and return the JSON object.` },
          { type: 'image_url', image_url: { url: dataUrl } },
        ] },
      ],
    });
    const raw = r.choices[0]?.message?.content || '';
    let count = '?';
    try { count = (JSON.parse(raw).transactions || []).length; } catch {}
    console.log('  usage        :', JSON.stringify(r.usage));
    console.log('  rows         :', count);
    console.log('  raw          :', raw.slice(0, 600));
  } catch (e) {
    console.error('  app-call FAILED:', e?.status, e?.error?.error?.message || e?.message);
  }
}
