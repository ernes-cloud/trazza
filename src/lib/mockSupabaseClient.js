import * as demoData from './demoData';

/**
 * Datasets del modo demo. `default` es la demo pública de "Explorar demo";
 * `demoSample` es la cuenta del tutorial en vídeo (nómina 1.800 € y una cartera
 * montada para explicar el rebalanceo). Son dos mundos separados: cambiar uno
 * no toca al otro.
 */
const PERSONAS = {
  default: () => ({
    brokers: demoData.DEMO_BROKERS,
    positions: demoData.DEMO_POSITIONS,
    assets: demoData.DEMO_ASSETS,
    transactions: demoData.DEMO_TRANSACTIONS,
    portfolios: demoData.DEMO_PORTFOLIOS,
    user_preferences: demoData.DEMO_PREFERENCES ? [demoData.DEMO_PREFERENCES] : [],
    watchlists: demoData.DEMO_WATCHLISTS || [],
    watchlist_items: demoData.DEMO_WATCHLIST_ITEMS || [],
    expense_entries: demoData.DEMO_EXPENSE_ENTRIES || [],
    savings_goals: demoData.DEMO_SAVINGS_GOALS || [],
    expense_projects: demoData.DEMO_EXPENSE_PROJECTS || [],
  }),
  demoSample: () => ({
    brokers: demoData.DEMO_SAMPLE_BROKERS,
    positions: demoData.DEMO_SAMPLE_POSITIONS,
    assets: demoData.DEMO_SAMPLE_ASSETS,
    transactions: demoData.DEMO_SAMPLE_TRANSACTIONS,
    portfolios: demoData.DEMO_SAMPLE_PORTFOLIOS,
    user_preferences: [demoData.DEMO_SAMPLE_PREFERENCES],
    watchlists: demoData.DEMO_SAMPLE_WATCHLISTS || [],
    watchlist_items: demoData.DEMO_SAMPLE_WATCHLIST_ITEMS || [],
    expense_entries: demoData.DEMO_SAMPLE_EXPENSE_ENTRIES || [],
    savings_goals: demoData.DEMO_SAMPLE_SAVINGS_GOALS || [],
    expense_projects: [],
  }),
  // Cuenta recién creada: sin brokers, sin posiciones y sin preferencias. La
  // usa el smoke E2E del onboarding (e2e/onboarding.smoke.mjs) para recorrer
  // lo que ve un usuario nuevo; la demo pública nunca la carga.
  empty: () => ({
    brokers: [], positions: [], assets: [], transactions: [], portfolios: [],
    user_preferences: [], watchlists: [], watchlist_items: [],
    expense_entries: [], savings_goals: [], expense_projects: [],
  }),
};

const readPersona = () => {
  try { return localStorage.getItem('trazza_demo_persona') || 'default'; } catch { return 'default'; }
};

// Centralized store for demo data to allow mutations during the session.
// `portfolio_shares` va vacía pero DECLARADA: una tabla ausente devuelve
// `error: 'Table X not found in demo store'`, y desde que SharePortfolioModal
// dejó de tragarse ese error (revocar no puede fallar en silencio) eso pintaba
// un toast destructivo al abrir "Compartir cartera" en la demo pública.
// Declarada, la demo se comporta como una cuenta sin enlaces y crear uno
// funciona de verdad contra el store.
// Lo mismo con `imported_data`: la consultan Dashboard, brokers y el widget de
// dividendos; sin declararla, el widget (que ya no se traga el error) decía "No
// disponible" en lo cobrado de la demo.
// Y `ticker_mappings` / `portfolio_metrics_cache`: brokers las lee y escribe en
// cada carga, y ausentes llenaban la consola de la demo de avisos.
// `blog_posts` (vacía): el blog lee `publicSupabase`, que solo cae aquí cuando
// no hay credenciales (build en casa); ausente, /blog pintaba el error de carga
// y el prerender se quedaba en 16/17.
const DEMO_STORE = { watchlist_alerts: [], notifications: [], portfolio_shares: [], imported_data: [], ticker_mappings: [], portfolio_metrics_cache: [], blog_posts: [] };

/**
 * (Re)carga el store con la persona indicada. Se llama al iniciar sesión —
 * NO en la carga del módulo — porque la sesión demo no sobrevive a un reload:
 * si dependiéramos de leer el flag al importar, el cambio de persona exigiría
 * recargar la página y eso cerraría la sesión.
 */
