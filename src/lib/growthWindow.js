/**
 * Ventana "1D" del gráfico de rendimiento: los dos últimos puntos, con el
 * primero como BASE (0 %), para que mida solo la última sesión.
 *
 * En el resto de rangos el primer día cuenta su propia sesión (desde el cierre
 * anterior) y el benchmark se basa en el cierre previo a propósito — ver
 * `mergeBenchmarkSeries`. Pero la línea necesita dos puntos, y con esa regla el
 * 1D encadenaba DOS sesiones: −1,78 % en la demo con el Dashboard diciendo
 * −0,76 % hoy. Aquí el primer punto deja de aportar rentabilidad y el índice se
 * cruza solo con el segundo (el componente lo hace con `isOneDayBase`).
 *
 * @template {{ isolatedTTWROR?: number }} T
 * @param {T[]} points
 * @returns {Array<T & { isOneDayBase?: boolean }>}
 */
export function oneDayWindow(points) {
  const lastTwo = (points || []).slice(-2);
  if (lastTwo.length < 2) return lastTwo;
  return [{ ...lastTwo[0], isolatedTTWROR: 0, isOneDayBase: true }, lastTwo[1]];
}
