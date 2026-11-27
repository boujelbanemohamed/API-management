/**
 * Facturation globale (F-FAC-01, F-FAC-02). Fonctions pures, montants en millimes.
 * Relevé mensuel = abonnements de production + appels facturables + frais d'arbitrage perdus.
 */

export interface StatementLine {
  kind: 'SUBSCRIPTION' | 'USAGE' | 'ARBITRATION';
  label: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  ref?: string;
}

export interface BillableSubscription {
  id: string;
  apiId: string;
  apiName: string;
  apiSlug: string;
  planName: string;
  monthlyFee: number;
  pricePerCall: number;
  startDate: string;
  endDate: string | null;
}

export interface Period { from: string; to: string }

export function periodBounds(period: string): Period {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error('Période au format AAAA-MM attendue');
  const [y, m] = period.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` };
}

/** Un abonnement est facturé s'il couvre au moins un jour de la période (pas de prorata). */
export function coversPeriod(s: { startDate: string; endDate: string | null }, p: Period): boolean {
  return s.startDate <= p.to && (s.endDate === null || s.endDate >= p.from);
}

export function computeLines(
  period: string,
  subs: BillableSubscription[],
  billableCallsBySlug: Record<string, number>,
  lostArbitrations: { ref: string; fees: number }[],
): StatementLine[] {
  const p = periodBounds(period);
  const lines: StatementLine[] = [];
  for (const s of subs.filter((x) => coversPeriod(x, p))) {
    if (s.monthlyFee > 0) {
      lines.push({ kind: 'SUBSCRIPTION', label: `Abonnement ${s.apiName} (plan ${s.planName})`, quantity: 1, unitPrice: s.monthlyFee, amount: s.monthlyFee, ref: s.id });
    }
    const calls = billableCallsBySlug[s.apiSlug] ?? 0;
    if (calls > 0 && s.pricePerCall > 0) {
      lines.push({ kind: 'USAGE', label: `Appels facturables ${s.apiName}`, quantity: calls, unitPrice: s.pricePerCall, amount: calls * s.pricePerCall, ref: s.id });
    }
  }
  for (const a of lostArbitrations.filter((x) => x.fees > 0)) {
    lines.push({ kind: 'ARBITRATION', label: `Frais d’arbitrage, litige ${a.ref}`, quantity: 1, unitPrice: a.fees, amount: a.fees, ref: a.ref });
  }
  return lines;
}

export const total = (lines: StatementLine[]) => lines.reduce((s, l) => s + l.amount, 0);

export type StatementStatus = 'ISSUED' | 'PARTIAL' | 'PAID';

/** Statut et écart après paiements : un trop-perçu est un écart à régulariser. */
export function settle(totalDue: number, paid: number): { status: StatementStatus; balance: number; overpaid: number } {
  const balance = Math.max(0, totalDue - paid);
  return { status: paid >= totalDue ? 'PAID' : paid > 0 ? 'PARTIAL' : 'ISSUED', balance, overpaid: Math.max(0, paid - totalDue) };
}

/** Échéance : 30 jours après l'émission. */
export function dueDateOf(issuedOn: string): string {
  const d = new Date(`${issuedOn}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 30);
  return d.toISOString().slice(0, 10);
}
