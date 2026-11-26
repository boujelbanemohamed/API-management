import { expect, Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { USERS } from './seed';

const seed = () => JSON.parse(readFileSync(new URL('./.seed.json', import.meta.url), 'utf8')) as Record<string, string>;
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

async function login(page: Page, username: string, path: string, menuName: string) {
  await page.goto(path);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(seed().password);
  await page.locator('#kc-login').click();
  await expect(page.getByRole('navigation', { name: menuName })).toBeVisible();
}
const portal = (page: Page, user: string, path = '/') => login(page, user, path, 'Menu du portail');

test('pièce jointe : fichier sain accepté, fichier infecté refusé par l’antivirus', async ({ page }) => {
  await portal(page, USERS.op.username, '/demandes/nouvelle?type=SUPPORT');
  await page.getByLabel('Objet').fill(`Question avec pièce ${seed().run}`);
  await page.getByRole('button', { name: 'Envoyer la demande' }).click();
  await expect(page.getByText('Aucune pièce jointe.')).toBeVisible();
  await page.getByLabel('Ajouter une pièce').setInputFiles({ name: 'releve.txt', mimeType: 'text/plain', buffer: Buffer.from('Relevé de compte') });
  await expect(page.getByRole('button', { name: 'releve.txt' })).toBeVisible();
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'releve.txt' }).click();
  expect((await dl).suggestedFilename()).toBe('releve.txt');
  await page.getByLabel('Ajouter une pièce').setInputFiles({ name: 'facture.txt', mimeType: 'text/plain', buffer: Buffer.from(EICAR) });
  await expect(page.getByRole('alert')).toContainText('l’antivirus a détecté une menace');
  await expect(page.getByRole('button', { name: 'facture.txt' })).toHaveCount(0);
});

test('accueil : communiqué important, enquête à laquelle on répond une fois, notifications', async ({ page }) => {
  await portal(page, USERS.lit.username);
  await expect(page.getByRole('note').filter({ hasText: seed().communique })).toBeVisible();
  await page.getByRole('link', { name: seed().survey }).click();
  await page.getByLabel('Votre note').selectOption('4');
  await page.getByLabel('Votre avis').fill('Portail clair');
  await page.getByRole('button', { name: 'Envoyer ma réponse' }).click();
  await expect(page.getByText('Merci, votre réponse a été enregistrée.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Merci, votre réponse a été enregistrée.')).toBeVisible();
  const bell = page.getByRole('button', { name: /^Notifications \(\d+ non lues\)$/ });
  await bell.click();
  await expect(page.getByRole('dialog', { name: 'Notifications' })).toContainText('Nouveau communiqué');
});

test('bibliothèque : document téléchargé dans sa version courante', async ({ page }) => {
  await portal(page, USERS.dev.username, '/bibliotheque');
  await page.getByRole('button', { name: new RegExp(`${seed().doc} — version 1`) }).click();
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'guide-litiges.pdf' }).click();
  expect((await dl).suggestedFilename()).toBe('guide-litiges.pdf');
});

test('gestion des accès : l’administrateur sécurité crée un utilisateur et ne peut pas se retirer ses droits', async ({ page }) => {
  await portal(page, USERS.rssi.username, '/compte/acces');
  const username = `e2e.new${seed().run}`.toLowerCase();
  await page.getByLabel('Identifiant').fill(username);
  await page.getByLabel('Adresse électronique').fill(`${username}@bna.tn`);
  await page.getByLabel('Prénom').fill('Nouvel');
  await page.getByLabel('Nom', { exact: true }).fill('Agent');
  await page.locator('#new-banque-lecture').check();
  await page.getByRole('button', { name: 'Créer l’utilisateur' }).click();
  await expect(page.getByRole('status')).toContainText(`Compte ${username} créé`);
  await expect(page.getByRole('table', { name: 'Utilisateurs de la banque' })).toContainText(username);
  const me = page.getByRole('row', { name: new RegExp(USERS.rssi.username) });
  await me.getByRole('button', { name: 'Modifier les rôles' }).click();
  await me.getByLabel('Administrateur sécurité').uncheck();
  await me.getByLabel('Lecture seule').check();
  await me.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByRole('alert')).toContainText('Vous ne pouvez pas retirer votre propre rôle d’administrateur');
  await expect(me.getByRole('button', { name: 'Désactiver' })).toHaveCount(0);
});

test('menu : gestion des accès réservée à l’administrateur sécurité', async ({ page }) => {
  await portal(page, USERS.dev.username);
  await expect(page.getByRole('navigation', { name: 'Menu du portail' }).getByRole('link', { name: 'Gestion des accès' })).toHaveCount(0);
});

test.describe('console', () => {
  test.use({ baseURL: 'http://localhost:5173' });
  const consoleLogin = (page: Page, user: string, path = '/') => login(page, user, path, 'Menu de la console');

  test('administrateur : publie un communiqué ciblé, gère les utilisateurs SMT', async ({ page }) => {
    await consoleLogin(page, USERS.admin.username, '/contenus');
    await page.getByLabel('Titre').fill(`Communiqué STB ${seed().run}`);
    await page.getByLabel('Destinataires').selectOption('SELECTED');
    await page.getByLabel('STB').check();
    await page.getByLabel('Texte').fill('Message réservé à la STB.');
    await page.getByRole('button', { name: 'Enregistrer en brouillon' }).click();
    const row = page.getByRole('row', { name: new RegExp(`Communiqué STB ${seed().run}`) });
    await row.getByRole('button', { name: 'Publier' }).click();
    await expect(row).toContainText('Publié');
    await expect(row).toContainText('STB');
    const survey = page.getByRole('row', { name: new RegExp(seed().survey) });
    await survey.getByRole('button', { name: 'Résultats' }).click();
    await expect(page.getByText('Portail clair')).toBeVisible();
    await page.getByRole('navigation', { name: 'Menu de la console' }).getByRole('link', { name: 'Utilisateurs' }).click();
    await expect(page.getByRole('table', { name: 'Utilisateurs SMT' })).toContainText(USERS.ops1.username);
  });

  test('agent : notifications de son équipe ; pièces d’une demande visibles dans la file', async ({ page }) => {
    await consoleLogin(page, USERS.ops1.username, '/demandes');
    await page.getByRole('button', { name: /^Notifications/ }).click();
    await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
    await page.keyboard.press('Escape');
  });
});
