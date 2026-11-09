import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

// The project URL is not a secret and is already present as VITE_SUPABASE_URL
// in the root .env — fall back to it so local setups only need to add the
// service-role key. The service-role key has NO fallback on purpose.
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;

const supabaseAdmin = (SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth:     { persistSession: false },
      realtime: { transport: ws },
    })
  : null;

export { supabaseAdmin };
