/**
 * Environment loading — MUST be the first import of index.js (ESM evaluates
 * imported modules before any module-level code, and adminSupabase/groqClient
 * read process.env at load time).
 *
 * Resolution is independent of the CWD the server is launched from:
 *   1. server/.env      — secrets: SUPABASE_SERVICE_ROLE_KEY, GROQ_API_KEY…
 *   2. root .env        — fallback; carries VITE_SUPABASE_URL (not a secret),
 *                         so local setups only need to add the service key.
 * dotenv never overrides variables that are already set.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(SERVER_DIR, '.env') });
dotenv.config({ path: path.join(SERVER_DIR, '..', '.env') });
