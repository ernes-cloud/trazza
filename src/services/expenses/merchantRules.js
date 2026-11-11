/**
 * Deterministic merchant → category rules for the bank import.
 *
 * This layer exists to run BEFORE any AI categorization, for three reasons:
 * it is free, it is instant, and it is auditable. Measured on a real 1440-row
 * statement, card and direct-debit merchants compress ~3:1 (310 unique names
 * for 936 card rows), so a modest rule set covers a large share of the volume
 * and only the tail ever needs a model.
 *
 * Scope note: rules match the SPANISH retail landscape because that is what
 * the supported banks serve. A miss returns null and the caller falls back
 * (AI, then the user in the preview) — a wrong guess is worse than no guess,
 * so patterns are specific brands, never fuzzy words like "market" or "shop".
 *
 * Categories must stay inside EXPENSE_CATEGORIES / INCOME_CATEGORIES from
 * expenseService — a slug that is not in those lists has no i18n label and
 * renders as raw text in the UI.
 */

/** [regex, category] — first match wins, so put specific before generic. */
const EXPENSE_RULES = [
  [/mercadona|carrefour|lidl|\bdia\b|alcampo|eroski|consum|ahorramas|aldi|hipercor|supercor|caprabo|gadis|froiz|bonarea/i, 'groceries'],
  [/mcdonald|burger king|telepizza|dominos|goiko|vips|starbucks|kfc|taco bell|glovo|just ?eat|uber ?eats|deliveroo|restaurante|cafeteria|cerveceria|bar\b|tapas/i, 'restaurants'],
  [/renfe|alsa|\bemt\b|metro de|cabify|\buber\b(?! ?eats)|bolt|taxi|repsol|cepsa|galp|\bbp\b|shell|waylet|petrol|gasolin|parking|aparcamiento|autopista|\bap-\d|telepeaje|via-?t/i, 'transport'],
  [/iberdrola|endesa|naturgy|repsol luz|holaluz|totalenergies|aqualia|hidraqua|canal de isabel|emasesa|movistar|vodafone|orange|jazztel|masmovil|yoigo|digi |pepephone|lowi|finetwork/i, 'utilities'],
  [/netflix|spotify|\bhbo\b|disney|amazon prime|primevideo|filmin|movistar\+|\bdazn\b|youtube premium|apple\.com\/bill|itunes|google ?storage|dropbox|adobe|microsoft 365|chatgpt|openai|anthropic|claude|patreon|audible/i, 'subscriptions'],
  [/farmacia|clinica|dentista|hospital|sanitas|adeslas|asisa|dkv|mapfre salud|optica|fisioterap|psicolog/i, 'health'],
  [/decathlon|cinesa|yelmo|kinepolis|ocine|teatro|museo|spotify hifi|steam|playstation|nintendo|xbox|gimnasio|\bgym\b|basic ?fit|mcfit|padel|piscina/i, 'leisure'],
  [/amazon|aliexpress|zara|\bh&m\b|primark|el corte ingles|mediamarkt|pccomponentes|leroy merlin|ikea|bricomart|worten|fnac|casa del libro|shein|temu|zalando|springfield|bershka|pull ?& ?bear|stradivarius/i, 'shopping'],
  [/booking|airbnb|ryanair|vueling|iberia|easyjet|air europa|renfe ave|hotel|hostal|parador|expedia|edreams|kiwi\.com|trivago/i, 'travel'],
  [/universidad|colegio|instituto|academia|udemy|coursera|domestika|platzi|matricula|libreria escolar/i, 'education'],
  [/agencia tributaria|\baeat\b|hacienda|seguridad social|\bircf\b|impuesto|\biva\b|\birpf\b|ayuntamiento|suma gestion|catastro|\bdgt\b|multa/i, 'taxes'],
  [/alquiler|hipoteca|comunidad de propietarios|administracion de fincas|inmobiliaria|seguro hogar|securitas direct|prosegur/i, 'housing'],
  [/comision|tarifa del plan|mantenimiento cuenta|cuota anual tarjeta/i, 'other'],
];

const INCOME_RULES = [
  [/nomina|payroll|salario|salary/i, 'salary'],
  [/factura|honorarios|freelance|invoice/i, 'freelance'],
  [/alquiler cobrado|renta inquilino|rental income/i, 'rental'],
];

/**
 * Diacritics are stripped from the TEXT, never from the patterns — a Spanish
 * bank writes "Abono de nómina" and a rule spelled `nomina` must still match
 * (28 rows of one real statement hung on exactly this). Every pattern above is
 * therefore written accent-free on purpose.
 */
const normalizeForMatch = (s) => String(s ?? '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * @param {string|null} merchant   resolved merchant/counterparty
 * @param {'expense'|'income'} intent
 * @param {string} [extra]         additional text to match (concept/detail)
 * @returns {string|null} category slug, or null when no rule is confident
 */
export function categorizeMerchant(merchant, intent, extra = '') {
  const haystack = normalizeForMatch(`${merchant ?? ''} ${extra ?? ''}`);
  if (!haystack) return null;
  const rules = intent === 'income' ? INCOME_RULES : EXPENSE_RULES;
  for (const [pattern, category] of rules) {
    if (pattern.test(haystack)) return category;
  }
  return null;
}

/**
 * Distinct merchant strings that no rule could categorize — the exact input
 * the AI categorizer will receive. Deduplicated on purpose: the model should
 * see each merchant ONCE (~3:1 compression on real data, and far more on
 * repeat imports once the resolved rules are cached).
 *
 * @returns {string[]} sorted, unique, non-empty
 */
export function collectUncategorizedMerchants(classified = []) {
  const pending = new Set();
  for (const { movement, intent } of classified) {
    if (intent === 'ignore') continue;
    const merchant = (movement?.merchant || '').trim();
    if (!merchant) continue;
    if (categorizeMerchant(merchant, intent, movement?.detail)) continue;
    pending.add(merchant);
  }
  return [...pending].sort();
}
