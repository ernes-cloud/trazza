# Tests: mutantes y simulaciones

> Creado el 2026-10-22 (revisión F1F2, puntos 5–7). Léelo antes de tocar `tools/mutants/`, `tools/deployVps.test.js` o una regla fiscal que tenga mutante.

## Tests PG opcionales y explícitos

Sin Postgres local, ejecuta la suite normal sin activar PG:

```bash
unset PG_TESTS
nice -n 19 npm test -- --maxWorkers=2 --minWorkers=1
```

Los `*.pg.test.js` usan `tools/oss/pgTestMode.js`: aparecen como omitidos con
el título **PG tests omitidos: define PG_TESTS=1** y un único aviso por ejecución.
Otros archivos PG que adopten el helper reciben el mismo comportamiento.
No se intenta arrancar Postgres. Las omisiones no significan seguridad validada.

Para ejecutar exclusivamente los `*.pg.test.js` contra clusters embebidos locales:

```bash
PG_BIN=/ruta/a/postgresql/bin nice -n 19 npm run test:pg
# En el box de TDD:
PG_BIN=/workspace/trazza-tests/pgbin nice -n 19 npm run test:pg
```

`test:pg` fija `PG_TESTS=1`, exige que `PG_BIN` contenga los ejecutables `initdb`,
`postgres` y `pg_ctl`; `psql` puede estar ahí o en las rutas de sistema que
consulta el arnés (`/usr/lib/postgresql/16/bin`, `/usr/bin`). Usa `--minWorkers=1 --maxWorkers=2`.
Falla antes de lanzar Vitest si falta `PG_BIN`, sus binarios o los archivos PG.
Con PG activado, errores de esquema, montaje, fixture o umbral **fallan**:
nunca se convierten en omisiones. Los puertos se reservan entre workers.
No uses un cluster de producción: el arnés RLS crea y destruye Postgres local.

Para verificar también el test legado cuyo nombre no termina en `.pg.test.js`:

```bash
PG_BIN=/ruta/a/postgresql/bin PG_TESTS=1 nice -n 19 npm test -- server/lib/pg20261026.migration.test.js --maxWorkers=2 --minWorkers=1
```

Nunca ejecutar estos comandos en el VPS de producción. No se descargan ni
instalan binarios desde el arnés. Los contratos TDD pendientes pueden seguir rojos;
consulta los recuentos de pasados, fallados y omitidos, no solo el código de salida.

## `npm run mutants` — pruebas de mutación

`tools/mutants/run-mutants.mjs` aplica, uno a uno, los mutantes de `tools/mutants/mutants.mjs` y lanza vitest sobre los tests de cada uno. Un mutante es una regla rota a propósito: si los tests siguen en verde (`SURVIVED`), ningún test la protege.

```bash
npm run mutants                                    # todos (~10 min: los de deploy simulan el despliegue entero)
node tools/mutants/run-mutants.mjs <id> [<id>…]    # solo esos
node tools/mutants/run-mutants.mjs --list          # ids, fichero y regla que protege cada uno
```

- **Contrato de cada mutante**: `{ id, file, from, to, tests, why }`. `from` tiene que aparecer EXACTAMENTE una vez en `file`; si no aparece (`NO ENCONTRADO`) o aparece varias veces (`AMBIGUO`), el runner falla. Así una lista desfasada no se da por buena: al cambiar una línea con mutante, actualiza su `from` en el mismo commit.
- **Sale con 1** si alguno no es `killed` (`SURVIVED` o `ERROR`), si falta o es ambiguo un `from`, o si la línea base (los tests SIN mutar) está en rojo: con la base en rojo un «killed» no significa nada.
- **«killed» exige un test en rojo** (`Tests N failed` en la salida de vitest). Si vitest sale mal sin ningún test en rojo (error de sintaxis, import roto) el mutante es `ERROR` y NO cuenta como killed (hasta la ronda 10 contaba): el mutante tiene que romper la regla, no el fichero. La clasificación es `tools/mutants/classify.mjs` (con test).
- **Sandbox en `/tmp/trazza-mutants/run-*` con limpieza automática por PID**: cada run escribe `run-*/.runner.pid` y, al arrancar, borra solo carpetas de runners muertos (si el PID del fichero ya no existe). Si hay otro runner vivo, su carpeta NO se toca.
- **El árbol del repo queda intacto**: los mutantes se aplican en la copia del sandbox y no en el checkout principal.
- **Ctrl-C o kill a mitad = `INTERRUMPIDO`.** Vitest se lanza en un grupo de procesos propio (`detached`) y el watcher corta el **grupo entero** (`kill -TERM -pgid`), también cuando muere el runner padre. Así no quedan `vitest` huérfanos ni hijos de `deploy-vps.sh` corriendo en segundo plano tras un SIGKILL.
- No lo lances a la vez que otra suite pesada sobre el mismo host: aunque el runner muta solo la copia sandbox en `/tmp/trazza-mutants/run-*`, compite por CPU/IO y alarga o vuelve más ruidosas las ejecuciones.

