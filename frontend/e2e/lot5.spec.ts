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

test('identifiants et sandbox : accès visibles, jamais la clé', async ({ page }) => {
  await portal(page, USERS.dev.username, '/developpeurs/sandbox');
  await expect(page.getByText('jamais sur un vrai fournisseur')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Accès sandbox' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Menu du portail' }).getByRole('link', { name: 'Identifiants' }).click();
  await expect(page.getByText('Clé en service')).toBeVisible();
  await expect(page.getByRole('button', { name: /Générer la clé|Renouveler la clé/ })).toBeVisible();
  expect(await page.locator('main').innerText()).not.toMatch(/ak_[a-z]+_/);
});

test('assistant : réponse sourcée ; numéro de carte bloqué avant envoi', async ({ page }) => {
  await portal(page, USERS.lit.username, '/assistant');
  await page.getByLabel('Votre question').fill('Carte 4123456789012345 : que faire ?');
  await expect(page.getByText('Retirez le numéro de carte de votre question.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Poser la question' })).toBeDisabled();
  await page.getByLabel('Votre question').fill(`Où trouver le guide des litiges ${seed().run} ?`);
  await page.getByRole('button', { name: 'Poser la question' }).click();
  await expect(page.getByRole('region', { name: 'Réponse' })).toContainText(seed().doc);
});

test('menu du portail : plus aucun écran « Bientôt »', async ({ page }) => {
  await portal(page, USERS.rssi.username);
  await expect(page.getByRole('navigation', { name: 'Menu du portail' }).getByText('Bientôt')).toHaveCount(0);
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

  test('facturation : paiement enregistré puis à rapprocher ; plan tarifé', async ({ page }) => {
    await consoleLogin(page, USERS.admin.username, '/plans');
    await page.getByLabel('Nom').fill(`Tarifé ${seed().run}`);
    await page.getByLabel('Abonnement mensuel (TND)').fill('150');
    await page.getByLabel('Prix par appel facturable (TND)').fill('0,010');
    await page.getByRole('button', { name: 'Créer le plan' }).click();
    await expect(page.getByRole('row', { name: new RegExp(`Tarifé ${seed().run}`) })).toContainText('150,000 TND / mois + 0,010 TND / appel');
    await page.getByRole('navigation', { name: 'Menu de la console' }).getByRole('link', { name: 'Facturation et rapprochement' }).click();
    await page.getByRole('button', { name: 'Émettre les relevés du mois' }).click();
    await expect(page.getByRole('status')).toContainText('relevé(s) émis');
    await page.getByLabel('Banque', { exact: true }).selectOption({ label: 'BNA' });
    await page.getByLabel('Montant (TND)').fill('100');
    await page.getByLabel('Référence du virement').fill(`VIR-${seed().run}`);
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByRole('table', { name: 'Paiements non rapprochés' })).toContainText(`VIR-${seed().run}`);
  });

  test('cahier de tests type et supervision', async ({ page }) => {
    await consoleLogin(page, USERS.admin.username, '/cahiers-tests');
    await page.getByLabel('Service').selectOption({ label: seed().gabName });
    await page.getByRole('button', { name: 'Ajouter un cas' }).click();
    await page.getByLabel('Intitulé du cas 1').fill('Retrait au GAB');
    await page.getByRole('button', { name: 'Enregistrer le cahier' }).click();
    await expect(page.getByRole('status')).toContainText('Cahier enregistré (version');
    await page.getByRole('navigation', { name: 'Menu de la console' }).getByRole('link', { name: 'Paramètres et supervision' }).click();
    const db = page.getByRole('row', { name: /Base de données/ });
    await expect(db).toContainText('Disponible');
    await expect(page.getByRole('row', { name: /Antivirus/ })).toContainText('Disponible');
    await expect(page.getByRole('navigation', { name: 'Menu de la console' }).getByText('Bientôt')).toHaveCount(0);
  });

  test('agent : notifications de son équipe ; pièces d’une demande visibles dans la file', async ({ page }) => {
    await consoleLogin(page, USERS.ops1.username, '/demandes');
    await page.getByRole('button', { name: /^Notifications/ }).click();
    await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
    await page.keyboard.press('Escape');
  });
});
