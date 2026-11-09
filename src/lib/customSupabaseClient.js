import { createClient } from '@supabase/supabase-js';
import mockSupabase from './mockSupabaseClient';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const realSupabase = (supabaseUrl && supabaseAnonKey)
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null;

/**
 * Proxy that switches between real Supabase and Mock Supabase
 */
const customSupabaseClient = new Proxy({}, {
    get(target, prop) {
        const isDemo = localStorage.getItem('trazza_demo_mode') === 'true';
        const client = isDemo ? mockSupabase : realSupabase;
        
        if (!client) {
            // If real client is missing and not in demo mode, throw or return mock
            if (!isDemo) {
                console.error('Supabase credentials missing. Switching to demo mode for safety.');
                localStorage.setItem('trazza_demo_mode', 'true');
                return mockSupabase[prop];
            }
            return mockSupabase[prop];
        }
        
        return client[prop];
    }
});

/**
 * Cliente para contenido PÚBLICO (hoy, el blog): el real siempre que haya
 * credenciales, aunque `trazza_demo_mode` siga puesto, y el mock solo si no las
 * hay. El modo demo es una cuenta de juguete, no otra fuente para lo público:
 * por el Proxy, un visitante que salió de la demo sin cerrar sesión veía
 * "no se pudo cargar el blog" en /blog. Y, a diferencia del Proxy, no activa el
 * modo demo al leer sin credenciales.
 */
export const publicSupabase = realSupabase || mockSupabase;

export default customSupabaseClient;

export { 
    customSupabaseClient,
    customSupabaseClient as supabase,
};

