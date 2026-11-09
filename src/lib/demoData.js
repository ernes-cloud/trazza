/**
 * Mock data for the Interactive Demo Mode.
 * This data mimics the Supabase schema used in the platform.
 */

export const DEMO_USER = {
  id: 'demo-user-id',
  email: 'demo@example.com',
  user_metadata: {
    full_name: 'Demo User',
    avatar_url: null,
  },
  app_metadata: {
    provider: 'email',
  },
  aud: 'authenticated',
  created_at: new Date().toISOString(),
};

export const DEMO_PREFERENCES = {
  user_id: 'demo-user-id',
  dark_mode: true,
  preferred_currency: 'EUR',
  eodhd_api_key: '',
  expenses_enabled: true,
  // Gastos y ahorro: valores que hacen visible cada pieza de la pantalla —
  // presupuestos con uno ya pasado de largo (restaurantes), objetivo anual a
  // medio conseguir y un fondo de partida para el hero de ahorro acumulado.
  savings_goal_annual: 12000,
  savings_initial_balance: 4200,
  // Los tres estados de la barra a la vista: verde (holgado), ámbar (>80%,
  // vivienda) y rojo con el aviso "SUPERADO" (restaurantes).
  expense_budgets: {
    housing: 950,
    groceries: 450,
    restaurants: 60,
    transport: 90,
    leisure: 120,
  },
  custom_categories: { expense: ['Mascota'], income: [] },
};

export const DEMO_PORTFOLIOS = [
  {
    id: 'demo-portfolio-id',
    user_id: 'demo-user-id',
    name: 'Cartera Principal',
    created_at: '2023-01-01T00:00:00Z',
  }
];

export const DEMO_BROKERS = [
  { id: 'broker-degiro', user_id: 'demo-user-id', name: 'DeGiro', created_at: '2023-01-01T00:00:00Z' },
  { id: 'broker-ibkr', user_id: 'demo-user-id', name: 'Interactive Brokers', created_at: '2023-01-02T00:00:00Z' },
  { id: 'broker-binance', user_id: 'demo-user-id', name: 'Binance', created_at: '2023-01-03T00:00:00Z' },
];

export const DEMO_ASSETS = [
  { id: 'asset-aapl', ticker: 'AAPL', company_name: 'Apple Inc.', asset_class: 'Stock', currency: 'USD', current_price: 190.45, sector: 'Technology', industry: 'Consumer Electronics', country: 'USA' },
  { id: 'asset-msft', ticker: 'MSFT', company_name: 'Microsoft Corporation', asset_class: 'Stock', currency: 'USD', current_price: 420.55, sector: 'Technology', industry: 'Software—Infrastructure', country: 'USA' },
  { id: 'asset-nvda', ticker: 'NVDA', company_name: 'NVIDIA Corporation', asset_class: 'Stock', currency: 'USD', current_price: 900.20, sector: 'Technology', industry: 'Semiconductors', country: 'USA' },
  { id: 'asset-asml', ticker: 'ASML.AS', company_name: 'ASML Holding N.V.', asset_class: 'Stock', currency: 'EUR', current_price: 850.10, sector: 'Technology', industry: 'Semiconductor Equipment', country: 'Netherlands' },
  { id: 'asset-iwda', ticker: 'IWDA.AS', company_name: 'iShares Core MSCI World UCITS ETF', asset_class: 'ETF', currency: 'EUR', current_price: 88.40, sector: 'Financial Services', industry: 'Index Fund', country: 'Ireland' },
  { id: 'asset-vusa', ticker: 'VUSA.AS', company_name: 'Vanguard S&P 500 UCITS ETF', asset_class: 'ETF', currency: 'EUR', current_price: 84.15, sector: 'Financial Services', industry: 'Index Fund', country: 'Ireland' },
  { id: 'asset-btc', ticker: 'BTC-USD', company_name: 'Bitcoin USD', asset_class: 'Crypto', currency: 'USD', current_price: 65000, sector: 'Crypto', industry: 'Digital Asset', country: 'Global' },
  { id: 'asset-eur', ticker: 'CASH_EUR', company_name: 'Cash / Liquidity (EUR)', asset_class: 'Cash', currency: 'EUR', current_price: 1, sector: 'Cash', industry: 'Currency', country: 'Europe' },
  { id: 'asset-usd', ticker: 'CASH_USD', company_name: 'Cash / Liquidity (USD)', asset_class: 'Cash', currency: 'USD', current_price: 1, sector: 'Cash', industry: 'Currency', country: 'USA' },
];

