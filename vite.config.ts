import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    base: './',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      // Allow the cloud preview gateway host (and any other proxy host).
      // Vite 6 added DNS-rebinding protection that blocks requests whose Host
      // header isn't localhost/127.0.0.1. The preview gateway proxies through
      // an external fcapp.run host, which Vite rejects with "Blocked request…
      // not allowed". `allowedHosts: true` disables the check entirely (safe
      // for a dev server behind a gateway; production builds are static and
      // unaffected). `as const` satisfies Vite's `true | string[]` type.
      allowedHosts: true as const,
      host: '0.0.0.0',
    },
  };
});
