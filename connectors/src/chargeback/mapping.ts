import { IsoMessage, privateData } from '../iso8583.js';

/** Message publié par le back-end (sujet chargeback.outgoing). */
export interface OutgoingDisputeMessage {
  eventId: string;
  disputeId: string;
  mti: string;
  functionCode: string;
  /** Millimes. */
  amount: number;
  currency: string;
  maskedPan: string;
  transactionRef: string;
  transactionDate: string;
  reasonCode: string;
  issuerCode: string;
  acquirerCode: string;
}

const MASKED = /^\d{6}[*X]{3,9}\d{4}$/;

/** Traduit un événement de litige en message ISO 8583:1993. */
export function toIso(m: OutgoingDisputeMessage, stan: string, transmission: string): IsoMessage {
  if (!MASKED.test(m.maskedPan)) throw new Error('numéro de carte non masqué : envoi refusé');
  if (!Number.isInteger(m.amount) || m.amount < 0) throw new Error('montant invalide');
  return {
    mti: m.mti,
    fields: {
      4: String(m.amount),
      7: transmission,
      11: stan,
      24: m.functionCode,
      25: /^\d{1,4}$/.test(m.reasonCode) ? m.reasonCode : '0000',
      31: m.transactionRef.slice(0, 99),
      48: privateData({ PAN: m.maskedPan, ISS: m.issuerCode, ACQ: m.acquirerCode, TXD: m.transactionDate, DSP: m.disputeId, EVT: m.eventId }),
      49: /^\d{3}$/.test(m.currency) ? m.currency : '788',
    },
  };
}
