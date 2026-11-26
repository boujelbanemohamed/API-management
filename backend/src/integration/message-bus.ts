import { Logger } from '@nestjs/common';
import * as amqp from 'amqplib';

/**
 * Bus de messages entre le back-end et les connecteurs (spécifications : couche d'intégration).
 * Échange « topic » durable `apim`, messages persistants, file de rebut `apim.dlq`.
 */
export interface BusMessage<T = unknown> {
  id: string;
  topic: string;
  payload: T;
}

export type Handler = (msg: BusMessage) => Promise<void>;

export interface MessageBus {
  publish(topic: string, payload: unknown, messageId: string): Promise<void>;
  /** Abonne une file durable aux sujets donnés ; un échec du traitement envoie le message en file de rebut. */
  subscribe(queue: string, topics: string[], handler: Handler): Promise<void>;
  close(): Promise<void>;
}

export const MESSAGE_BUS = Symbol('MESSAGE_BUS');

export const TOPICS = {
  chargebackOutgoing: 'chargeback.outgoing',
  chargebackResult: 'chargeback.result',
  cockpitOrder: 'cockpit.order',
  cockpitEvent: 'cockpit.event',
} as const;

const EXCHANGE = 'apim';
const DLX = 'apim.dlx';

export class RabbitBus implements MessageBus {
  private readonly logger = new Logger('RabbitBus');
  private connection?: amqp.ChannelModel;
  private channel?: amqp.ConfirmChannel;
  private ready?: Promise<amqp.ConfirmChannel>;
  /** Abonnements à rétablir après une coupure du courtier. */
  private readonly subscriptions: { queue: string; topics: string[]; handler: Handler }[] = [];
  private reconnectTimer?: NodeJS.Timeout;
  private closing = false;

  constructor(private readonly url: string) {}

  /** Reconnexion toutes les 5 s, puis rétablissement des consommateurs. */
  private scheduleReconnect() {
    if (this.closing || this.reconnectTimer || this.subscriptions.length === 0) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      try {
        for (const s of this.subscriptions) await this.attach(s.queue, s.topics, s.handler);
        this.logger.log(`Reconnecté à RabbitMQ, ${this.subscriptions.length} consommateur(s) rétabli(s)`);
      } catch (e) {
        this.logger.warn(`Reconnexion RabbitMQ impossible : ${(e as Error).message}`);
        this.scheduleReconnect();
      }
    }, 5000);
  }

  private async open(): Promise<amqp.ConfirmChannel> {
    this.ready ??= (async () => {
      this.connection = await amqp.connect(this.url);
      this.connection.on('error', (e) => this.logger.error(`Connexion RabbitMQ : ${e.message}`));
      this.connection.on('close', () => {
        this.ready = undefined;
        this.channel = undefined;
        if (!this.closing) {
          this.logger.warn('Connexion RabbitMQ fermée : reconnexion');
          this.scheduleReconnect();
        }
      });
      const ch = await this.connection.createConfirmChannel();
      await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
      await ch.assertExchange(DLX, 'fanout', { durable: true });
      await ch.assertQueue('apim.dlq', { durable: true });
      await ch.bindQueue('apim.dlq', DLX, '');
      this.channel = ch;
      return ch;
    })().catch((e) => {
      this.ready = undefined;
      throw e;
    });
    return this.ready;
  }

  async publish(topic: string, payload: unknown, messageId: string): Promise<void> {
    const ch = await this.open();
    const body = Buffer.from(JSON.stringify(payload));
    await new Promise<void>((resolve, reject) =>
      ch.publish(EXCHANGE, topic, body, { persistent: true, messageId, contentType: 'application/json' }, (err) => (err ? reject(err) : resolve())),
    );
  }

  async subscribe(queue: string, topics: string[], handler: Handler): Promise<void> {
    this.subscriptions.push({ queue, topics, handler });
    try {
      await this.attach(queue, topics, handler);
    } catch (e) {
      // Courtier absent au démarrage : le consommateur sera rattaché à la reconnexion.
      this.logger.warn(`Abonnement ${queue} différé : ${(e as Error).message}`);
      this.scheduleReconnect();
    }
  }

  private async attach(queue: string, topics: string[], handler: Handler): Promise<void> {
    const ch = await this.open();
    await ch.assertQueue(queue, { durable: true, deadLetterExchange: DLX });
    for (const t of topics) await ch.bindQueue(queue, EXCHANGE, t);
    await ch.prefetch(10);
    await ch.consume(queue, async (m) => {
      if (!m) return;
      try {
        const payload = JSON.parse(m.content.toString());
        await handler({ id: m.properties.messageId ?? '', topic: m.fields.routingKey, payload });
        ch.ack(m);
      } catch (e) {
        this.logger.error(`Message ${m.properties.messageId} (${m.fields.routingKey}) envoyé en rebut : ${(e as Error).message}`);
        ch.nack(m, false, false);
      }
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    await this.connection?.close().catch(() => undefined);
  }
}

/** Bus en mémoire pour les tests : remise immédiate aux abonnés. */
export class InMemoryBus implements MessageBus {
  readonly published: BusMessage[] = [];
  readonly deadLetters: BusMessage[] = [];
  private readonly subscribers: { topics: string[]; handler: Handler }[] = [];
  /** Simule une panne du courtier. */
  failing = false;

  async publish(topic: string, payload: unknown, id: string): Promise<void> {
    if (this.failing) throw new Error('courtier injoignable');
    const msg = { id, topic, payload: JSON.parse(JSON.stringify(payload)) };
    this.published.push(msg);
    for (const s of this.subscribers.filter((x) => x.topics.includes(topic))) {
      await s.handler(msg).catch(() => this.deadLetters.push(msg));
    }
  }

  async subscribe(_queue: string, topics: string[], handler: Handler): Promise<void> {
    this.subscribers.push({ topics, handler });
  }

  async close(): Promise<void> {}
}