export const DEMO_POSITIONS = [
  // DeGiro Positions
  { id: 'pos-1', portfolio_id: 'demo-portfolio-id', broker_id: 'broker-degiro', asset_id: 'asset-asml', quantity: 25, entry_price: 620.50, custom_classification: 'Tech', target_percentage: 15 },
  { id: 'pos-2', portfolio_id: 'demo-portfolio-id', broker_id: 'broker-degiro', asset_id: 'asset-iwda', quantity: 450, entry_price: 72.30, custom_classification: 'Index', target_percentage: 20 },
  { id: 'pos-3', portfolio_id: 'demo-portfolio-id', broker_id: 'broker-degiro', asset_id: 'asset-vusa', quantity: 200, entry_price: 68.10, custom_classification: 'Index', target_percentage: 20 },
  { id: 'pos-4', portfolio_id: 'demo-portfolio-id', broker_id: 'broker-degiro', asset_id: 'asset-eur', quantity: 12450.60, entry_price: 1, custom_classification: 'Cash', target_percentage: 5 },
  
  // IBKR Positions
  { id: 'pos-5', portfolio_id: 'demo-portfolio-id', broker_id: 'broker-ibkr', asset_id: 'asset-aapl', quantity: 120, entry_price: 145.20, custom_classification: 'Tech', target_percentage: 15 },
  { id: 'pos-6', portfolio_id: 'demo-portfolio-id', broker_id: 'broker-ibkr', asset_id: 'asset-msft', quantity: 80, entry_price: 280.40, custom_classification: 'Tech', target_percentage: 10 },
  { id: 'pos-7', portfolio_id: 'demo-portfolio-id', broker_id: 'broker-ibkr', asset_id: 'asset-nvda', quantity: 50, entry_price: 320.15, custom_classification: 'AI', target_percentage: 10 },
  { id: 'pos-8', portfolio_id: 'demo-portfolio-id', broker_id: 'broker-ibkr', asset_id: 'asset-usd', quantity: 5400.20, entry_price: 1, custom_classification: 'Cash', target_percentage: 0 },

  // Binance Positions
  { id: 'pos-9', portfolio_id: 'demo-portfolio-id', broker_id: 'broker-binance', asset_id: 'asset-btc', quantity: 0.45, entry_price: 42000, custom_classification: 'Crypto', target_percentage: 5 },
];

export const DEMO_TRANSACTIONS = [
  // ASML
  { id: 'tx-1', position_id: 'pos-1', transaction_type: 'BUY', quantity: 15, price: 600.00, total_amount: 9000, transaction_date: '2023-03-15T10:00:00', notes: 'Initial buy' },
  { id: 'tx-2', position_id: 'pos-1', transaction_type: 'BUY', quantity: 10, price: 651.25, total_amount: 6512.50, transaction_date: '2023-11-20T11:30:00', notes: 'DCA' },
  { id: 'tx-3', position_id: 'pos-1', transaction_type: 'DIVIDEND', quantity: 0, price: 0, total_amount: 45.50, transaction_date: '2024-02-15T09:00:00', notes: 'Quarterly dividend' },
  { id: 'tx-3b', position_id: 'pos-1', transaction_type: 'DIVIDEND', quantity: 0, price: 0, total_amount: 52.20, transaction_date: '2024-05-10T09:00:00', notes: 'Quarterly dividend' },
  
  // IWDA
  { id: 'tx-4', position_id: 'pos-2', transaction_type: 'BUY', quantity: 450, price: 72.30, total_amount: 32535, transaction_date: '2023-01-10T15:00:00', notes: 'Core position' },
  
  // AAPL
  { id: 'tx-5', position_id: 'pos-5', transaction_type: 'BUY', quantity: 150, price: 140.00, total_amount: 21000, transaction_date: '2023-05-05T14:30:00', notes: 'Growth play' },
  { id: 'tx-6', position_id: 'pos-5', transaction_type: 'SELL', quantity: 30, price: 185.00, total_amount: 5550, transaction_date: '2024-03-01T16:00:00', notes: 'Profit taking' },
  { id: 'tx-7', position_id: 'pos-5', transaction_type: 'FEE', quantity: 0, price: 0, total_amount: -1.50, transaction_date: '2024-03-01T16:00:00', notes: 'Broker fee' },
  { id: 'tx-7b', position_id: 'pos-5', transaction_type: 'DIVIDEND', quantity: 0, price: 0, total_amount: 28.80, transaction_date: '2024-01-15T09:00:00', notes: 'Apple Div' },

  // MSFT
  { id: 'tx-m1', position_id: 'pos-6', transaction_type: 'BUY', quantity: 80, price: 280.40, total_amount: 22432, transaction_date: '2023-04-10T10:00:00', notes: 'Core tech' },
  { id: 'tx-m2', position_id: 'pos-6', transaction_type: 'DIVIDEND', quantity: 0, price: 0, total_amount: 60.00, transaction_date: '2024-03-10T09:00:00', notes: 'Microsoft Div' },

  // NVDA
  { id: 'tx-8', position_id: 'pos-7', transaction_type: 'BUY', quantity: 20, price: 280.00, total_amount: 5600, transaction_date: '2023-06-15T15:30:00', notes: '' },
  { id: 'tx-9', position_id: 'pos-7', transaction_type: 'BUY', quantity: 30, price: 346.90, total_amount: 10407, transaction_date: '2023-09-12T14:45:00', notes: '' },

  // BTC
  { id: 'tx-10', position_id: 'pos-9', transaction_type: 'BUY', quantity: 0.45, price: 42000, total_amount: 18900, transaction_date: '2023-12-01T08:00:00', notes: 'Long term' },
  
  // Cash moves
  { id: 'tx-11', position_id: 'pos-4', transaction_type: 'CASH', quantity: 0, price: 0, total_amount: 50000, transaction_date: '2023-01-01T12:00:00', notes: 'Initial deposit' },
  { id: 'tx-12', position_id: 'pos-4', transaction_type: 'CASH', quantity: 0, price: 0, total_amount: -5000, transaction_date: '2024-01-15T12:00:00', notes: 'Withdrawal' },
  { id: 'tx-13', position_id: 'pos-4', transaction_type: 'FEE', quantity: 0, price: 0, total_amount: -12.50, transaction_date: '2024-01-01T00:00:00', notes: 'Annual custody fee' },
];

