/**
 * Données de démonstration déterministes par banque (même banque → mêmes données), pour les simulateurs de la sandbox.
 * Jamais de numéro de carte complet : les simulateurs ne connaissent que des numéros masqués.
 */
function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, list: T[]) => list[Math.floor(r() * list.length)];
const pad = (n: number, w: number) => String(n).padStart(w, '0');
const CITIES = ['Tunis', 'Sfax', 'Sousse', 'Bizerte', 'Nabeul', 'Gabès', 'Monastir', 'Ariana'];
const MERCHANTS = ['Carrefour', 'Monoprix', 'Géant', 'Pharmacie Centrale', 'Station Agil', 'Café de Paris', 'Librairie Al Kitab', 'Hôtel Mouradi'];

export function cards(bank: string) {
  const r = rng(`cards:${bank}`);
  return Array.from({ length: 25 }, (_, i) => {
    const bin = pick(r, ['412345', '535522', '627011']);
    return {
      id: `${bank}-C${pad(i + 1, 4)}`,
      bank,
      maskedPan: `${bin}******${pad(Math.floor(r() * 10000), 4)}`,
      holder: `${pick(r, ['A.', 'M.', 'S.', 'K.', 'N.'])} ${pick(r, ['Ben Salah', 'Trabelsi', 'Gharbi', 'Jaziri', 'Mansour', 'Haddad'])}`,
      product: bin === '627011' ? 'Carte nationale' : bin === '412345' ? 'Visa Classic' : 'Mastercard Gold',
      status: pick(r, ['ACTIVE', 'ACTIVE', 'ACTIVE', 'ACTIVE', 'BLOCKED', 'EXPIRED']),
      expiry: `${pad(1 + Math.floor(r() * 12), 2)}/${27 + Math.floor(r() * 4)}`,
      dailyLimit: 500_000 + Math.floor(r() * 10) * 100_000,
      pinTriesLeft: 3 - Math.floor(r() * 2),
    };
  });
}

export function transactions(bank: string) {
  const r = rng(`tx:${bank}`);
  const cs = cards(bank);
  const now = Date.UTC(2026, 10, 26);
  return Array.from({ length: 120 }, (_, i) => {
    const c = pick(r, cs);
    const d = new Date(now - Math.floor(r() * 60) * 86_400_000 - Math.floor(r() * 86_400_000));
    return {
      reference: `${bank}${pad(i + 1, 8)}`,
      bank,
      maskedPan: c.maskedPan,
      date: d.toISOString(),
      amount: Math.floor(r() * 400_000) + 1000,
      currency: '788',
      merchant: pick(r, MERCHANTS),
      city: pick(r, CITIES),
      channel: pick(r, ['TPE', 'TPE', 'GAB', 'E-COMMERCE']),
      responseCode: pick(r, ['00', '00', '00', '00', '00', '51', '05', '55']),
      acquirer: pick(r, ['BNA', 'STB', 'ATB', 'BIAT']),
    };
  }).sort((a, b) => b.date.localeCompare(a.date));
}

export function atms(bank: string) {
  const r = rng(`atm:${bank}`);
  return Array.from({ length: 14 }, (_, i) => ({
    id: `${bank}-GAB-${pad(i + 1, 4)}`,
    bank,
    location: `${pick(r, CITIES)} — agence ${pad(1 + Math.floor(r() * 90), 2)}`,
    status: pick(r, ['EN_SERVICE', 'EN_SERVICE', 'EN_SERVICE', 'HORS_SERVICE', 'BILLETS_BAS', 'DEGRADE']),
    cashLevel: Math.floor(r() * 100),
    lastIncident: r() > 0.5 ? pick(r, ['Bourrage billets', 'Lecteur de carte', 'Liaison réseau', 'Imprimante']) : null,
  }));
}

export function merchants(bank: string) {
  const r = rng(`mch:${bank}`);
  return Array.from({ length: 12 }, (_, i) => ({
    id: `${bank}-M${pad(i + 1, 5)}`,
    bank,
    name: `${pick(r, MERCHANTS)} ${pick(r, CITIES)}`,
    mcc: pick(r, ['5411', '5912', '5541', '5812', '5942', '7011']),
    status: pick(r, ['ACTIF', 'ACTIF', 'ACTIF', 'SUSPENDU']),
    terminals: Array.from({ length: 1 + Math.floor(r() * 3) }, (_, t) => ({
      id: `T${pad(i + 1, 3)}${t + 1}`,
      model: pick(r, ['Ingenico Move/5000', 'Verifone V200c', 'PAX A920']),
      status: pick(r, ['EN_SERVICE', 'EN_SERVICE', 'HORS_SERVICE']),
      lastTransaction: new Date(Date.UTC(2026, 10, 26) - Math.floor(r() * 5) * 86_400_000).toISOString().slice(0, 10),
    })),
  }));
}

export function affiliations(bank: string) {
  const r = rng(`aff:${bank}`);
  return Array.from({ length: 6 }, (_, i) => ({
    id: `${bank}-AFF-${pad(i + 1, 4)}`,
    bank,
    merchant: `${pick(r, ['Boutique', 'E-shop', 'Marché', 'Store'])} ${pick(r, ['Jasmin', 'Carthage', 'Médina', 'Sahel'])}`,
    website: `https://www.${pick(r, ['jasmin', 'carthage', 'medina', 'sahel'])}-${i + 1}.tn`,
    status: pick(r, ['EN_ETUDE', 'PIECES_MANQUANTES', 'VALIDEE', 'EN_PRODUCTION']),
    submittedOn: new Date(Date.UTC(2026, 9, 1) + Math.floor(r() * 50) * 86_400_000).toISOString().slice(0, 10),
  }));
}

export function smartvistaUsers(bank: string) {
  const r = rng(`sv:${bank}`);
  return Array.from({ length: 8 }, (_, i) => ({
    login: `${bank.toLowerCase()}.${pick(r, ['agent', 'superv', 'monet', 'audit'])}${i + 1}`,
    bank,
    profile: pick(r, ['Consultation', 'Opérateur cartes', 'Superviseur', 'Audit']),
    status: pick(r, ['ACTIF', 'ACTIF', 'ACTIF', 'BLOQUE', 'EXPIRE']),
    lastLogin: new Date(Date.UTC(2026, 10, 26) - Math.floor(r() * 40) * 86_400_000).toISOString().slice(0, 10),
  }));
}
