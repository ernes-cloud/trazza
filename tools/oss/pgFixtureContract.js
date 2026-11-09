/** Fail-closed fixtures: discover every mandatory/no-default input, don't guess
 * values for new business columns. A changed schema must produce a named error.
 */
const INPUTS = {
  'auth.users': ['id', 'email'],
  'public.assets': ['id', 'ticker', 'company_name'],
  'public.brokers': ['id', 'user_id', 'name'],
  'public.portfolios': ['id', 'user_id', 'name'],
  'public.positions': ['id', 'asset_id', 'broker_id', 'portfolio_id', 'quantity', 'entry_price'],
  'public.transactions': ['id', 'position_id', 'transaction_type', 'quantity', 'price', 'total_amount', 'transaction_date'],
};
export function verifyCoreFixtureSchema(pg) {
  for (const [table, supplied] of Object.entries(INPUTS)) {
    const [schema, name] = table.split('.');
    const required = pg.psql(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = '${schema}' AND table_name = '${name}'
        AND is_nullable = 'NO' AND column_default IS NULL AND is_identity = 'NO'
        AND is_generated = 'NEVER' ORDER BY ordinal_position;`, ['-q', '-t', '-A']).trim().split('\n').filter(Boolean);
    const missing = required.filter((column) => !supplied.includes(column));
    if (missing.length) throw new Error(`Fixture ${table}: missing mandatory columns: ${missing.join(', ')}`);
    const actual = pg.psql(`SELECT COUNT(*) FROM information_schema.columns
      WHERE table_schema = '${schema}' AND table_name = '${name}';`, ['-q', '-t', '-A']).trim();
    if (!Number(actual)) throw new Error(`Fixture table missing: ${table}`);
  }
  const notNull = pg.psql(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'positions' AND is_nullable = 'NO'
      AND column_name IN ('entry_price', 'broker_id', 'portfolio_id') ORDER BY column_name;`, ['-q', '-t', '-A']).trim();
  if (notNull !== 'broker_id\nentry_price\nportfolio_id') {
    throw new Error(`Fixture requires D5/prod NOT NULL positions.{broker_id,entry_price,portfolio_id}; actual: ${notNull}`);
  }
}
export function verifyCoreFixtureRows(pg, positions = 2) {
  const minimums = { 'auth.users': 2, 'public.assets': 1, 'public.brokers': 2, 'public.portfolios': 2, 'public.positions': positions };
  for (const [table, min] of Object.entries(minimums)) {
    const count = Number(pg.psql(`SELECT COUNT(*) FROM ${table};`, ['-q', '-t', '-A']).trim());
    if (!Number.isFinite(count) || count < min) throw new Error(`Fixture ${table}: expected >= ${min} rows, got ${count}`);
  }
}