export const DEMO_WATCHLISTS = [
  { id: 'wl-1', user_id: 'demo-user-id', name: 'Principales' },
  { id: 'wl-2', user_id: 'demo-user-id', name: 'Cripto' },
];

export const DEMO_WATCHLIST_ITEMS = [
  { id: 'wi-1', watchlist_id: 'wl-1', ticker: 'AAPL' },
  { id: 'wi-2', watchlist_id: 'wl-1', ticker: 'MSFT' },
  { id: 'wi-3', watchlist_id: 'wl-1', ticker: 'NVDA' },
  { id: 'wi-4', watchlist_id: 'wl-1', ticker: 'ASML.AS' },
  { id: 'wi-5', watchlist_id: 'wl-2', ticker: 'BTC-USD' },
  { id: 'wi-6', watchlist_id: 'wl-2', ticker: 'ETH-USD' },
];


// ── Gastos y ahorro (feature opt-in) ────────────────────────────────────────
// Todas las fechas se generan RELATIVAS a hoy: la demo no puede envejecer.
// Se siembran también las ocurrencias ya materializadas de cada plantilla (con
// su recurring_source_id + source_month reales) por dos razones:
//   1. computeMissingOccurrences las reconoce y no regenera nada — el estado es
//      exactamente el de una cuenta que lleva meses usándose.
//   2. El Dashboard hace una lectura SIN materializar, así que sin sembrarlas
//      su widget de gastos mostraría 0 € hasta visitar /app/gastos.

const pad2 = (n) => String(n).padStart(2, '0');
const monthDays = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** Mes desplazado `k` meses respecto al actual (k negativo = pasado). */
const shiftMonth = (k) => {
  const now = new Date();
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() + k, 1));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
};
const dateAt = (k, day) => {
  const { y, m } = shiftMonth(k);
  return `${y}-${pad2(m)}-${pad2(Math.min(day, monthDays(y, m)))}`;
};
const monthKeyAt = (k) => { const { y, m } = shiftMonth(k); return `${y}-${pad2(m)}`; };

// Cuántos meses de historial arrastra la cuenta de demo. ≥ 3 para que
// projectAnnualSavings tenga suficiente historia y calcule su estimación.
const HISTORY_MONTHS = 10;

