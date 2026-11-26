import { Bus, env, log, retry } from '../bus.js';
import { ACTION_ECHO_OK, ACTION_OK } from '../iso8583.js';
import { IsoClient, transmissionDate } from './iso-client.js';
import { OutgoingDisputeMessage, toIso } from './mapping.js';

/**
 * Connecteur plateforme Chargeback : chargeback.outgoing → ISO 8583 sur TCP → chargeback.result.
 * Panne de liaison : reprise 1 s, 2 s, 4 s… puis résultat FAILED (visible dans l'historique du litige).
 */
const bus = new Bus(env('AMQP_URL'));
const iso = new IsoClient(env('CHARGEBACK_HOST'), Number(env('CHARGEBACK_PORT', '8583')), Number(env('CHARGEBACK_TIMEOUT_MS', '10000')));
const ATTEMPTS = Number(env('CHARGEBACK_ATTEMPTS', '5'));

async function handle(m: OutgoingDisputeMessage) {
  let result: { status: 'ACKED' | 'REJECTED' | 'FAILED'; actionCode?: string; detail?: string };
  try {
    const reply = await retry(() => iso.send(toIso(m, iso.nextStan(), transmissionDate())), ATTEMPTS);
    const code = reply.fields[39] ?? '';
    result = code === ACTION_OK ? { status: 'ACKED', actionCode: code } : { status: 'REJECTED', actionCode: code, detail: `Refusé par la plateforme (code ${code})` };
  } catch (e) {
    result = { status: 'FAILED', detail: (e as Error).message };
  }
  log(result.status === 'ACKED' ? 'info' : 'warn', 'Message de litige traité', { eventId: m.eventId, mti: m.mti, functionCode: m.functionCode, ...result });
  await bus.publish('chargeback.result', { eventId: m.eventId, ...result }, `${m.eventId}:result`);
}

/** Test d'écho réseau (1804, code fonction 831) : vérifie la liaison, sans effet métier. */
async function echo() {
  try {
    const r = await iso.send({ mti: '1804', fields: { 7: transmissionDate(), 11: iso.nextStan(), 24: '831' } });
    if (r.fields[39] !== ACTION_ECHO_OK) log('warn', 'Écho ISO : réponse inattendue', { actionCode: r.fields[39] });
  } catch (e) {
    log('error', `Écho ISO en échec : ${(e as Error).message}`);
  }
}

async function main() {
  await bus.consume('connector.chargeback', ['chargeback.outgoing'], (d) => handle(d.payload as OutgoingDisputeMessage));
  setInterval(() => void echo(), Number(env('CHARGEBACK_ECHO_MS', '60000')));
  void echo();
  log('info', 'Connecteur Chargeback démarré');
}

main().catch((e) => {
  log('error', `Démarrage impossible : ${(e as Error).message}`);
  process.exit(1);
});
process.on('SIGTERM', async () => {
  iso.close();
  await bus.close();
  process.exit(0);
});