Qué cubre hoy (lista completa con `--list`): la regla de los dos meses (ventana de dos meses, liberación proporcional, reparto proporcional, computable con lo aplazado), el historial parcial (parte conocida, reposición solo de las conocidas, `SHARE_EPS`), la agrupación por ISIN, las comisiones dentro de los valores y fuera de `fees`, el redondeo del CSV, el sentido del `fx_rate` de DEGIRO y las guardas de `deploy/deploy-vps.sh` (source/bash -s, d repetida, copia de nginx por ID, `check_marker` en d/c2/server, update a medias, rollback-nginx que invalida d…e, rollback-web tras rollback-nginx, c0/c1/d cerradas tras rollback-web, RETIRAR por slugs exactos y sin duplicados ni valores con «-», borrados de blog fuera de RETIRAR, comparación ordenada y por contenido de los dry-run, c2 parcial marcado, server tras d) y antes de c2 (r18), X ≥ 16+V, `in_retirar` y las cabeceras de e) sin `| grep -q`, las negativas de `NUEVO=1` —d aplicada o cortada (`cmp` con la copia), c2 parcial y `web_publicado` tras un rollback-nginx sin rollback-web— con `FORZAR_NUEVO=1` para saltarlas, y lo forzado en el log y en el estado), y de assets/force-price (`asset-meta-true-or-exists`, `force-price-*`, `readErr`, `validate-existing-first` —estos dos de r18—; los de migración corren con `PG_TESTS=1` y necesitan `PG_BIN` en local).

## `tools/deployVps.test.js` — simulación del despliegue

Corre `deploy/deploy-vps.sh` con una raíz falsa (`DEPLOY_ROOT`) y nginx, systemctl, npm, git y curl falsos. rsync es el real detrás de un envoltorio que solo falla si el test deja el fichero `rsync-falla` (para simular un c2 que se corta a mitad).

**El intermitente «el dry-run ha cambiado desde c2-dry» (causa raíz, 2026-10-22).** En una copia local rsync escribe la salida desde dos procesos: los `*deleting` los emite el generador y llegan reenviados como mensajes, y las líneas de transferencia (`>f…`, `cd…`) las escribe el emisor. Cómo se intercalan depende del planificador. Medido: 400 dry-runs idénticos con 8 procesos quemando CPU dieron 2 órdenes distintos en bruto y uno solo ordenado. Por eso c2 compara los dos dry-runs ORDENADOS (como multiconjunto de líneas, 9766d95f). Hay un test determinista que invierte el dry-run guardado antes de c2. No subas timeouts ni metas reintentos si vuelve a salir: busca qué línea cambia (c2 imprime el `diff`).

`--checksum` en el dry-run y en el rsync de c2 es otra cosa: rsync compara por defecto tamaño + fecha AL SEGUNDO, y el `index.html` nuevo y el viejo pueden medir lo mismo (`index-old1234` / `index-new5678`). Sin `--checksum` no se publicaría ni aparecería en el dry-run. Lo fija el test «compara por contenido».

**SIGPIPE con `pipefail` (9.ª revisión, 2026-10-23).** `productor | grep -q` (o `| head`) falla de forma intermitente bajo `set -o pipefail`: grep -q sale en la primera coincidencia y, si el productor aún escribe, muere con SIGPIPE (141) y la tubería entera da «falso» aunque SÍ había coincidencia. En el script se usa `grep -q … <<< "$(productor)"`. Para que el test no dependa de la carrera, la salida tiene que superar el búfer de una tubería (64 KiB): por eso el test de RETIRAR usa 400 slugs de 200 caracteres y el curl falso acepta `FAKE_CURL_PAD` (3000 cabeceras de relleno detrás de las buscadas). Con una lista corta el fallo existe en producción pero el test pasaría casi siempre.