export function applyDemoPersona(persona = readPersona()) {
  const build = PERSONAS[persona] || PERSONAS.default;
  const data = build();
  for (const [table, rows] of Object.entries(data)) DEMO_STORE[table] = rows.map((r) => ({ ...r }));
  DEMO_STORE.watchlist_alerts = [];
  // Cambiar de persona no arrastra los enlaces creados con la anterior.
  DEMO_STORE.portfolio_shares = [];
  try { localStorage.setItem('trazza_demo_persona', persona); } catch { /* modo privado */ }
}

/** Usuario que corresponde a la persona cargada (solo se usa si no hay credenciales reales). */
const currentDemoUser = () => (readPersona() === 'demoSample' ? demoData.DEMO_SAMPLE_USER : demoData.DEMO_USER);

applyDemoPersona();

/**
 * Mock Supabase Client for Interactive Demo Mode.
 * Simulates the Supabase JS client API using in-memory data.
 */
class MockSupabaseQueryBuilder {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.sorts = [];
    this.limitCount = null;
    this.rangeFrom = null;
    this.rangeTo = null;
    this.mutationAction = null; // { type: 'insert'|'update'|'delete'|'upsert', data: any }
  }

  select(columns = '*') {
    return this;
  }

  eq(column, value) {
    this.filters.push(item => {
      if (column.includes('.')) {
        const [parent, child] = column.split('.');
        return item[parent] && item[parent][child] === value;
      }
      return item[column] === value;
    });
    return this;
  }

  in(column, values) {
    // `ticker` casa por lower(btrim), la misma clave que ensure_asset: la demo
    // y los tests reencuentran tickers legados con espacios u otro casing.
    const tickerKeys = column === 'ticker'
      ? new Set(values.map((v) => String(v ?? '').trim().toLowerCase()))
      : null;
    this.filters.push(item => {
      if (column.includes('.')) {
        const [parent, child] = column.split('.');
        return item[parent] && values.includes(item[parent][child]);
      }
      if (tickerKeys) return tickerKeys.has(String(item.ticker ?? '').trim().toLowerCase());
      return values.includes(item[column]);
    });
    return this;
  }

  /**
   * Comparadores de PostgREST. Faltaban y la consulta de notificaciones
   * (`.gt('created_at', …)`) lanzaba "…is not a function" en CADA carga del
   * modo demo — invisible en la UI pero un error rojo en la consola.
   */
  gt(column, value)  { this.filters.push((i) => i[column] > value);  return this; }
  gte(column, value) { this.filters.push((i) => i[column] >= value); return this; }
  lt(column, value)  { this.filters.push((i) => i[column] < value);  return this; }
  lte(column, value) { this.filters.push((i) => i[column] <= value); return this; }
  neq(column, value) { this.filters.push((i) => i[column] !== value); return this; }
  is(column, value)  { this.filters.push((i) => (i[column] ?? null) === value); return this; }

  order(column, { ascending = true } = {}) {
    this.sorts.push((a, b) => {
      if (a[column] < b[column]) return ascending ? -1 : 1;
      if (a[column] > b[column]) return ascending ? 1 : -1;
      return 0;
    });
    return this;
  }

  limit(count) {
    this.limitCount = count;
    return this;
  }

  /**
   * PostgREST-style inclusive range, used by the paginated readers (e.g.
   * useExpenseEntries, which pages `expense_entries` so a project-level
   * `max-rows` never truncates totals in silence). Without it the demo client
   * threw "…is not a function" and took the whole screen down.
   */
  range(from, to) {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  maybeSingle() {
    return this.then(result => ({ 
      data: result.data.length > 0 ? result.data[0] : null, 
      error: result.error 
    }));
  }

  single() {
    return this.then(result => {
      if (result.data.length === 0) return { data: null, error: { message: 'Not found' } };
      return { data: result.data[0], error: result.error };
    });
  }

  // Mutations - these return 'this' to allow chaining filters like .eq()
  insert(data) {
    this.mutationAction = { type: 'insert', data };
    return this;
  }

  update(data) {
    this.mutationAction = { type: 'update', data };
    return this;
  }

  upsert(data, options = {}) {
    this.mutationAction = { type: 'upsert', data, options };
    return this;
  }

  delete() {
    this.mutationAction = { type: 'delete' };
    return this;
  }

  async _execute() {
    if (!DEMO_STORE[this.table]) {
      return { data: [], error: { message: `Table ${this.table} not found in demo store` } };
    }

    // Execution logic for mutations
    if (this.mutationAction) {
      const { type, data } = this.mutationAction;
      
      if (type === 'insert') {
        const rows = Array.isArray(data) ? data : [data];
        const created = rows.map(r => ({ 
          id: `demo-${Math.random().toString(36).slice(2, 9)}`,
          created_at: new Date().toISOString(),
          ...r 
        }));
        DEMO_STORE[this.table].push(...created);
        return { data: created, error: null };
      }

      if (type === 'update') {
        const affected = [];
        DEMO_STORE[this.table] = DEMO_STORE[this.table].map(item => {
          if (this.filters.every(f => f(item))) {
            const updated = { ...item, ...data };
            affected.push(updated);
            return updated;
          }
          return item;
        });
        return { data: affected, error: null };
      }

      if (type === 'delete') {
        const toDelete = DEMO_STORE[this.table].filter(item => this.filters.every(f => f(item)));
        DEMO_STORE[this.table] = DEMO_STORE[this.table].filter(item => !this.filters.every(f => f(item)));
        return { data: toDelete, error: null };
      }

      if (type === 'upsert') {
        const rows = Array.isArray(data) ? data : [data];
        const affected = [];
        for (const row of rows) {
          const onConflict = this.mutationAction.options.onConflict || 'id';
          const existingIdx = DEMO_STORE[this.table].findIndex(item => item[onConflict] === row[onConflict]);
          if (existingIdx >= 0) {
            DEMO_STORE[this.table][existingIdx] = { ...DEMO_STORE[this.table][existingIdx], ...row };
            affected.push(DEMO_STORE[this.table][existingIdx]);
          } else {
            const created = { 
              id: row.id || `demo-${Math.random().toString(36).slice(2, 9)}`,
              created_at: new Date().toISOString(),
              ...row 
            };
            DEMO_STORE[this.table].push(created);
            affected.push(created);
          }
        }
        return { data: affected, error: null };
      }
    }

    // Default: Select
    let result = [...DEMO_STORE[this.table]];

    // Basic Join simulation - MUST happen before filters for related table filtering to work
    if (this.table === 'positions') {
      result = result.map(pos => ({
        ...pos,
        assets: DEMO_STORE.assets.find(a => a.id === pos.asset_id),
        brokers: DEMO_STORE.brokers.find(b => b.id === pos.broker_id)
      }));
    } else if (this.table === 'transactions') {
      result = result.map(tx => {
        const pos = DEMO_STORE.positions.find(p => p.id === tx.position_id);
        return {
          ...tx,
          positions: pos ? {
            ...pos,
            assets: DEMO_STORE.assets.find(a => a.id === pos.asset_id)
          } : null
        };
      });
    }

    // Apply filters
    for (const filter of this.filters) {
      result = result.filter(filter);
    }

    // Apply sorts
    for (const sort of this.sorts) {
      result.sort(sort);
    }

    // Apply limit
    if (this.limitCount !== null) {
      result = result.slice(0, this.limitCount);
    }

    // Apply range (inclusive on both ends, like PostgREST)
    if (this.rangeFrom !== null) {
      result = result.slice(this.rangeFrom, this.rangeTo + 1);
    }

    return { data: result, error: null };
  }

  async then(onfulfilled, onrejected) {
    try {
      const result = await this._execute();
      return onfulfilled ? onfulfilled(result) : result;
    } catch (err) {
      if (onrejected) return onrejected(err);
      throw err;
    }
  }
}

