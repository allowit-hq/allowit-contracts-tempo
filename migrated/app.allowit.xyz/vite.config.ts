import {defineConfig, type ViteDevServer} from 'vite';
import react from '@vitejs/plugin-react';
import {serveProxy} from './server-proxy/dev-adapter';
import {RUST_ONLY_ROUTE} from './server-proxy/transport';

const apiMode = process.env.ALLOWIT_API_MODE ?? 'rust';
type MiddlewareServer = Pick<ViteDevServer, 'middlewares'>;
const installTransport = (server: MiddlewareServer) => {
  server.middlewares.use((req, res, next) => {
    if (!req.url?.startsWith('/api/')) return next();
    void serveProxy(req, res, {...process.env, ALLOWIT_API_MODE: apiMode});
  });
};
// Without the Rust transport, owner answers must also be refused in preview.
const installRustOnly = (server: MiddlewareServer) => {
  server.middlewares.use((req, res, next) => {
    if (!RUST_ONLY_ROUTE.test(req.url ?? '')) return next();
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({error: 'Owner requests need the Rust API transport.'}));
  });
};

export default defineConfig({
  plugins: [react(), apiMode === 'rust' || apiMode === 'mock'
    ? {name: 'allowit-api-transport', configureServer: installTransport, configurePreviewServer: installTransport}
    : {name: 'allowit-rust-only-routes', configureServer: installRustOnly, configurePreviewServer: installRustOnly}],
  server: {
    watch: {ignored: ['**/.vercel/**', '**/.data/**', '**/.wip/**', '**/artifacts/**']},
    port: 5173,
    proxy: apiMode === 'rust' || apiMode === 'mock' ? {} : {
      '/api': process.env.ALLOWIT_E2E_BACKEND_URL || 'http://127.0.0.1:8080',
      '/__devnet/api': {target: process.env.ALLOWIT_DEVNET_BACKEND_URL || 'http://127.0.0.1:8083', rewrite: (path: string) => path.replace(/^\/__devnet(?=\/api\/)/, '')},
    },
  },
  // Wallet flows load shared UI entry points and viem's secp256k1 lazily. Pre-bundling keeps the dev server from re-optimizing mid-session,
  // which changes the dependency hash and breaks the already-loaded page's dynamic import.
  optimizeDeps: {include: ['@allowit/engine/stellar/stellar-wallet', '@allowit/engine/wallet/authenticate-wallet', 'viem', 'viem/accounts', 'viem/chains', 'viem/tempo', 'viem > @noble/curves/secp256k1']},
  build: {
    sourcemap: false,
    rollupOptions: {output: {manualChunks(id) {
      if (/node_modules\/(?:react|react-dom|scheduler)\//.test(id) || id.includes('commonjsHelpers')) return 'react-runtime';
    }}},
  },
});
