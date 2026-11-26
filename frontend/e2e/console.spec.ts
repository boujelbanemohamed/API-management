import { expect, Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { USERS } from './seed';

interface Seed { password: string; requestSubject: string; arbitrationId: string; smtSignId: string; gabName: string; run: string }
const seed = () => JSON.parse(readFileSync(new URL('./.seed.json', import.meta.url), 'utf8')) as Seed;
const menu = (page: Page) => page.getByRole('navigation', { name: 'Menu de la console' });

async function login(page: Page, username: string, path = '/') {
  await page.goto(path);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(seed().password);
  await page.locator('#kc-login').click();
  await expect(menu(page)).toBeVisible();
}

test('agent opérations : menu restreint ; il prépare, il ne peut pas valider lui-même', async ({ page }) => {
  await login(page, USERS.ops1.username);
  await expect(menu(page).getByRole('link', { name: 'File des demandes' })).toBeVisible();
  await expect(menu(page).getByRole('link', { name: 'Facturation' })).toHaveCount(0);
  await expect(menu(page).getByRole('link', { name: 'Journal d’audit' })).toHaveCount(0);

  await menu(page).getByRole('link', { name: 'File des demandes' }).click();
  const row = page.getByRole('row', { name: new RegExp(seed().requestSubject) });
  await row.getByRole('button', { name: 'Prendre en charge' }).click();
  await expect(row).toContainText(USERS.ops1.username);
  await row.getByRole('button', { name: 'Préparer (validation requise)' }).click();
  await expect(row).toContainText('En validation');
  await expect(row).toContainText('Préparée par vous');
  await expect(row.getByRole('button', { name: 'Valider' })).toHaveCount(0);
});

test('second agent : valide la demande préparée (double validation)', async ({ page }) => {
  await login(page, USERS.ops2.username, '/demandes');
  const row = page.getByRole('row', { name: new RegExp(seed().requestSubject) });
  await row.getByRole('button', { name: 'Valider' }).click();
  await expect(row).toContainText('Traitée');
  await expect(row).toContainText('Délai respecté');
});

test('arbitre : rend la décision avec frais (message 1740)', async ({ page }) => {
  await login(page, USERS.arbitre.username, `/litiges/${seed().arbitrationId}`);
  await page.getByLabel('Décision en faveur de').selectOption('ISSUER');
  await page.getByLabel('Frais d’arbitrage (TND)').fill('50');
  await page.getByRole('button', { name: 'Rendre la décision' }).click();
  await expect(page.getByText('Clos : arbitrage rendu')).toBeVisible();
  await expect(page.getByText('1740/700')).toBeVisible();
  await expect(page.getByText(/En faveur de BNA · frais 50,000/)).toBeVisible();
});

test('agent intégration : signe le PV pour SMT, passe en production, l’abonnement de production est actif', async ({ page }) => {
  await login(page, USERS.integ.username, `/mises-en-service/${seed().smtSignId}`);
  await page.getByRole('button', { name: 'Signer le PV pour SMT' }).click();
  await expect(page.getByText(`PV SMT${USERS.integ.username}`)).toBeVisible();
  await page.getByRole('button', { name: 'Passer à l’étape suivante' }).click();
  await expect(page.locator('[aria-current="step"]')).toHaveText('Production');

  await menu(page).getByRole('link', { name: 'Abonnements' }).click();
  const prod = page.getByRole('row', { name: new RegExp(`${seed().gabName}.*Production`) });
  await expect(prod).toContainText('Actif');
});

test('agent intégration : un refus métier est affiché tel quel (production sans PV)', async ({ page }) => {
  await login(page, USERS.integ.username, '/mises-en-service');
  await expect(page.getByRole('table', { name: 'Mises en service' })).toBeVisible();
  await page.getByRole('link', { name: `Services cartes ${seed().run}` }).first().click();
  // Mise en service du portail : PV signé par la banque seulement (test portail) ou pas du tout.
  await page.getByRole('button', { name: 'Passer à l’étape suivante' }).click();
  await expect(page.getByRole('alert')).toContainText('PV de recette doit être signé par la banque et par SMT');
});

test('auditeur : lit le journal, ne peut rien créer', async ({ page }) => {
  await login(page, USERS.audit.username, '/partenaires');
  await expect(page.getByRole('table', { name: 'Partenaires' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ajouter la banque' })).toHaveCount(0);
  await menu(page).getByRole('link', { name: 'Journal d’audit' }).click();
  await page.getByLabel('Auteur').fill(USERS.ops2.username);
  await expect(page.getByRole('table', { name: 'Journal d’audit' })).toContainText('request.validate');
});
