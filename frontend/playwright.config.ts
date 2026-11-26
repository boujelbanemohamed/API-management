import { defineConfig } from '@playwright/test';

/**
 * Parcours dans un vrai navigateur, contre le vrai back-end et le vrai Keycloak.
 * Prérequis : socle démarré (deploy/scripts/init.sh --dev). Variables : voir e2e/seed.ts.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  globalSetup: './e2e/seed.ts',
  projects: [
    { name: 'portail', testMatch: 'portail.spec.ts', use: { baseURL: 'http://localhost:5174' } },
    { name: 'console', testMatch: 'console.spec.ts', use: { baseURL: 'http://localhost:5173' } },
  ],
  use: {
    locale: 'fr-FR',
    timezoneId: 'Africa/Tunis',
    trace: 'retain-on-failure',
    launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
  },
  webServer: [
    { command: 'npm run dev -w portail', url: 'http://localhost:5174/config.json', reuseExistingServer: true, timeout: 60_000 },
    { command: 'npm run dev -w console', url: 'http://localhost:5173/config.json', reuseExistingServer: true, timeout: 60_000 },
  ],
});
