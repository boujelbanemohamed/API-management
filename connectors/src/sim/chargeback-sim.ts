import net from 'node:net';
import { ACTION_ECHO_OK, ACTION_OK, decodeBody, encode, FrameReader, parsePrivateData, responseMti } from '../iso8583.js';
import { log } from '../bus.js';

/**
 * Simulateur de la plateforme Chargeback (sandbox) : serveur ISO 8583:1993 sur TCP.
 * Accuse réception (code action 000), sauf : montant nul → 110, code motif 9999 → 909 (erreur système),
 * carte non masquée → 902. Écho 1804/831 → 1814/800.
 */
const PORT = Number(process.env.PORT ?? 8583);
const MASKED = /^\d{6}[*X]{3,9}\d{4}$/;

function actionCode(mti: string, f: Record<number, string>): string {
  if (mti === '1804') return ACTION_ECHO_OK;
  if (!MASKED.test(parsePrivateData(f[48]).PAN ?? '')) return '902';
  if (f[25] === '9999') return '909';
  if (Number(f[4] ?? '0') === 0 && mti !== '1644') return '110';
  return ACTION_OK;
}

net
  .createServer((socket) => {
    const reader = new FrameReader();
    socket.on('data', (chunk) => {
      for (const frame of reader.push(chunk)) {
        try {
          const req = decodeBody(frame);
          const code = actionCode(req.mti, req.fields);
          const fields: Record<number, string> = { 11: req.fields[11], 39: code };
          for (const k of [7, 24, 31]) if (req.fields[k] !== undefined) fields[k] = req.fields[k];
          socket.write(encode({ mti: responseMti(req.mti), fields }));
          log('info', 'Simulateur Chargeback : message traité', { mti: req.mti, functionCode: req.fields[24], actionCode: code });
        } catch (e) {
          log('error', `Simulateur Chargeback : trame rejetée (${(e as Error).message})`);
        }
      }
    });
    socket.on('error', () => undefined);
  })
  .listen(PORT, () => log('info', `Simulateur Chargeback ISO 8583 à l'écoute sur ${PORT}`));