const TEMPLATES = [
  { id: 'demo-tpl-salary',  type: 'income',  category: 'salary',        amount: 2380,  day: 25, notes: 'Nómina' },
  { id: 'demo-tpl-rent',    type: 'expense', category: 'housing',       amount: 890,   day: 1,  notes: 'Alquiler' },
  { id: 'demo-tpl-utils',   type: 'expense', category: 'utilities',     amount: 96.4,  day: 8,  notes: 'Luz y agua' },
  { id: 'demo-tpl-subs',    type: 'expense', category: 'subscriptions', amount: 27.98, day: 12, notes: 'Netflix + Spotify' },
  { id: 'demo-tpl-gym',     type: 'expense', category: 'health',        amount: 39.9,  day: 5,  notes: 'Gimnasio' },
  { id: 'demo-tpl-commute', type: 'expense', category: 'transport',     amount: 54.6,  day: 3,  notes: 'Abono transporte' },
];

const demoTemplateRows = TEMPLATES.map((t) => ({
  id: t.id,
  user_id: 'demo-user-id',
  type: t.type,
  category: t.category,
  amount: t.amount,
  currency: 'EUR',
  entry_date: dateAt(-HISTORY_MONTHS, t.day),
  notes: t.notes,
  recurrence: 'monthly',
  recurrence_day: t.day,
  recurrence_until: null,
  recurrence_active: true,
  recurring_source_id: null,
  source_month: null,
  skipped: false,
  created_at: new Date().toISOString(),
}));

// Ocurrencias ya materializadas, de hace HISTORY_MONTHS hasta el mes actual.
const demoOccurrenceRows = [];
for (const t of TEMPLATES) {
  for (let k = -HISTORY_MONTHS; k <= 0; k += 1) {
    demoOccurrenceRows.push({
      id: `demo-occ-${t.id}-${monthKeyAt(k)}`,
      user_id: 'demo-user-id',
      type: t.type,
      category: t.category,
      amount: t.amount,
      currency: 'EUR',
      entry_date: dateAt(k, t.day),
      notes: t.notes,
      recurrence: 'none',
      recurrence_day: null,
      recurrence_active: true,
      recurring_source_id: t.id,
      source_month: monthKeyAt(k),
      skipped: false,
      created_at: new Date().toISOString(),
    });
  }
}

// Movimientos sueltos: dan volumen al donut, marcan días en el calendario y
// alimentan los insights ("tu mayor gasto…", "gastas un X% más que…").
// Los de k > 0 son gastos/ingresos ya anotados a FUTURO: aparecen en el
// desglose del objetivo anual como "Movimientos que ya has anotado a futuro".
const ONE_OFFS = [
  // [mesesRespectoAHoy, día, tipo, categoría, importe, nota]
  [-6, 14, 'expense', 'travel',      612.4, 'Vuelos verano'],
  [-5, 22, 'expense', 'shopping',    189.9, 'Zapatillas'],
  [-5,  9, 'income',  'freelance',   640,   'Proyecto web'],
  [-4, 18, 'expense', 'restaurants', 78.5,  'Cena aniversario'],
  [-4,  2, 'expense', 'education',   240,   'Curso de inglés'],
  [-3, 27, 'expense', 'taxes',       418.6, 'IRPF trimestral'],
  [-3, 11, 'expense', 'groceries',   96.2,  null],
  [-2, 16, 'income',  'gift',        150,   'Regalo cumpleaños'],
  [-2,  6, 'expense', 'leisure',     54,    'Conciertos'],
  [-1, 21, 'expense', 'Mascota',     72.3,  'Veterinario'],
  [-1, 13, 'expense', 'restaurants', 121.8, null],
  [-1,  4, 'expense', 'groceries',   402.7, 'Compra del mes'],
  [0,   2, 'expense', 'groceries',   118.4, null],
  [0,   6, 'expense', 'restaurants', 43.2,  'Comida con Marta'],
  [0,   9, 'expense', 'leisure',     26,    'Cine'],
  [0,  11, 'income',  'freelance',   480,   'Landing para cliente'],
  [0,  14, 'expense', 'groceries',   87.9,  null],
  [0,  17, 'expense', 'shopping',    64.5,  'Regalo'],
  [0,  19, 'expense', 'Mascota',     38.6,  'Pienso'],
  [0,  23, 'expense', 'restaurants', 31.4,  null],
  [1,   8, 'expense', 'travel',      780,   'Escapada reservada'],
  [2,  20, 'expense', 'taxes',       620,   'IRPF trimestral'],
  // Gastos etiquetados a un PROYECTO (7º campo). Reparten el mismo viaje entre
  // varias categorías, que es justo lo que el widget viene a responder: no
  // "cuánto costó el viaje" sino "cuánto de ello fue restaurantes".
  [-1, 12, 'expense', 'travel',      380,   'Refugio y forfait',     'demo-proj-1'],
  [-1, 13, 'expense', 'restaurants', 145,   'Cenas del viaje',       'demo-proj-1'],
  [-1, 12, 'expense', 'transport',    96,   'Gasolina y peajes',     'demo-proj-1'],
  [-1, 14, 'expense', 'leisure',      88,   'Guía de montaña',       'demo-proj-1'],
  [-1, 15, 'expense', 'shopping',     42,   'Recuerdos',             'demo-proj-1'],
  [-1, 16, 'income',  'gift',         60,   'Lo que puso Marta',     'demo-proj-1'],
  // Proyecto en curso y SIN sobre enlazado: sin barra de comparación
  [0,   4, 'expense', 'housing',     450,   'Fontanero',             'demo-proj-2'],
  [0,  18, 'expense', 'shopping',    120,   'Grifería',              'demo-proj-2'],
];

