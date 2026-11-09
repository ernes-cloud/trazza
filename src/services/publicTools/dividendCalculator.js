/**
 * Calculadora de dividendos (página pública /calculadora-dividendos) — PURA.
 *
 * Cuánto cobras de verdad por tus dividendos siendo residente fiscal en España:
 *   bruto → retención en origen → IRPF (base del ahorro) → deducción por doble
 *   imposición internacional → neto.
 *
 * La deducción por doble imposición se limita a lo MENOR de: lo retenido fuera,
 * el tope del convenio (15 % para los países de la lista) y la cuota española
 * de esa renta. Lo retenido en origen por encima del tope del convenio NO se
 * recupera en la Renta — hay que reclamarlo al país —, y es el dato que más
 * sorprende (Suiza retiene un 35 %).
 */

import Decimal from 'decimal.js';
import { incrementalSavingsTax } from './savingsTax.js';

export const TREATY_CAP = 0.15;

/**
 * Retención en origen habitual sobre dividendos para un residente en España,
 * sin trámites adicionales (contrastado el 2026-10-04). `treatyCap` = lo que
 * permite deducir el convenio. El usuario puede escribir su propio porcentaje.
 */
export const ORIGIN_COUNTRIES = [
  { id: 'es', rate: 0, treatyCap: 0 },        // sin retención en origen
  { id: 'us', rate: 0.15, treatyCap: 0.15 },  // con el formulario W-8BEN (sin él, 30 %)
  // Reino Unido: sin retención en origen (https://www.business.gov.uk/invest-in-uk/investment/uk-tax-and-incentives/);
  // tope del convenio España-Reino Unido 2013, art. 10.2.a.i: 10 % (https://www.boe.es/eli/es/ai/2013/03/14/(1)).
  { id: 'gb', rate: 0, treatyCap: 0.10 },
  // Irlanda: SOLO ETF/fondos domiciliados en Irlanda. Régimen «gross roll-up» de los fondos (TCA 1997, Part 27,
  // Chapter 1A, ss. 739B-739J): el fondo no retiene DWT al partícipe, sino exit tax, que no se practica al no
  // residente con declaración de no residencia o «equivalent measures» (s. 739D). En los ETF, cuyas participaciones
  // se liquidan en un sistema de compensación reconocido, no se retiene exit tax en ninguna operación (s. 739B(1),
  // definición de «chargeable event», párrafo III; TDM 27-01a-02, apartado 4.2.3). Revenue, TDM Part 27-01a-02:
  // https://www.revenue.ie/en/tax-professionals/tdm/income-tax-capital-gains-tax-corporation-tax/part-27/27-01a-02.pdf
  // Las ACCIONES de empresas irlandesas sí retienen DWT (25 %) salvo exención con el formulario V2A:
  // https://www.revenue.ie/en/companies-and-charities/dividend-withholding-tax/exemptions-for-non-residents.aspx
  { id: 'ie', rate: 0, treatyCap: 0.15 },     // ETFs irlandeses: no retienen al partícipe
  { id: 'nl', rate: 0.15, treatyCap: 0.15 },
  { id: 'de', rate: 0.26375, treatyCap: 0.15 },
  // Francia: 12,8 % a personas físicas no residentes (CGI art. 187.1.2°; el 25 % es para personas jurídicas).
  // https://www.impots.gouv.fr/international-particulier/mes-dividendes
  // https://bofip.impots.gouv.fr/bofip/2674-PGP.html/identifiant%3DBOI-RPPM-RCM-30-30-10-20-20220629
  // Tope del convenio España-Francia 1995, art. 10: 15 % (https://www.boe.es/buscar/act.php?id=BOE-A-1997-12729).
  { id: 'fr', rate: 0.128, treatyCap: 0.15 },
  { id: 'ch', rate: 0.35, treatyCap: 0.15 },
];

/**
 * @param {{ invested: number, yieldPct: number, originRate?: number, treatyCap?: number, otherSavingsIncome?: number }} input
 *   invested: euros invertidos · yieldPct: rentabilidad por dividendo anual en %
 *   originRate: retención en origen (0–1) · treatyCap: tope deducible (0–1)
 *   otherSavingsIncome: otras rentas del ahorro del año (sitúan el tramo)
 */
export function computeDividendIncome({ invested, yieldPct, originRate = 0, treatyCap = TREATY_CAP, otherSavingsIncome = 0 }) {
  const inv = Math.max(0, Number(invested) || 0);
  const y = Math.max(0, Number(yieldPct) || 0);
  const gross = new Decimal(inv).times(y).div(100);
  const origin = gross.times(Math.min(Math.max(Number(originRate) || 0, 0), 1));
  const spanishTax = new Decimal(incrementalSavingsTax(gross.toNumber(), otherSavingsIncome));
  const deduction = Decimal.min(origin, gross.times(Math.max(Number(treatyCap) || 0, 0)), spanishTax);
  const spanishToPay = spanishTax.minus(deduction);
  const net = gross.minus(origin).minus(spanishToPay);
  const lostAbroad = origin.minus(deduction); // retenido fuera que la Renta no devuelve
  const round = (d) => Math.round(d.toNumber() * 100) / 100;
  return {
    gross: round(gross),
    originWithholding: round(origin),
    spanishTax: round(spanishTax),
    deduction: round(deduction),
    spanishToPay: round(spanishToPay),
    net: round(net),
    netMonthly: round(net.div(12)),
    lostAbroad: round(lostAbroad),
    effectiveRatePct: gross.gt(0) ? round(gross.minus(net).div(gross).times(100)) : 0,
  };
}
