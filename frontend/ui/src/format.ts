/** Formats d'affichage : dates en français, montants en dinars (le back-end stocke des millimes). */

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function formatAmount(millimes: number | null | undefined): string {
  if (millimes === null || millimes === undefined) return '—';
  return `${(millimes / 1000).toLocaleString('fr-FR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} TND`;
}

export function toMillimes(dinars: string): number {
  return Math.round(Number(dinars.replace(',', '.').replace(/\s/g, '')) * 1000);
}

export function todayIso(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Africa/Tunis' });
}

export function monthBounds(date = todayIso()): { from: string; to: string } {
  const [y, m] = date.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${y}-${String(m).padStart(2, '0')}-01`, to: `${y}-${String(m).padStart(2, '0')}-${last}` };
}

/** Numéro de carte : seul le format masqué (6 premiers, 4 derniers) est accepté (PCI-DSS). */
export const MASKED_PAN = /^\d{6}[*X]{3,9}\d{4}$/;
export const FULL_PAN = /\b\d{13,19}\b/;
