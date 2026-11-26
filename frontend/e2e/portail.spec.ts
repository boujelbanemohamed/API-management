import { expect, Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { USERS } from './seed';

const seed = () => JSON.parse(readFileSync(new URL('./.seed.json', import.meta.url), 'utf8')) as { run: string; apiName: string; freeApiName: string; acceptanceId: string; password: string };

async function login(page: Page, username: string, path = '/') {
  await page.goto(path);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(seed().password);
  await page.locator('#kc-login').click();
  await expect(page.getByRole('navigation', { name: 'Menu du portail' })).toBeVisible();
}

const menu = (page: Page) => page.getByRole('navigation', { name: 'Menu du portail' });
let requestUrl = '';
let disputeUrl = '';

test('opérateur : menu selon ses droits, demande avec carte masquée obligatoire', async ({ page }) => {
  await login(page, USERS.op.username);
  await expect(page.getByRole('heading', { name: `Bonjour ${USERS.op.username}` })).toBeVisible();
  await expect(page.getByText('Banque BNA').or(page.getByText('BNA')).first()).toBeVisible();
  await expect(menu(page).getByRole('link', { name: 'Mes demandes' })).toBeVisible();
  await expect(menu(page).getByRole('link', { name: 'Litiges' })).toHaveCount(0);
  await expect(menu(page).getByRole('link', { name: 'Transactions' })).toBeVisible(); // lot 4b : écran actif

  await menu(page).getByRole('link', { name: 'Mes demandes' }).click();
  await page.getByRole('link', { name: 'Nouvelle demande' }).click();
  await page.getByLabel('Objet').fill('Opposition carte perdue');
  await page.getByLabel('Référence (facultatif)').fill('4123456789012345');
  await page.getByRole('button', { name: 'Envoyer la demande' }).click();
  await expect(page.getByRole('alert')).toContainText('Numéro de carte complet interdit');

  await page.getByLabel('Référence (facultatif)').fill('412345******2345');
  await page.getByRole('button', { name: 'Envoyer la demande' }).click();
  await expect(page.getByRole('heading', { name: 'Opposition carte perdue' })).toBeVisible();
  await expect(page.getByText('Dans les délais')).toBeVisible();
  await expect(page.getByText('412345******2345')).toBeVisible();
  requestUrl = page.url();
});

test('opérateur : une demande GAB part au Cockpit et revient traitée', async ({ page }) => {
  await login(page, USERS.op.username, '/demandes/nouvelle');
  await page.getByLabel('Service concerné').selectOption('GAB');
  await page.getByLabel('Objet').fill(`Débloquer le GAB 0142 ${seed().run}`);
  await page.getByRole('button', { name: 'Envoyer la demande' }).click();
  await expect(page.getByText('Prise en charge')).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Traitée', { exact: true })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByText('Opération exécutée')).toBeVisible();
});

test('opérations : transactions de la seule banque, source affichée, jamais de numéro complet', async ({ page }) => {
  await login(page, USERS.op.username, '/operations/transactions');
  await expect(page.getByText('Source : Plateforme 1')).toBeVisible();
  await page.getByLabel('Canal').selectOption('GAB');
  await page.getByRole('button', { name: 'Rechercher' }).click();
  const rows = page.getByRole('table', { name: 'Transactions' }).locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  for (const cell of await rows.locator('td:nth-child(5)').allTextContents()) expect(cell).toBe('GAB');
  for (const ref of await rows.locator('td:nth-child(2)').allTextContents()) expect(ref.startsWith('BNA')).toBe(true);
  expect(await page.locator('main').innerText()).not.toMatch(/\d{13,19}/);
  // L'opérateur n'a pas la section Litiges : pas de lien « Contester ».
  await expect(page.getByRole('link', { name: 'Contester' })).toHaveCount(0);
});

test('opérations : opposition demandée depuis Services cartes, préremplie', async ({ page }) => {
  await login(page, USERS.op.username, '/operations/cartes');
  await expect(page.getByText('Source : SVIP (SmartVista)')).toBeVisible();
  await page.getByLabel('État').selectOption('ACTIVE');
  await page.getByRole('button', { name: 'Rechercher' }).click();
  const first = page.getByRole('table', { name: 'Cartes' }).locator('tbody tr').first();
  const pan = (await first.locator('td').first().innerText()).trim();
  await first.getByRole('link', { name: 'Opposition' }).click();
  await expect(page.getByLabel('Objet')).toHaveValue(`Opposition de la carte ${pan}`);
  await expect(page.getByLabel('Référence (facultatif)')).toHaveValue(pan);
  await expect(page.getByLabel('Service concerné')).toHaveValue('CARTE');
  await page.getByRole('button', { name: 'Envoyer la demande' }).click();
  await expect(page.getByRole('heading', { name: `Opposition de la carte ${pan}` })).toBeVisible();
  await expect(page.getByText('Nouvelle')).toBeVisible(); // carte : traitée par les agents SMT
});

test('opérations : intervention GAB transmise au Cockpit depuis l’écran GAB', async ({ page }) => {
  await login(page, USERS.op.username, '/operations/gab');
  await expect(page.getByText('Source : SMT Cockpit')).toBeVisible();
  await page.getByRole('link', { name: 'Intervention' }).first().click();
  await expect(page.getByLabel('Service concerné')).toHaveValue('GAB');
  await page.getByRole('button', { name: 'Envoyer la demande' }).click();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Traitée', { exact: true })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
});

test('opérations : administrateur sécurité conteste une transaction, litige prérempli', async ({ page }) => {
  await login(page, USERS.rssi.username, '/operations/transactions');
  const row = page.getByRole('table', { name: 'Transactions' }).locator('tbody tr').filter({ has: page.getByRole('link', { name: 'Contester' }) }).first();
  const ref = (await row.locator('td:nth-child(2)').innerText()).trim();
  await row.getByRole('link', { name: 'Contester' }).click();
  await expect(page.getByLabel('Référence de la transaction')).toHaveValue(ref);
  await expect(page.getByLabel('Numéro de carte masqué')).toHaveValue(/^\d{6}\*{6}\d{4}$/);
  await expect(page.getByLabel('Code de la banque acquéreuse')).not.toHaveValue('');
});

test('opérations : les autres écrans répondent avec leur source', async ({ page }) => {
  await login(page, USERS.op.username, '/operations/commercants');
  await expect(page.getByText('Source : SMT Cockpit')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Commerçants' })).toBeVisible();
  await menu(page).getByRole('link', { name: 'Affiliation e-commerce' }).click();
  await expect(page.getByRole('table', { name: 'Dossiers d’affiliation' })).toBeVisible();
  await menu(page).getByRole('link', { name: 'Accès SmartVista' }).click();
  await expect(page.getByText('Source : SVIP (SmartVista)')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Comptes SmartVista' })).toContainText('bna.');
});

test('cloisonnement : une autre banque ne voit pas la demande', async ({ page }) => {
  expect(requestUrl).not.toBe('');
  await login(page, USERS.litStb.username, new URL(requestUrl).pathname);
  await expect(page.getByRole('alert')).toContainText('Élément introuvable');
  await menu(page).getByRole('link', { name: 'Mes demandes' }).click();
  await expect(page.getByText('Opposition carte perdue')).toHaveCount(0);
});

test('litige : la BNA ouvre et émet un chargeback partiel', async ({ page }) => {
  await login(page, USERS.lit.username, '/litiges/nouveau');
  await page.getByLabel('Référence de la transaction').fill(`TX-${seed().run}`);
  await page.getByLabel('Numéro de carte masqué').fill('4123456789012345');
  await page.getByLabel('Date de la transaction').fill(new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 10));
  await page.getByLabel('Montant (TND)').fill('120,500');
  await page.getByLabel('Code motif').fill('4853');
  await page.getByLabel('Code de la banque acquéreuse').fill('STB');
  await page.getByRole('button', { name: 'Ouvrir le litige' }).click();
  await expect(page.getByText('Format masqué attendu')).toBeVisible();

  await page.getByLabel('Numéro de carte masqué').fill('412345******2345');
  await page.getByRole('button', { name: 'Ouvrir le litige' }).click();
  await expect(page.getByText('Vous êtes émetteur')).toBeVisible();
  await page.getByLabel('Action', { exact: true }).selectOption({ label: 'Émettre le chargeback' });
  await page.getByLabel('Montant contesté (TND)').fill('50');
  await page.getByRole('button', { name: 'Valider l’action' }).click();
  await expect(page.getByText('1442/453')).toBeVisible();
  // Le message ISO part vers la plateforme Chargeback (simulateur) et l'accusé revient.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Accusé par la plateforme')).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByText('C’est à vous d’agir')).toHaveCount(0);
  disputeUrl = page.url();
});

test('litige : la STB (acquéreur) voit que c’est à elle d’agir et représente', async ({ page }) => {
  await login(page, USERS.litStb.username, '/litiges');
  await expect(page.getByRole('row', { name: new RegExp(`TX-${seed().run}`) })).toContainText('à vous');
  await page.goto(new URL(disputeUrl).pathname);
  await expect(page.getByText('Vous êtes acquéreur')).toBeVisible();
  await page.getByLabel('Action', { exact: true }).selectOption({ label: 'Second présentement' });
  await page.getByLabel('Référence du justificatif').fill('ticket-signe.pdf');
  await page.getByRole('button', { name: 'Valider l’action' }).click();
  await expect(page.getByText('1240/205')).toBeVisible();
});

test('développeur : demande de mise en service depuis le catalogue, pas de signature du PV', async ({ page }) => {
  await login(page, USERS.dev.username, '/catalogue');
  // Service déjà en mise en service : la règle métier est affichée telle quelle.
  const busy = page.getByRole('region', { name: seed().apiName });
  await busy.getByLabel('Plan souhaité').selectOption({ index: 1 });
  await busy.getByRole('button', { name: 'Demander la mise en service' }).click();
  await expect(page.getByRole('alert')).toContainText('déjà en cours');

  const card = page.getByRole('region', { name: seed().freeApiName });
  await expect(card).toBeVisible();
  await expect(card).not.toContainText('simulateur');
  await card.getByLabel('Plan souhaité').selectOption({ index: 1 });
  await card.getByRole('button', { name: 'Demander la mise en service' }).click();
  await expect(page.getByRole('heading', { name: `Mise en service — ${seed().freeApiName}` })).toBeVisible();
  await expect(page.locator('[aria-current="step"]')).toHaveText('Demande');

  await page.goto(`/mises-en-service/${seed().acceptanceId}`);
  await expect(page.getByText('Seul l’administrateur sécurité de votre banque peut signer le PV.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Signer le PV au nom de la banque' })).toHaveCount(0);
});

test('administrateur sécurité : signe le PV ; consommation et abonnements visibles ; déconnexion', async ({ page }) => {
  await login(page, USERS.rssi.username, `/mises-en-service/${seed().acceptanceId}`);
  await page.getByRole('button', { name: 'Signer le PV au nom de la banque' }).click();
  await expect(page.getByText(`Signé par BNA:${USERS.rssi.username} pour votre banque.`)).toBeVisible();

  await menu(page).getByRole('link', { name: 'Consommation et facturation' }).click();
  await expect(page.getByText('Appels facturables')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Abonnements' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Abonnements' }).or(page.getByText('Aucun abonnement.'))).toBeVisible();

  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await expect(page.locator('#username')).toBeVisible();
});
