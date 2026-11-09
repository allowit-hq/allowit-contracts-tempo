import {defineConfig} from '@playwright/test';
// Fixture display/refusal checks only; no wallet signatures, sends or live chain acceptance.
const remote = process.env.ALLOWIT_TEMPO_UI_BROWSER_URL;
if (remote && (new URL(remote).protocol !== 'https:' || !new URL(remote).hostname.endsWith('.up.railway.app'))) throw new Error('Fixture browser URL must be the authorized Railway staging deployment.');
const port = Number(process.env.ALLOWIT_TEMPO_UI_PORT ?? '27182');
export default defineConfig({testDir: './tests', testMatch: /tempo-ui-boundaries\.spec\.ts$/, outputDir: '.data/tempo-ui-checks',
  timeout: 30_000, fullyParallel: false, workers: 1, retries: 0,
  use: {baseURL: remote ?? `http://127.0.0.1:${port}`, trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: {executablePath: process.env.ALLOWIT_TEMPO_UI_BROWSER_EXECUTABLE}},
  projects: [{name: 'chromium', use: {browserName: 'chromium', viewport: {width: 1440, height: 1000}}},
    {name: 'chromium-mobile', use: {browserName: 'chromium', viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true}}],
  webServer: remote ? undefined : {command: `pnpm run dev --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false},
});