const demoOneOffRows = ONE_OFFS.map(([k, day, type, category, amount, notes, projectId = null], i) => ({
  id: `demo-exp-${i}`,
  user_id: 'demo-user-id',
  type,
  category,
  amount,
  currency: 'EUR',
  entry_date: dateAt(k, day),
  notes,
  project_id: projectId,
  recurrence: 'none',
  recurrence_day: null,
  recurrence_active: true,
  recurring_source_id: null,
  source_month: null,
  skipped: false,
  created_at: new Date().toISOString(),
}));

export const DEMO_EXPENSE_ENTRIES = [
  ...demoTemplateRows,
  ...demoOccurrenceRows,
  ...demoOneOffRows,
];

/**
 * Metas con modelo de sobres, una por estado: a medias, sin asignar, sobres
 * libres, cumplida-y-gastada, VENCIDA (libera su saldo) y COMPLETADA a mano.
 */
export const DEMO_SAVINGS_GOALS = [
  {
    id: 'demo-goal-1',
    user_id: 'demo-user-id',
    name: 'Viaje a Japón',
    target_amount: 5000,
    allocated_amount: 3800,
    start_date: dateAt(-6, 1),
    target_date: dateAt(8, 15),
    created_at: new Date().toISOString(),
  },
  {
    id: 'demo-goal-2',
    user_id: 'demo-user-id',
    name: 'Fondo de emergencia',
    target_amount: 9000,
    allocated_amount: 4200,
    start_date: dateAt(-10, 1),
    target_date: dateAt(14, 1),
    created_at: new Date().toISOString(),
  },
  {
    id: 'demo-goal-3',
    user_id: 'demo-user-id',
    name: 'Cambiar el coche',
    target_amount: 12000,
    allocated_amount: 0,
    start_date: dateAt(0, 1),
    target_date: dateAt(22, 1),
    created_at: new Date().toISOString(),
  },
  // Sobres libres: sin objetivo ni fecha, solo dinero apartado. Van en la demo
  // para que el estado se vea sin tener que crearlo (igual que los presupuestos
  // en verde/ámbar/superado o las metas llena/a medias/vacía).
  {
    id: 'demo-goal-4',
    user_id: 'demo-user-id',
    name: 'Gasolina',
    target_amount: null,
    allocated_amount: 240,
    start_date: dateAt(-3, 1),
    target_date: null,
    created_at: new Date().toISOString(),
  },
  {
    id: 'demo-goal-5',
    user_id: 'demo-user-id',
    name: 'Restaurantes',
    target_amount: null,
    allocated_amount: 75,
    start_date: dateAt(-2, 1),
    target_date: null,
    created_at: new Date().toISOString(),
  },
  // Meta CUMPLIDA y ya gastada: se juntaron los 700 € del viaje y el viaje se
  // hizo (691 € en gastos del proyecto). Queda congelada al 100% — el logro no
  // se deshace por gastarse aquello para lo que se ahorraba — mientras el saldo
  // real (9 €) se libera del pool de reserva.
  {
    id: 'demo-goal-6',
    user_id: 'demo-user-id',
    name: 'Viaje a los Pirineos',
    target_amount: 700,
    allocated_amount: 700,
    start_date: dateAt(-4, 1),
    target_date: dateAt(-1, 12),
    created_at: new Date().toISOString(),
  },
  // Meta VENCIDA: la fecha pasó y se quedó a medias. Estado imprescindible en la
  // demo porque es donde el sobre SUELTA su dinero — los 340 € vuelven a
  // "Disponible para asignar" — y aparece el botón de darla por completada.
  {
    id: 'demo-goal-7',
    user_id: 'demo-user-id',
    name: 'Curso de fotografía',
    target_amount: 900,
    allocated_amount: 340,
    start_date: dateAt(-8, 1),
    target_date: dateAt(-2, 10),
    created_at: new Date().toISOString(),
  },
  // Meta CERRADA A MANO por el usuario: ya no retiene nada y se puede reabrir.
  {
    id: 'demo-goal-8',
    user_id: 'demo-user-id',
    name: 'Portátil nuevo',
    target_amount: 1400,
    allocated_amount: 1400,
    start_date: dateAt(-9, 1),
    target_date: dateAt(-1, 20),
    completed_at: `${dateAt(-1, 22)}T10:00:00.000Z`,
    created_at: new Date().toISOString(),
  },
];

