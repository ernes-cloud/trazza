// Lista declarativa de mutantes para `npm run mutants` (tools/mutants/run-mutants.mjs).
//
// Cada mutante: { id, file, from, to, tests, why }. El runner sustituye `from` por `to`
// (debe aparecer EXACTAMENTE una vez en `file`), lanza vitest sobre `tests` y espera que
// falle (killed). Si los tests pasan con el mutante, la regla que describe `why` no la
// protege ningún test (SURVIVED).
//
// Al cambiar el código de una de estas líneas, actualiza aquí `from`: el runner corta con
// «NO ENCONTRADO» antes de dar por buena una lista desfasada.

const FISCAL_TESTS = [
  'src/services/tax/twoMonthRule.test.js',
  'src/services/taxReportService.twoMonth.test.js',
  'src/services/taxReportService.test.js',
  'src/services/publicTools/capitalGains.test.js',
];
const DEPLOY_TESTS = ['tools/deployVps.test.js'];

const RULE = 'src/services/tax/twoMonthRule.js';
const REPORT = 'src/services/taxReportService.js';
const DEPLOY = 'deploy/deploy-vps.sh';

export const MUTANTS = [
  // ── Regla de los dos meses (núcleo compartido) ────────────────────────────────
  {
    id: 'rule-window-1-month', file: RULE, tests: FISCAL_TESTS,
    why: 'la ventana es de dos meses antes y después (art. 33.5.f LIRPF)',
    from: 'return { from: addMonths(date, -2), to: addMonths(date, 2) };',
    to: 'return { from: addMonths(date, -1), to: addMonths(date, 1) };',
  },
  {
    id: 'rule-release-all', file: RULE, tests: FISCAL_TESTS,
    why: 'una venta definitiva solo libera la parte de las acciones sin nueva reposición',
    from: 'if (pendingShares > EPS) released = pendingAmount * (carryLeft / pendingShares);',
    to: 'if (pendingShares > EPS) released = pendingAmount;',
  },
  {
    id: 'rule-not-proportional', file: RULE, tests: FISCAL_TESTS,
    why: 'con recompra parcial solo se aplaza la parte proporcional',
    from: 'const own = isLoss ? -gain * (take / baseQty) : 0;',
    to: 'const own = isLoss ? -gain : 0;',
  },
  {
    id: 'rule-computable-without-deferred', file: RULE, tests: FISCAL_TESTS,
    why: 'lo computable descuenta lo aplazado',
    from: 'computable: gain == null ? null : gain + deferred - released,',
    to: 'computable: gain == null ? null : gain - released,',
  },
  // ── Historial parcial: la parte conocida ──────────────────────────────────────
  {
    id: 'partial-core-no-known-part', file: RULE, tests: FISCAL_TESTS,
    why: 'knownPartOnly: el importe de las unidades sin compra no cuenta como ganancia',
    from: 'const excludedProceeds = knownPartOnly && proceedsKnown ? op.netProceedsEur * (missingShares / op.qty) : 0;',
    to: 'const excludedProceeds = 0;',
  },
  {
    id: 'partial-core-defer-all-shares', file: RULE, tests: FISCAL_TESTS,
    why: 'knownPartOnly: solo las unidades conocidas buscan reposición',
    from: 'const need0 = isLoss ? baseQty : Math.min(pendingShares, op.qty);',
    to: 'const need0 = isLoss ? op.qty : Math.min(pendingShares, op.qty);',
  },
  {
    id: 'partial-core-share-over-all', file: RULE, tests: FISCAL_TESTS,
    why: 'knownPartOnly: lo aplazado se reparte sobre las unidades conocidas',
    from: 'const own = isLoss ? -gain * (take / baseQty) : 0;',
    to: 'const own = isLoss ? -gain * (take / op.qty) : 0;',
  },
  {
    id: 'partial-report-excludes-sale', file: REPORT, tests: FISCAL_TESTS,
    why: 'el informe computa la parte conocida de una venta con historial parcial',
    from: 'const core = applyTwoMonthRule(opsSorted.map((o) => o.op), { knownPartOnly: true });',
    to: 'const core = applyTwoMonthRule(opsSorted.map((o) => o.op), { knownPartOnly: false });',
  },
  {
    id: 'partial-report-share-eps', file: REPORT, tests: FISCAL_TESTS,
    why: 'una compra fraccionaria (0,001) no se traga como «sin historial»',
    from: 'const SHARE_EPS = 1e-8;',
    to: 'const SHARE_EPS = 0.01;',
  },
  // ── Agrupación por ISIN (art. 37.2) ───────────────────────────────────────────
  {
    id: 'isin-grouping-by-currency', file: REPORT, tests: FISCAL_TESTS,
    why: 'valores homogéneos = mismo ISIN, sin la divisa',
    from: "if (isin) return { key: `ISIN:${isin}`, byName: false };",
    to: "if (isin) return { key: `ISIN:${isin}:${row?.moneda || 'EUR'}`, byName: false };",
  },
  // ── Comisiones dentro de los valores (art. 35) ────────────────────────────────
  {
    id: 'fee-buy-outside-values', file: REPORT, tests: FISCAL_TESTS,
    why: 'la comisión de compra suma al valor de adquisición',
    from: 'return { value: gross + sign * fee * fr.rate, miss: null };',
    to: 'return { value: gross + (sign > 0 ? 0 : sign * fee * fr.rate), miss: null };',
  },
  {
    id: 'fee-sell-outside-values', file: REPORT, tests: FISCAL_TESTS,
    why: 'la comisión de venta resta del valor de transmisión',
    from: 'return { value: gross + sign * fee * fr.rate, miss: null };',
    to: 'return { value: gross + (sign < 0 ? 0 : sign * fee * fr.rate), miss: null };',
  },
  {
    id: 'fee-trade-also-in-fees', file: REPORT, tests: FISCAL_TESTS,
    why: '«fees» solo lleva los gastos no imputables (no las de compraventa)',
    from: 'if (applyRule && c.isTradeCommission) continue;',
    to: 'if (false && c.isTradeCommission) continue;',
  },
  // ── CSV ───────────────────────────────────────────────────────────────────────
  {
    id: 'csv-round-trunc', file: REPORT, tests: FISCAL_TESTS,
    why: 'el CSV redondea al céntimo (x,xx5 sube)',
    from: 'const num = (v) => (Math.round(v * 100) / 100)',
    to: 'const num = (v) => (Math.trunc(v * 100) / 100)',
  },
  // ── fx_rate del bróker (sentido EUR por unidad de divisa) ─────────────────────
  {
    id: 'degiro-fx-not-inverted', file: 'src/lib/parsers/degiroParser.js',
    tests: ['src/services/tax/degiroFxRate.contract.test.js'],
    why: 'el «Tipo» de DEGIRO (divisa por EUR) hay que invertirlo antes de guardarlo como fx_rate',
    from: 'fill.hasFX = true;',
    to: 'fill.hasFX = true; fill.fxRate = Math.abs(fill.total) / fill.totalEUR;',
  },

  // ── deploy/deploy-vps.sh ──────────────────────────────────────────────────────
  {
    id: 'deploy-source-guard', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'con source o bash -s no se ejecuta nada',
    from: 'if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then',
    to: 'if false; then',
  },
  {
    id: 'deploy-d-repeated', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'd) no se repite en el mismo despliegue',
    from: '[[ -z $(state_get done_d) ]] || die "d) ya está hecha',
    to: 'true || die "d) ya está hecha',
  },
  {
    id: 'deploy-nginx-backup-not-by-id', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'la copia de nginx es una por despliegue (ID) y se reutiliza',
    from: 'NGX_BAK() { echo "$BACKUPS/nginx-$ID"; }',
    to: 'NGX_BAK() { echo "$BACKUPS/nginx-$ID-$(date +%s%N)"; }',
  },
  {
    id: 'deploy-c1-no-check-marker', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'c1 comprueba el marcador y HEAD (escribe app.html y 404.html en el webroot)',
    from: 'start_log "$TS"; not_rolled_back; need c0; check_marker',
    to: 'start_log "$TS"; not_rolled_back; need c0',
  },
  {
    id: 'deploy-c2-dry-no-check-marker', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'c2-dry comprueba el marcador y HEAD',
    from: 'phase_c2_dry() {\n  start_log "$TS"; need d; check_marker',
    to: 'phase_c2_dry() {\n  start_log "$TS"; need d',
  },
  {
    id: 'deploy-d-no-check-marker', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'd) comprueba el marcador y HEAD',
    from: 'start_log "$TS"; not_rolled_back; need c1; check_marker',
    to: 'start_log "$TS"; not_rolled_back; need c1',
  },
  {
    id: 'deploy-c2-no-check-marker', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'c2 comprueba el marcador y HEAD',
    from: 'start_log "$TS"; need c2_dry; need server; check_marker',
    to: 'start_log "$TS"; need c2_dry; need server',
  },
  {
    id: 'deploy-server-no-check-marker', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'server comprueba el marcador y HEAD',
    from: 'phase_server() {\n  start_log "$TS"; need d; check_marker',
    to: 'phase_server() {\n  start_log "$TS"; need d',
  },
  {
    id: 'deploy-c2-without-server', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'c2 (web nueva) exige server antes: el cliente nuevo llama a endpoints del server nuevo',
    from: 'start_log "$TS"; need c2_dry; need server; check_marker',
    to: 'start_log "$TS"; need c2_dry; check_marker',
  },
  {
    id: 'deploy-server-after-c2', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'server se despliega tras d) y ANTES de c2 (no espera a la web)',
    from: 'phase_server() {\n  start_log "$TS"; need d; check_marker',
    to: 'phase_server() {\n  start_log "$TS"; need c2; check_marker',
  },
  {
    id: 'deploy-update-mid-deploy', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'update no mueve HEAD con un despliegue a medias',
    from: 'if open_deploy && [[ ${NUEVO:-} != 1 ]]; then\n    die "$(open_msg). update movería',
    to: 'if false; then\n    die "$(open_msg). update movería',
  },
  {
    id: 'deploy-rollback-nginx-keeps-d', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'rollback-nginx invalida d) y lo que depende de ella',
    from: 'for ph in d c2_dry c2 server e; do state_del "done_$ph"; done',
    to: 'for ph in c2_dry c2 server e; do state_del "done_$ph"; done',
  },
  {
    id: 'deploy-rollback-nginx-keeps-server-e', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'rollback-nginx invalida también server y e (record ya no vale)',
    from: 'for ph in d c2_dry c2 server e; do state_del "done_$ph"; done',
    to: 'for ph in d c2_dry c2; do state_del "done_$ph"; done',
  },
  {
    id: 'deploy-rollback-web-without-nginx', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'rollback-web exige rollback-nginx antes',
    from: '[[ -z $(state_get done_d) ]] || die "la config nueva de nginx (d) sigue puesta',
    to: 'true || die "la config nueva de nginx (d) sigue puesta',
  },
  {
    id: 'deploy-retirar-not-slugs', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'RETIRAR es una lista de slugs publicados, no un número',
    from: '[[ -d $WEB/blog/$s ]] || die "RETIRAR: «$s» no está publicado',
    to: 'true || die "RETIRAR: «$s» no está publicado',
  },
  {
    id: 'deploy-retirar-dash', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'RETIRAR=-e (o cualquier valor que empiece por -) se rechaza',
    from: '[[ $s != -* && $s != */*',
    to: '[[ $s != */*',
  },
  {
    id: 'deploy-retirar-substring', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'los slugs de RETIRAR se comparan exactos',
    from: 'grep -qxF -- "$1" <<< "$(retirar_list)"',
    to: 'grep -qF -- "$1" <<< "$(retirar_list)"',
  },
  {
    id: 'deploy-retirar-sigpipe', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'in_retirar no va por una tubería a grep -q (SIGPIPE + pipefail da un slug retirado por no retirado)',
    from: 'in_retirar() { grep -qxF -- "$1" <<< "$(retirar_list)"; }',
    to: 'in_retirar() { retirar_list | grep -qxF -- "$1"; }',
  },
  {
    id: 'deploy-e-curl-pipe-grep', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'las comprobaciones de cabeceras de e) no van por una tubería a grep -q (SIGPIPE con cabeceras largas)',
    from: `grep -qiE '^x-robots-tag:.*noindex' <<< "$(curl -sI "$SITE/share/00000000-0000-0000-0000-000000000000")"`,
    to: `curl -sI "$SITE/share/00000000-0000-0000-0000-000000000000" | grep -qiE '^x-robots-tag:.*noindex'`,
  },
  {
    id: 'deploy-retirar-duplicates', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'un slug repetido en RETIRAR cuenta una vez',
    from: "| sed '/^$/d' | sort -u |",
    to: "| sed '/^$/d' | sort |",
  },
  {
    id: 'deploy-blog-deletes-outside-retirar', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'c2 solo borra de blog/ lo que está en RETIRAR',
    from: 'in_retirar "$s" || bad+=("$s")',
    to: 'true || bad+=("$s")',
  },
  {
    id: 'deploy-c2-no-slug-check', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'c2 vuelve a comprobar los slugs que borra',
    from: '  check_blog_deletes "$LOGDIR/c2-dry-$TS.otra.txt"\n',
    to: '  true\n',
  },
  {
    id: 'deploy-c2-no-cmp', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'c2 corta si el dry-run cambió desde c2-dry',
    from: 'cmp -s <(sort "$LOGDIR/c2-dry-$TS.txt") <(sort "$LOGDIR/c2-dry-$TS.otra.txt")',
    to: 'true <(sort "$LOGDIR/c2-dry-$TS.txt") <(sort "$LOGDIR/c2-dry-$TS.otra.txt")',
  },
  {
    id: 'deploy-c2-cmp-unsorted', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'los dry-run se comparan ordenados (rsync intercala la salida de dos procesos)',
    from: 'cmp -s <(sort "$LOGDIR/c2-dry-$TS.txt") <(sort "$LOGDIR/c2-dry-$TS.otra.txt")',
    to: 'cmp -s "$LOGDIR/c2-dry-$TS.txt" "$LOGDIR/c2-dry-$TS.otra.txt"',
  },
  {
    id: 'deploy-dry-run-no-checksum', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'el dry-run compara por contenido, no por tamaño y fecha al segundo',
    from: 'c2_dry_run() { rsync -a --checksum --delete',
    to: 'c2_dry_run() { rsync -a --delete',
  },
  {
    id: 'deploy-c2-rsync-no-checksum', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'c2 publica por contenido, no por tamaño y fecha al segundo',
    from: 'if ! rsync -a --checksum --delete "${EXC[@]}" "$DIST/" "$WEB/"; then',
    to: 'if ! rsync -a --delete "${EXC[@]}" "$DIST/" "$WEB/"; then',
  },
  {
    id: 'deploy-c2-partial-unmarked', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'un c2 que falla a mitad queda marcado como parcial',
    from: '    state_set c2_parcial 1\n',
    to: '    true\n',
  },
  {
    id: 'deploy-nuevo-d-applied', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'b con NUEVO=1 se niega si d) está aplicada (la config de antes solo vive en nginx-<ID viejo>)',
    from: 'if [[ -n $(state_get done_d) ]]; then\n    motivos+=',
    to: 'if false; then\n    motivos+=',
  },
  {
    id: 'deploy-nuevo-c2-parcial', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'b con NUEVO=1 se niega si hay un c2 parcial (el tar del nuevo saldría del webroot a medias)',
    from: 'if [[ -n $(state_get c2_parcial) ]]; then\n    motivos+=',
    to: 'if false; then\n    motivos+=',
  },
  {
    id: 'deploy-nuevo-d-cortada', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'b con NUEVO=1 se niega si una d) cortada dejó en disco una config distinta de la copia nginx-<ID>',
    from: 'elif nginx_disco_distinto; then',
    to: 'elif false; then',
  },
  {
    id: 'deploy-rollback-web-d-cortada', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'rollback-web se niega si una d) cortada dejó en disco una config distinta de la copia nginx-<ID> (si no, cierra con la config nueva y el b siguiente la copia como «la de antes»)',
    from: '! nginx_disco_distinto || die',
    to: 'true || die',
  },
  {
    id: 'deploy-nuevo-web-publicado', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'b con NUEVO=1 se niega si c2 publicó el webroot y no hubo rollback-web (aunque sí rollback-nginx)',
    from: 'elif [[ -n $(state_get web_publicado) ]]; then',
    to: 'elif false; then',
  },
  {
    id: 'deploy-c2-no-web-publicado', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'c2 marca web_publicado antes del rsync',
    from: '  state_set web_publicado 1\n',
    to: '  true\n',
  },
  {
    id: 'deploy-rollback-nginx-clears-web-publicado', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'rollback-nginx NO quita web_publicado (solo rollback-web, que es quien devuelve el webroot)',
    from: 'for ph in d c2_dry c2 server e; do state_del "done_$ph"; done',
    to: 'for ph in d c2_dry c2 server e; do state_del "done_$ph"; done; state_del web_publicado',
  },
  {
    id: 'deploy-rollback-web-keeps-web-publicado', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'rollback-web quita web_publicado (el webroot vuelve a ser el del tar de b)',
    from: '  state_del web_publicado\n  mark rollback_web',
    to: '  mark rollback_web',
  },
  {
    id: 'deploy-rolled-back-resumable', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'tras rollback-web el despliegue está cerrado: c0, c1 y d se niegan (si no, b arranca otro sin NUEVO=1 y fotografía lo nuevo como «lo de antes»)',
    from: '  [[ -z $(state_get done_rollback_web) ]] \\\n    || die "este despliegue',
    to: '  true \\\n    || die "este despliegue',
  },
  {
    id: 'deploy-d-resumable-after-rollback-web', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'd en concreto (la fase que vuelve a poner la config nueva de nginx) se niega tras rollback-web',
    from: 'start_log "$TS"; not_rolled_back; need c1;',
    to: 'start_log "$TS"; need c1;',
  },
  {
    id: 'deploy-c0-resumable-after-rollback-web', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'c0 en concreto se niega tras rollback-web',
    from: 'start_log "$TS"; not_rolled_back; need b;',
    to: 'start_log "$TS"; need b;',
  },
  {
    id: 'deploy-c1-resumable-after-rollback-web', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'c1 en concreto se niega tras rollback-web',
    from: 'start_log "$TS"; not_rolled_back; need c0;',
    to: 'start_log "$TS"; need c0;',
  },
  {
    id: 'deploy-nuevo-forzado-sin-log', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'con FORZAR_NUEVO=1, lo que se pierde queda en el log del despliegue nuevo',
    from: 'for aviso in ${AVISOS_FORZADO[@]+"${AVISOS_FORZADO[@]}"}; do say "$aviso"; done',
    to: 'true',
  },
  {
    id: 'deploy-empty-array-bash43', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'con bash < 4.4 y set -u, AVISOS_FORZADO vacío no se expande a pelo (todo b caía, ya con el estado movido)',
    from: 'for aviso in ${AVISOS_FORZADO[@]+"${AVISOS_FORZADO[@]}"}; do',
    to: 'for aviso in "${AVISOS_FORZADO[@]}"; do',
  },
  {
    id: 'deploy-nuevo-forzado-sin-estado', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'el estado nuevo registra qué despliegue se abandonó (ABANDONADO) y si fue forzado (FORZADO)',
    from: '(( ${#AVISOS_FORZADO[@]} == 0 )) || state_set FORZADO 1',
    to: 'true',
  },
  {
    id: 'deploy-nuevo-forzar-ignored', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'FORZAR_NUEVO=1 se salta las dos negativas de NUEVO=1',
    from: 'if [[ ${FORZAR_NUEVO:-} != 1 ]]; then',
    to: 'if true; then',
  },
  {
    id: 'deploy-prerender-min', file: DEPLOY, tests: DEPLOY_TESTS,
    why: 'el prerender exige X = Y y X ≥ 16 + V',
    from: '(( 10#$x >= 16 + V ))',
    to: '(( 10#$x >= 16 ))',
  },
  {
    id: 'asset-meta-true-or-exists',
    file: 'supabase/migrations/20261026000100_asset_market_data_service_role.sql',
    tests: ['server/lib/pg20261026.migration.test.js'],
    why: 'update_asset_metadata solo toca activos con posición propia (no true OR EXISTS)',
    from: '  WHERE a.id = p_asset_id\n    AND EXISTS (\n      SELECT 1 FROM public.positions p\n      WHERE p.asset_id = a.id\n        AND (\n          EXISTS (SELECT 1 FROM public.brokers b WHERE b.id = p.broker_id AND b.user_id = auth.uid())\n          OR EXISTS (SELECT 1 FROM public.portfolios pf WHERE pf.id = p.portfolio_id AND pf.user_id = auth.uid())\n        )\n    );',
    to: '  WHERE a.id = p_asset_id\n    AND (true OR EXISTS (\n      SELECT 1 FROM public.positions p\n      WHERE p.asset_id = a.id\n        AND (\n          EXISTS (SELECT 1 FROM public.brokers b WHERE b.id = p.broker_id AND b.user_id = auth.uid())\n          OR EXISTS (SELECT 1 FROM public.portfolios pf WHERE pf.id = p.portfolio_id AND pf.user_id = auth.uid())\n        )\n    ));',
  },
  {
    id: 'force-price-no-reason',
    file: 'server/routes/adminForceAssetPrice.js',
    tests: ['server/routes/adminForceAssetPrice.test.js'],
    why: 'force-asset-price exige reason no vacío',
    from: "  if (!reason) {\n    return res.status(400).json({ error: 'reason (non-empty string) required' });\n  }\n",
    to: '  // mutant: sin chequeo de reason\n',
  },
  {
    id: 'force-price-coerce-number',
    file: 'server/routes/adminForceAssetPrice.js',
    tests: ['server/routes/adminForceAssetPrice.test.js'],
    why: 'price solo typeof number (rechaza "10", true)',
    from: '  const price = req.body?.price;\n',
    to: '  const price = Number(req.body?.price);\n',
  },
  {
    id: 'force-price-clear-null-rpc',
    file: 'server/routes/adminForceAssetPrice.js',
    tests: ['server/routes/adminForceAssetPrice.test.js'],
    why: 'no volver al clear-NULL + update_asset_market_data',
    from: "  const { data: applied, error: rpcErr } = await supabaseAdmin.rpc('force_asset_price', {\n    p_asset_id: assetId,\n    p_new_price: price,\n    p_reason: reason,\n    p_admin_user_id: user.id,\n  });\n",
    to: "  await supabaseAdmin.from('assets').update({ current_price: null }).eq('id', assetId);\n  const { data: applied, error: rpcErr } = await supabaseAdmin.rpc('update_asset_market_data', {\n    p_asset_id: assetId,\n    p_current_price: price,\n  });\n",
  },
  {
    id: 'force-price-no-audit-rpc',
    file: 'server/routes/adminForceAssetPrice.js',
    tests: ['server/routes/adminForceAssetPrice.test.js'],
    why: 'la auditoría es force_asset_price (tabla), no solo addLog',
    from: "  const { data: applied, error: rpcErr } = await supabaseAdmin.rpc('force_asset_price', {\n    p_asset_id: assetId,\n    p_new_price: price,\n    p_reason: reason,\n    p_admin_user_id: user.id,\n  });\n  if (rpcErr) return res.status(500).json({ error: rpcErr.message });\n  if (applied === false) {\n    return res.status(500).json({ error: 'force_asset_price rejected the update' });\n  }\n\n  addLog('info', 'system', `force-asset-price ${row.ticker || assetId}: ${row.current_price} → ${price}`, {\n    assetId, by: user.id, reason,\n  });\n",
    to: "  const { error: updErr } = await supabaseAdmin.from('assets').update({ current_price: price }).eq('id', assetId);\n  if (updErr) return res.status(500).json({ error: updErr.message });\n  addLog('info', 'system', `force-asset-price ${row.ticker || assetId}: ${row.current_price} → ${price}`, {\n    assetId, by: user.id, reason,\n  });\n",
  },
  {
    id: 'force-price-ignore-applied-false',
    file: 'server/routes/adminForceAssetPrice.js',
    tests: ['server/routes/adminForceAssetPrice.test.js'],
    why: 'applied===false debe devolver 500 (RPC rechazó el update)',
    from: "  if (applied === false) {\n    return res.status(500).json({ error: 'force_asset_price rejected the update' });\n  }\n",
    to: '  // mutant: ignore applied===false\n',
  },
  {
    id: 'force-price-ignore-rpc-err',
    file: 'server/routes/adminForceAssetPrice.js',
    tests: ['server/routes/adminForceAssetPrice.test.js'],
    why: 'rpcErr debe devolver 500 (fallo de la RPC)',
    from: '  if (rpcErr) return res.status(500).json({ error: rpcErr.message });\n',
    to: '  // mutant: ignore rpcErr\n',
  },
  {
    id: 'readErr',
    file: 'server/routes/adminForceAssetPrice.js',
    tests: ['server/routes/adminForceAssetPrice.test.js'],
    why: 'un fallo al leer el asset es 500, no un 404 «asset not found»',
    from: '  if (readErr) return res.status(500).json({ error: readErr.message });\n',
    to: '  // mutant: ignore readErr\n',
  },
  {
    id: 'validate-existing-first',
    file: 'supabase/migrations/20261027000100_assets_insert_server_only.sql',
    tests: ['server/lib/pg20261026.migration.test.js'],
    why: 'ensure_asset devuelve el existente ANTES de validar (legados con ISIN/divisa raros no rompen el import)',
    from: '  IF FOUND THEN\n    RETURN aid;\n  END IF;\n',
    to: '  -- mutant: sin early return del existente\n',
  },
  // ── Cash M2 (liquidez duplicada) ────────────────────────────────────────────
  {
    id: 'cash-m2-pos-sin-broker',
    file: 'src/lib/cashIdentity.js',
    tests: [
      'src/lib/cashIdentity.test.js',
      'src/lib/cashIdentity.m2.test.js',
      'src/lib/cashIdentity.r12.test.js',
      'src/hooks/useManualEntries.cash.v2.test.js',
      'src/services/import/existingAssets.cashRefs.test.js',
    ],
    why: 'findCashPosition no debe abonar liquidez de otro broker',
    from: '    if (brokerId != null && p?.broker_id != null && p.broker_id !== brokerId) continue;',
    to: '    /* mutant cash-m2-pos-sin-broker */',
  },
  {
    id: 'cash-m2-isTicker-sin-upper',
    file: 'src/lib/cashIdentity.js',
    tests: [
      'src/lib/cashIdentity.test.js',
      'src/lib/cashIdentity.m2.test.js',
      'src/lib/cashIdentity.r12.test.js',
    ],
    why: 'matchesCashIdentity / isCashTickerForCurrency normaliza trim/toUpperCase',
    from: "export function currencyFromCanonicalCashTicker(ticker) {\n  const t = String(ticker ?? '').trim().toUpperCase();\n  const m = t.match(CANONICAL_CASH_RE);\n  return m ? m[1] : null;\n}",
    to: "export function currencyFromCanonicalCashTicker(ticker) {\n  const t = String(ticker ?? '');\n  const m = t.match(CANONICAL_CASH_RE);\n  return m ? m[1] : null;\n}",
  },
  {
    id: 'cash-m2-planner-sin-findCashPosition',
    file: 'src/services/import/importPlanner.js',
    tests: [
      'src/services/import/importPlanner.cash.test.js',
      'src/services/import/existingAssets.cashRefs.test.js',
    ],
    why: 'el planner resuelve liquidez por la posición del broker',
    from: '    const cashPos = isCashRow\n      ? findCashPosition(existingPositions, { currency: cashCur })\n      : null;',
    to: '    const cashPos = null;',
  },
  {
    id: 'cash-m2-share-filter-wiring',
    file: 'server/routes/sharePortfolio.js',
    tests: ['server/routes/sharePortfolio.filter.test.js'],
    why: 'getShare debe excluir CASH_* del invertido en el endpoint público',
    from: '    const invested = (rawPositions || []).filter(includesInvestedSharePosition);',
    to: '    const invested = (rawPositions || []).filter(() => true);',
  },
  {
    id: 'cash-m2-notif-filter-wiring',
    file: 'server/jobs/notificationCron.js',
    tests: ['server/jobs/notificationCron.filter.test.js'],
    why: 'el cron no debe vigilar dividendos/earnings de CASH_*',
    from: '  const invested = positions.filter(includesInvestedNotificationPosition);',
    to: '  const invested = positions.filter(() => true);',
  },
];
