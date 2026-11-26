import * as amqp from 'amqplib';

/** Accès RabbitMQ des connecteurs : même échange `apim` et même file de rebut que le back-end. */
export interface Delivery {
  id: string;
  topic: string;
  payload: any;
}

export class Bus {
  private model?: amqp.ChannelModel;
  private channel?: amqp.ConfirmChannel;

  constructor(private readonly url: string) {}

  async open(): Promise<amqp.ConfirmChannel> {
    if (this.channel) return this.channel;
    this.model = await amqp.connect(this.url);
    this.model.on('close', () => {
      log('error', 'Connexion RabbitMQ perdue : arrêt pour redémarrage par le superviseur');
      process.exit(1);
    });
    const ch = await this.model.createConfirmChannel();
    await ch.assertExchange('apim', 'topic', { durable: true });
    await ch.assertExchange('apim.dlx', 'fanout', { durable: true });
    await ch.assertQueue('apim.dlq', { durable: true });
    await ch.bindQueue('apim.dlq', 'apim.dlx', '');
    this.channel = ch;
    return ch;
  }

  async publish(topic: string, payload: unknown, messageId: string): Promise<void> {
    const ch = await this.open();
    await new Promise<void>((resolve, reject) =>
      ch.publish('apim', topic, Buffer.from(JSON.stringify(payload)), { persistent: true, messageId, contentType: 'application/json' }, (e) => (e ? reject(e) : resolve())),
    );
  }

  /**
   * Consomme une file un message à la fois (ordre préservé, par exemple les étapes d'un même litige).
   * Le gestionnaire renvoie normalement ; s'il lève une erreur, le message part en rebut.
   */
  async consume(queue: string, topics: string[], handler: (d: Delivery) => Promise<void>): Promise<void> {
    const ch = await this.open();
    await ch.assertQueue(queue, { durable: true, deadLetterExchange: 'apim.dlx' });
    for (const t of topics) await ch.bindQueue(queue, 'apim', t);
    await ch.prefetch(1);
    await ch.consume(queue, async (m) => {
      if (!m) return;
      try {
        await handler({ id: m.properties.messageId, topic: m.fields.routingKey, payload: JSON.parse(m.content.toString()) });
        ch.ack(m);
      } catch (e) {
        log('error', `Message ${m.properties.messageId} envoyé en rebut : ${(e as Error).message}`);
        ch.nack(m, false, false);
      }
    });
  }

  async close() {
    await this.model?.close().catch(() => undefined);
  }
}

/** Journal structuré (JSON sur une ligne), sans donnée sensible. */
export function log(level: 'info' | 'warn' | 'error', message: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), level, message, ...extra }));
}

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Variable d'environnement manquante : ${name}`);
  return v;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exécute avec reprise : 1 s, 2 s, 4 s… ; lève la dernière erreur après `attempts` essais. */
export async function retry<T>(fn: () => Promise<T>, attempts: number, baseMs = 1000): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < attempts - 1) await sleep(baseMs * 2 ** i);
    }
  }
  throw last;
}
