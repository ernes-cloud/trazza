// Ayudantes PRIVADOS de los módulos de Gastos (sin dependencias). No se
// reexportan desde expenseService.js: no forman parte de la API pública.
// Partido desde services/expenseService.js (2026-10-04), que reexporta la API.

import Decimal from 'decimal.js';

export const D = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return new Decimal(Number.isFinite(n) ? n : 0);
};

export const monthKeyToParts = (mk) => {
  const [y, m] = mk.split('-').map(Number);
  return { year: y, month: m };
};

export const nextMonthKey = (mk) => {
  const { year, month } = monthKeyToParts(mk);
  return month === 12
    ? `${year + 1}-01`
    : `${year}-${String(month + 1).padStart(2, '0')}`;
};
