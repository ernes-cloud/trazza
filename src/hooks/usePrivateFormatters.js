import { useMemo } from 'react';
import { usePrivacyMode } from '@/contexts/PrivacyModeContext';
import {
  formatMoney as rawMoney,
  formatMoneyCompact as rawMoneyCompact,
  formatNumber as rawNumber,
  formatPercent as rawPercent,
} from '@/lib/formatters';

export const PRIVATE_MASK = '••••';

/**
 * Los formateadores de lib/formatters, pero ENMASCARADOS en modo privacidad.
 *
 * Una pantalla que pinta la cartera del usuario los toma de aquí en vez de
 * importarlos: así no hay que acordarse de envolver cada cifra. En brokers la
 * tabla de escritorio, las listas de dividendos/comisiones/liquidez, los
 * gráficos mensuales y las ventas realizadas enseñaban importes, cantidades y
 * porcentajes con la privacidad activada (solo se tapaban las tarjetas de
 * arriba). Misma regla que el Dashboard: se ocultan importes, cantidades
 * (cantidad × precio público = tu valor) y porcentajes de la cartera.
 *
 * Lo PÚBLICO —el precio de mercado de un activo— se formatea con el de
 * lib/formatters directamente.
 */
export function usePrivateFormatters() {
  const { privacyMode } = usePrivacyMode();
  return useMemo(() => {
    const mask = (fn) => (...args) => (privacyMode ? PRIVATE_MASK : fn(...args));
    return {
      privacyMode,
      formatMoney: mask(rawMoney),
      formatMoneyCompact: mask(rawMoneyCompact),
      formatNumber: mask(rawNumber),
      formatPercent: mask(rawPercent),
    };
  }, [privacyMode]);
}