/**
 * Proyectos de gasto: uno cerrado y enlazado a su sobre (se ve la comparación
 * apartado vs gastado) y otro en curso sin sobre (se ve sin barra).
 */
export const DEMO_EXPENSE_PROJECTS = [
  {
    id: 'demo-proj-1',
    user_id: 'demo-user-id',
    name: 'Viaje a los Pirineos',
    start_date: dateAt(-1, 12),
    end_date: dateAt(-1, 16),
    goal_id: 'demo-goal-6',
    archived: false,
    created_at: new Date().toISOString(),
  },
  {
    id: 'demo-proj-2',
    user_id: 'demo-user-id',
    name: 'Reforma del baño',
    start_date: dateAt(0, 1),
    end_date: null,
    goal_id: null,
    archived: false,
    created_at: new Date().toISOString(),
  },
];

/* ════════════════════════════════════════════════════════════════════════
   PERSONA "DEMO SAMPLE" — cuenta de guion para el tutorial en vídeo.
   Currante con 1.800 € de nómina, ~1.500 € de gastos y 300 € de ahorro
   (100 al colchón, 200 a invertir). La cartera está montada para que la
   pantalla de Rebalanceo cuente sola las cinco estrategias del guion:
     · GME     → el chicharro del grupo de Telegram, en pérdidas, target 0 %
     · NVDA    → el acierto de churro, muy en verde y pasado de peso
     · ASML.AS → posición hinchada en un sector eufórico (semiconductores)
     · IWDA.AS → el MSCI World aburrido y responsable, lejos de su target
   Los targets suman 100 para que no salte el aviso de la calculadora.
   Se activa entrando con las credenciales de demo; NO sustituye a la demo
   pública, que sigue usando los DEMO_* de arriba.
   ════════════════════════════════════════════════════════════════════════ */

const GIL = 'demo-sample-user-id';

export const DEMO_SAMPLE_USER = {
  id: GIL,
  email: 'demoSample@example.com',
  user_metadata: { full_name: 'DemoSample', avatar_url: null },
  app_metadata: { provider: 'email' },
  aud: 'authenticated',
  created_at: new Date().toISOString(),
};

export const DEMO_SAMPLE_PREFERENCES = {
  user_id: GIL,
  dark_mode: true,
  preferred_currency: 'EUR',
  eodhd_api_key: '',
  expenses_enabled: true,
  savings_goal_annual: 3600,        // 300 €/mes durante todo el año
  savings_initial_balance: 1200,    // el colchón que ya lleva acumulado
  // Presupuestos elegidos para que en cámara se vean los tres estados:
  // alquiler al límite (ámbar), ocio y restaurantes SUPERADOS, resto verde.
  expense_budgets: { housing: 720, groceries: 320, restaurants: 80, leisure: 100, transport: 70 },
  custom_categories: { expense: ['Ruleta del viernes'], income: [] },
};

export const DEMO_SAMPLE_PORTFOLIOS = [
  { id: 'gil-portfolio', user_id: GIL, name: 'Mi cartera', created_at: '2023-01-01T00:00:00Z' },
];

export const DEMO_SAMPLE_BROKERS = [
  { id: 'gil-broker', user_id: GIL, name: 'Mi Broker', created_at: '2023-01-01T00:00:00Z' },
];

