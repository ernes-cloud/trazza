// Clasifica una ejecución de vitest con un mutante aplicado (tools/mutants/run-mutants.mjs).
//
//   INTERRUMPIDO  vitest murió por una señal o spawnSync no devolvió status: no dice nada del
//                 mutante, y el runner tiene que restaurar el fichero y cortar.
//   killed        algún test en rojo (testsFailed): el mutante está cazado.
//   ERROR         salida ≠ 0 sin ningún test en rojo (error de arranque, de sintaxis…): no
//                 cuenta como killed, porque ningún assert lo ha visto.
//   SURVIVED      todo en verde con el mutante: ningún test protege esa regla.
export function classifyRun({ code, signal, testsFailed }) {
  if (signal || code === null || code === undefined) return 'INTERRUMPIDO';
  if (code === 0) return 'SURVIVED';
  return testsFailed ? 'killed' : 'ERROR';
}
