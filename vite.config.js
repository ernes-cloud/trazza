import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import yahooProfileProxy from './plugins/yahoo-crumb-proxy.js';
import secureApiProxy from './plugins/secure-api-proxy.js';

// Versión del build para telemetría del cliente (`errorTelemetry.js`). Se deriva
// del commit para que no dependa de que alguien suba un número a mano.
function resolveRelease() {
  if (process.env.VITE_APP_VERSION) return process.env.VITE_APP_VERSION;
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return undefined;
  }
}
const RELEASE = resolveRelease();

/** Vite 4 escribe dist/manifest.json; el test de presupuesto (Vite 5) lee dist/.vite/. */
function mirrorManifestToDotVite() {
	return {
		name: 'mirror-manifest-to-dot-vite',
		closeBundle() {
			const root = path.resolve(__dirname, 'dist');
			const src = path.join(root, 'manifest.json');
			if (!fs.existsSync(src)) return;
			const destDir = path.join(root, '.vite');
			fs.mkdirSync(destDir, { recursive: true });
			fs.copyFileSync(src, path.join(destDir, 'manifest.json'));
		},
	};
}

/**
 * M4: `import('@/App')` es dinámico — Vite no pone modulepreload del chunk App
 * en index.html y la hidratación espera una RTT extra. Se inyecta tras el build.
 */
function preloadAppChunk() {
	return {
		name: 'preload-app-chunk',
		closeBundle() {
			const root = path.resolve(__dirname, 'dist');
			const manifestPath = [
				path.join(root, 'manifest.json'),
				path.join(root, '.vite', 'manifest.json'),
			].find((p) => fs.existsSync(p));
			if (!manifestPath) return;
			const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
			const appEntry = Object.values(manifest).find(
				(e) => e?.isDynamicEntry && typeof e.file === 'string' && /(?:^|\/)App-[^/]+\.js$/.test(e.file),
			);
			if (!appEntry?.file) return;
			const href = `/${appEntry.file}`;
			const indexPath = path.join(root, 'index.html');
			if (!fs.existsSync(indexPath)) return;
			let html = fs.readFileSync(indexPath, 'utf8');
			if (html.includes(href)) return;
			const tag = `<link rel="modulepreload" crossorigin href="${href}">`;
			if (html.includes('</head>')) {
				html = html.replace('</head>', `\t${tag}\n\t</head>`);
			} else {
				html = `${tag}\n${html}`;
			}
			fs.writeFileSync(indexPath, html);
		},
	};
}

// Rutas del Express (montadas en server/app.js; index.js solo arranca) que el
// dev server reenvía. En producción las sirve nginx; aquí van una a una porque
// una ruta que falte se la come el dev server y la petición nunca llega.
const EXPRESS_API_PATHS = [
	'/api/market-calendar',
	'/api/validate-import',
	'/api/portfolio-chat',
	'/api/analyze-csv',
	'/api/parse-freeform',
	'/api/score-portfolio',
	'/api/analyze-earnings',
	'/api/log-import',
	'/api/ticker-mappings',
	'/api/assets',
	'/api/log-error',
	'/api/ai',
	'/api/admin',
	'/api/contact',
	'/webhooks',
	'/share-data',
];

export function resolveApiServerTarget({ command, mode, env = process.env } = {}) {
	const url = env.VITE_VALIDATION_SERVER_URL;
	if (url) return url;
	if (command === 'serve' && mode === 'development') {
		throw new Error('VITE_VALIDATION_SERVER_URL no está definida: el dev server no sabe a qué Express mandar /api/*. Arranca con VITE_VALIDATION_SERVER_URL=http://localhost:<puerto de tu server local>.');
	}
	return null;
}

export function expressApiProxy(env = process.env) {
	return {
		name: 'trazza-express-api-proxy',
		config(_, { command, mode }) {
			const target = resolveApiServerTarget({ command, mode, env });
			if (!target) return undefined;
			return {
				server: {
					proxy: Object.fromEntries(EXPRESS_API_PATHS.map((route) => [route, { target, changeOrigin: true }])),
				},
			};
		},
	};
}

export default defineConfig({
	plugins: [
		react(),
		yahooProfileProxy(),
		secureApiProxy(),
		mirrorManifestToDotVite(),
		preloadAppChunk(),
		expressApiProxy(),
	],
	server: {
		cors: true,
		headers: {
			'Cross-Origin-Embedder-Policy': 'credentialless',
		},
		allowedHosts: true,
		proxy: {
			'/api/eodhd': {
				target: 'https://eodhd.com/api',
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/api\/eodhd/, ''),
			},
			'/api/nasdaq': {
				target: 'https://api.nasdaq.com',
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/api\/nasdaq/, ''),
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
					'Accept': 'application/json, text/plain, */*',
					'Origin': 'https://www.nasdaq.com',
					'Referer': 'https://www.nasdaq.com/',
				},
			},
			'/api/frankfurter': {
				target: 'https://api.frankfurter.dev',
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/api\/frankfurter/, '/v1'),
			},
			'/api/yahoo': {
				target: 'https://query1.finance.yahoo.com',
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/api\/yahoo/, ''),
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/Firefox/131.0',
					'Accept': '*/*',
					'Origin': 'https://finance.yahoo.com',
					'Referer': 'https://finance.yahoo.com/'
				}
			},
			'/api/yahoo2': {
				target: 'https://query2.finance.yahoo.com',
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/api\/yahoo2/, ''),
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
					'Accept': '*/*',
					'Origin': 'https://finance.yahoo.com',
					'Referer': 'https://finance.yahoo.com/'
				}
			},
		},
	},
	resolve: {
		extensions: ['.jsx', '.js', '.tsx', '.ts', '.json',],
		alias: {
			'@': path.resolve(__dirname, './src'),
			'react-style-singleton': path.resolve(__dirname, './src/lib/cspStyleSingleton.js'),
		},
	},
	define: {
		'import.meta.env.VITE_APP_VERSION': JSON.stringify(RELEASE ?? ''),
	},
	build: {
		sourcemap: false,
		manifest: true,
		rollupOptions: {
			output: {
				manualChunks(id) {
					const norm = id.replace(/\\/g, '/');
					if (norm.includes('/locales/es.public.json')) {
						return 'i18n-es-public';
					}
					if (
						norm.includes('vite/preload-helper')
						|| norm.includes('vite/modulepreload-polyfill')
						|| norm.includes('vite/dynamic-import-helper')
						|| norm.includes('commonjsHelpers')
						|| /\/_commonjsHelpers/.test(norm)
					) {
						return 'vite-runtime';
					}
					if (
						/\/node_modules\/react\//.test(norm)
						|| /\/node_modules\/react-dom\//.test(norm)
						|| /\/node_modules\/scheduler\//.test(norm)
					) {
						return 'vendor-react';
					}
					if (norm.includes('node_modules/@supabase/')) {
						return 'vendor-supabase';
					}
					if (norm.includes('node_modules/framer-motion')) {
						return 'vendor-motion';
					}
				},
			},
		}
	}
});