export const DEMO_SAMPLE_ASSETS = [
  { id: 'gil-a-gme',  ticker: 'GME',      company_name: 'GameStop Corp.',                    asset_class: 'Stock', currency: 'USD', current_price: 23.10,  sector: 'Consumer Cyclical', industry: 'Specialty Retail',        country: 'USA' },
  { id: 'gil-a-nvda', ticker: 'NVDA',     company_name: 'NVIDIA Corporation',                asset_class: 'Stock', currency: 'USD', current_price: 178.90, sector: 'Technology',        industry: 'Semiconductors',          country: 'USA' },
  { id: 'gil-a-asml', ticker: 'ASML.AS',  company_name: 'ASML Holding N.V.',                 asset_class: 'Stock', currency: 'EUR', current_price: 712.40, sector: 'Technology',        industry: 'Semiconductor Equipment', country: 'Netherlands' },
  { id: 'gil-a-iwda', ticker: 'IWDA.AS',  company_name: 'iShares Core MSCI World UCITS ETF', asset_class: 'ETF',   currency: 'EUR', current_price: 104.80, sector: 'Financial Services', industry: 'Index Fund',              country: 'Ireland' },
  { id: 'gil-a-eur',  ticker: 'CASH_EUR', company_name: 'Cash / Liquidity (EUR)',            asset_class: 'Cash',  currency: 'EUR', current_price: 1,      sector: 'Cash',              industry: 'Currency',                country: 'Europe' },
];

// entry_price elegido para el efecto en cámara: GME comprado en el pico (rojo
// sangre), NVDA y ASML muy en verde, IWDA subiendo tranquilo.
export const DEMO_SAMPLE_POSITIONS = [
  { id: 'gil-p-iwda', portfolio_id: 'gil-portfolio', broker_id: 'gil-broker', asset_id: 'gil-a-iwda', quantity: 34,  entry_price: 92.40,  custom_classification: 'Index',  target_percentage: 70 },
  { id: 'gil-p-nvda', portfolio_id: 'gil-portfolio', broker_id: 'gil-broker', asset_id: 'gil-a-nvda', quantity: 12,  entry_price: 45.30,  custom_classification: 'Tech',   target_percentage: 15 },
  { id: 'gil-p-asml', portfolio_id: 'gil-portfolio', broker_id: 'gil-broker', asset_id: 'gil-a-asml', quantity: 3,   entry_price: 381.20, custom_classification: 'Tech',   target_percentage: 15 },
  { id: 'gil-p-gme',  portfolio_id: 'gil-portfolio', broker_id: 'gil-broker', asset_id: 'gil-a-gme',  quantity: 40,  entry_price: 56.80,  custom_classification: 'Others', target_percentage: 0 },
  { id: 'gil-p-eur',  portfolio_id: 'gil-portfolio', broker_id: 'gil-broker', asset_id: 'gil-a-eur',  quantity: 200, entry_price: 1,      custom_classification: 'Cash',   target_percentage: 0 },
];

export const DEMO_SAMPLE_TRANSACTIONS = [
  { id: 'gil-tx-1', position_id: 'gil-p-gme',  transaction_type: 'BUY',  quantity: 40, price: 56.80,  total_amount: 2272.00, transaction_date: '2024-05-14T10:05:00', notes: 'Lo dijeron en el grupo de Telegram', transaction_currency: 'USD', commission: 2.00 },
  { id: 'gil-tx-2', position_id: 'gil-p-nvda', transaction_type: 'BUY',  quantity: 12, price: 45.30,  total_amount: 543.60,  transaction_date: '2023-06-02T15:40:00', notes: 'Compra NVDA',                       transaction_currency: 'USD', commission: 1.00 },
  { id: 'gil-tx-3', position_id: 'gil-p-asml', transaction_type: 'BUY',  quantity: 3,  price: 381.20, total_amount: 1143.60, transaction_date: '2023-09-18T09:20:00', notes: 'Compra ASML',                       transaction_currency: 'EUR', commission: 2.00 },
  { id: 'gil-tx-4', position_id: 'gil-p-iwda', transaction_type: 'BUY',  quantity: 20, price: 89.10,  total_amount: 1782.00, transaction_date: '2024-01-15T09:00:00', notes: 'DCA mensual',                       transaction_currency: 'EUR', commission: 1.00 },
  { id: 'gil-tx-5', position_id: 'gil-p-iwda', transaction_type: 'BUY',  quantity: 14, price: 97.10,  total_amount: 1359.40, transaction_date: '2025-06-16T09:00:00', notes: 'DCA mensual',                       transaction_currency: 'EUR', commission: 1.00 },
  { id: 'gil-tx-6', position_id: 'gil-p-eur',  transaction_type: 'CASH', quantity: 0,  price: 0,      total_amount: 200,     transaction_date: '2026-01-05T08:00:00', notes: 'Aportación mensual' },
];

/* ── Gastos: nómina de 1.800 y ~1.500 € de gastos ─────────────────────────
   Recurrentes = 1.190 € · sueltos del mes = 310 € → 1.500 de gasto y 300 de
   ahorro, exactamente los números que se dicen en el guion.              */
