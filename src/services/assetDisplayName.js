import { curatedFundDisplayName } from './import/fundNavEnricher.js';

/**
 * Nombre con el que se ENSEÑA un activo guardado. Una sola definición para la
 * tabla de brokers (escritorio y móvil), el Dashboard (Wallet Map, reparto) y
 * cualquier pantalla que pinte posiciones.
 *
 * Un fondo curado de MyInvestor se enseña con su nombre legible: el extracto
 * lo recorta ("BGIF EM MKT GOVER BOND INDEX D") y ese texto es lo que se
 * guarda. Solo cambia lo que se pinta: `company_name` y la identidad del
 * activo (compartido entre usuarios) siguen como están.
 * @param {{ ticker?: string, company_name?: string } | null | undefined} asset
 * @returns {string | null}
 */
export function assetDisplayName(asset) {
  if (!asset) return null;
  return curatedFundDisplayName(asset.company_name)
    || curatedFundDisplayName(asset.ticker)
    || asset.company_name
    || asset.ticker
    || null;
}