const mockSupabase = {
  auth: {
    async getSession() {
      const isDemo = localStorage.getItem('trazza_demo_mode') === 'true';
      if (isDemo) {
        return { data: { session: { user: currentDemoUser() } }, error: null };
      }
      return { data: { session: null }, error: null };
    },
    onAuthStateChange(callback) {
      const isDemo = localStorage.getItem('trazza_demo_mode') === 'true';
      if (isDemo) {
        setTimeout(() => callback('SIGNED_IN', { user: currentDemoUser() }), 0);
      }
      return { data: { subscription: { unsubscribe: () => {} } } };
    },
    async signInWithPassword() {
      return { data: { user: null }, error: { message: 'Demo mode only' } };
    },
    // La bienvenida guarda su marca en los metadatos de la cuenta.
    async updateUser({ data } = {}) {
      return { data: { user: { ...currentDemoUser(), user_metadata: { ...(data || {}) } } }, error: null };
    },
    async signOut() {
      localStorage.removeItem('trazza_demo_mode');
      return { error: null };
    }
  },

  from(table) {
    return new MockSupabaseQueryBuilder(table);
  },

  /**
   * Database RPCs. Without this the demo threw "supabase.rpc is not a function"
   * on the FIRST price refresh, which aborted refreshPrices before it could push
   * the live prices into state — the brokers screen then stayed on the seeded
   * prices forever while the Dashboard showed live ones, i.e. the very
   * cross-screen mismatch this client is used to reproduce.
   *
   * Writes land in DEMO_STORE so the demo behaves like the real thing; unknown
   * RPC names resolve to a harmless no-op instead of throwing.
   */
  async rpc(fn, args = {}) {
    // El precio de `assets` ya no lo escribe el cliente (solo el cron del
    // server); lo que queda son metadatos que se rellenan si están vacíos.
    if (fn === 'update_asset_metadata') {
      const asset = DEMO_STORE.assets.find((a) => a.id === args.p_asset_id);
      if (!asset) return { data: false, error: null };
      const isPlaceholderName = String(asset.ticker || '').startsWith('CASH_')
        || !asset.company_name || asset.company_name === asset.isin;
      if (args.p_company_name && isPlaceholderName) asset.company_name = args.p_company_name;
      for (const col of ['isin', 'sector', 'industry', 'country', 'asset_class']) {
        if (asset[col] == null && args[`p_${col}`]) asset[col] = args[`p_${col}`];
      }
      return { data: true, error: null };
    }
    if (fn === 'ensure_asset') {
      // Misma semántica que public.ensure_asset (r17c): btrim SIN upper;
      // existente → id sin validar (exacto O lower(btrim) case-insensitive,
      // prioridad exacto); altas nuevas ≤120 sin cntrl; coalesce nombre/divisa;
      // ISIN|CASH_*; currency 3–5; ON CONFLICT DO NOTHING; precio 1 en
      // CASH_*/Cash (prefijo literal CASH_), null en el resto.
      const ticker = String(args.p_ticker || '').trim();
      if (!ticker) return { data: null, error: { message: 'ticker required' } };
      const tickerKey = ticker.toLowerCase();
      let asset = DEMO_STORE.assets.find((a) => a.ticker === ticker)
        || DEMO_STORE.assets.find((a) => String(a.ticker || '').trim().toLowerCase() === tickerKey);
      if (asset) return { data: asset.id, error: null };
      if (ticker.length > 120 || /[\u0000-\u001f\u007f]/.test(ticker)) {
        return { data: null, error: { message: 'invalid ticker' } };
      }
      let isin = args.p_isin == null || args.p_isin === ''
        ? null
        : String(args.p_isin).trim().toUpperCase();
      if (isin === '') isin = null;
      if (isin
        && !/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin)
        && !/^CASH_[A-Z0-9]{3,5}$/.test(isin)) {
        return { data: null, error: { message: 'invalid isin' } };
      }
      const companyName = (typeof args.p_company_name === 'string' && args.p_company_name.trim())
        ? args.p_company_name.trim()
        : ticker;
      const currency = (typeof args.p_currency === 'string' && args.p_currency.trim())
        ? args.p_currency.trim().toUpperCase()
        : 'USD';
      if (!/^[A-Z]{3,5}$/.test(currency)) {
        return { data: null, error: { message: 'invalid currency' } };
      }
      let assetClass = args.p_asset_class ?? null;
      let currentPrice = null;
      // Alineado con createAssets.sanitizeAssets + SQL LIKE 'CASH\_%'
      if (ticker.toUpperCase().startsWith('CASH_') || String(assetClass || '').toUpperCase() === 'CASH') {
        currentPrice = 1;
        assetClass = assetClass && String(assetClass).toUpperCase() === 'CASH' ? assetClass : 'Cash';
      }
      asset = {
        id: (globalThis.crypto?.randomUUID?.() || `demo-${Date.now()}-${DEMO_STORE.assets.length}`),
        ticker,
        company_name: companyName,
        asset_class: assetClass,
        currency,
        isin,
        current_price: currentPrice,
      };
      DEMO_STORE.assets.push(asset);
      return { data: asset.id, error: null };
    }
    if (fn === 'adjust_position_quantity') {
      const pos = DEMO_STORE.positions.find((p) => p.id === args.p_position_id);
      if (!pos) return { data: null, error: { message: 'position not found' } };
      const next = parseFloat(pos.quantity || 0) + parseFloat(args.p_delta || 0);
      pos.quantity = args.p_min_zero ? Math.max(0, next) : next;
      return { data: pos.quantity, error: null };
    }
    return { data: null, error: null };
  },
};

export default mockSupabase;