const GIL_TEMPLATES = [
  { id: 'gil-tpl-salary', type: 'income',  category: 'salary',        amount: 1800, day: 25, notes: 'Nómina' },
  { id: 'gil-tpl-rent',   type: 'expense', category: 'housing',       amount: 700,  day: 1,  notes: 'Alquiler' },
  { id: 'gil-tpl-food',   type: 'expense', category: 'groceries',     amount: 280,  day: 2,  notes: 'Compra del mes' },
  { id: 'gil-tpl-utils',  type: 'expense', category: 'utilities',     amount: 80,   day: 8,  notes: 'Luz, agua e internet' },
  { id: 'gil-tpl-subs',   type: 'expense', category: 'subscriptions', amount: 45,   day: 12, notes: 'Las suscripciones que no cancela' },
  { id: 'gil-tpl-bus',    type: 'expense', category: 'transport',     amount: 55,   day: 3,  notes: 'Abono transporte' },
  { id: 'gil-tpl-gym',    type: 'expense', category: 'health',        amount: 30,   day: 5,  notes: 'Gimnasio (va dos veces al mes)' },
];

const GIL_ONE_OFFS = [
  [-4, 12, 'expense', 'leisure',            140, 'Concierto'],
  [-3, 20, 'expense', 'shopping',           95,  'Zapatillas nuevas'],
  [-2, 17, 'expense', 'restaurants',        88,  'Cena con los cabeza boniatos'],
  [-1, 22, 'expense', 'Ruleta del viernes', 60,  'No preguntes'],
  [-1,  9, 'expense', 'leisure',            110, 'Finde fuera'],
  [0,   6, 'expense', 'restaurants',        95,  'Cenas del mes'],
  [0,  14, 'expense', 'leisure',            130, 'Ocio'],
  [0,  21, 'expense', 'shopping',           85,  'Compras varias'],
];

const gilTemplateRows = GIL_TEMPLATES.map((t) => ({
  id: t.id, user_id: GIL, type: t.type, category: t.category, amount: t.amount, currency: 'EUR',
  entry_date: dateAt(-HISTORY_MONTHS, t.day), notes: t.notes,
  recurrence: 'monthly', recurrence_day: t.day, recurrence_until: null, recurrence_active: true,
  recurring_source_id: null, source_month: null, skipped: false, created_at: new Date().toISOString(),
}));

const gilOccurrenceRows = [];
for (const t of GIL_TEMPLATES) {
  for (let k = -HISTORY_MONTHS; k <= 0; k += 1) {
    gilOccurrenceRows.push({
      id: `gil-occ-${t.id}-${monthKeyAt(k)}`, user_id: GIL, type: t.type, category: t.category,
      amount: t.amount, currency: 'EUR', entry_date: dateAt(k, t.day), notes: t.notes,
      recurrence: 'none', recurrence_day: null, recurrence_active: true,
      recurring_source_id: t.id, source_month: monthKeyAt(k), skipped: false, created_at: new Date().toISOString(),
    });
  }
}

export const DEMO_SAMPLE_EXPENSE_ENTRIES = [
  ...gilTemplateRows,
  ...gilOccurrenceRows,
  ...GIL_ONE_OFFS.map(([k, day, type, category, amount, notes], i) => ({
    id: `gil-exp-${i}`, user_id: GIL, type, category, amount, currency: 'EUR',
    entry_date: dateAt(k, day), notes,
    recurrence: 'none', recurrence_day: null, recurrence_active: true,
    recurring_source_id: null, source_month: null, skipped: false, created_at: new Date().toISOString(),
  })),
];

export const DEMO_SAMPLE_SAVINGS_GOALS = [
  {
    id: 'gil-goal-1', user_id: GIL, name: 'Colchón de emergencia',
    target_amount: 4500, allocated_amount: 1200,
    start_date: dateAt(-HISTORY_MONTHS, 1), target_date: dateAt(24, 1),
    created_at: new Date().toISOString(),
  },
];

export const DEMO_SAMPLE_WATCHLISTS = [{ id: 'gil-wl', user_id: GIL, name: 'Lo que me dicen en Telegram' }];
export const DEMO_SAMPLE_WATCHLIST_ITEMS = [
  { id: 'gil-wi-1', watchlist_id: 'gil-wl', ticker: 'META' },
  { id: 'gil-wi-2', watchlist_id: 'gil-wl', ticker: 'MSFT' },
  { id: 'gil-wi-3', watchlist_id: 'gil-wl', ticker: 'IWDA.AS' },
];
