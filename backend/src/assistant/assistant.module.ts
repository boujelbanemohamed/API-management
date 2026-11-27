import { Body, Controller, Get, HttpException, HttpStatus, Injectable, Logger, Module, Post, UseGuards } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { BankContext, PortalGuard } from '../auth/guards';
import { Bank } from '../portal/bank.decorator';
import { ContentsModule, ContentsService } from '../contents/contents.module';
import { ApiProduct, ApiStatus } from '../apis/api-product.entity';
import { Partner } from '../partners/partner.entity';

/**
 * Assistant (option, F-CON-03) : répond à partir de la bibliothèque, des communiqués et du catalogue
 * visibles de la banque, en citant ses sources. Il ne reçoit jamais de données de transaction ni de carte.
 * Modèle : serveur open source sur site compatible avec l'API « chat completions » (vLLM, llama.cpp, Ollama…),
 * réglé par ASSISTANT_URL et ASSISTANT_MODEL. Sans modèle, il renvoie les extraits les plus pertinents.
 */
export class AskDto {
  @IsString() @MinLength(3) @MaxLength(500) question: string;
}

interface Source { title: string; kind: string; link: string; excerpt: string }

const STOP = new Set(['les', 'des', 'une', 'pour', 'avec', 'dans', 'que', 'qui', 'est', 'sur', 'par', 'pas', 'comment', 'quel', 'quelle', 'quels', 'quelles', 'mon', 'mes', 'nos', 'vos', 'est-ce']);

/** Retire tout numéro ressemblant à une carte avant tout traitement (PCI-DSS). */
export function sanitize(q: string): string {
  return q.replace(/\b\d[\d\s-]{11,22}\d\b/g, '[numéro retiré]');
}

export function keywords(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/[^a-zà-ÿ0-9]+/i).filter((w) => w.length >= 3 && !STOP.has(w)))];
}

function excerpt(text: string, words: string[], size = 280): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const lower = t.toLowerCase();
  const pos = Math.max(0, Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0), t.length));
  const start = Math.max(0, pos - 60);
  return (start > 0 ? '…' : '') + t.slice(start, start + size) + (start + size < t.length ? '…' : '');
}

@Injectable()
export class AssistantService {
  private readonly logger = new Logger('Assistant');
  private readonly usage = new Map<string, number[]>();

  constructor(
    private readonly contents: ContentsService,
    @InjectRepository(ApiProduct) private readonly apis: Repository<ApiProduct>,
  ) {}

  status() {
    return { model: !!process.env.ASSISTANT_URL, name: process.env.ASSISTANT_MODEL ?? null };
  }

  /** Limite : 20 questions par heure et par utilisateur. */
  private throttle(key: string) {
    const now = Date.now();
    const recent = (this.usage.get(key) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= 20) throw new HttpException({ code: 'ASSISTANT_LIMIT', message: 'Limite de 20 questions par heure atteinte.' }, HttpStatus.TOO_MANY_REQUESTS);
    this.usage.set(key, [...recent, now]);
  }

  async sources(question: string, bank: BankContext): Promise<Source[]> {
    const words = keywords(question);
    const docs = (await this.contents.search(bank, words, 4)).map((c) => ({
      title: c.title,
      kind: c.kind === 'DOCUMENT' ? 'Bibliothèque' : c.kind === 'COMMUNIQUE' ? 'Communiqué' : c.kind === 'EVENEMENT' ? 'Événement' : 'Enquête',
      link: c.kind === 'DOCUMENT' ? '/bibliotheque' : `/contenus/${c.id}`,
      excerpt: excerpt(`${c.title}. ${c.body}`, words),
    }));
    const norm = (s: string) => s.toLowerCase();
    const services = (await this.apis.find({ where: { status: In([ApiStatus.PUBLISHED, ApiStatus.BETA]) } }))
      .map((a) => ({ a, score: words.reduce((s, w) => s + (norm(a.name).includes(w) ? 3 : 0) + (norm(a.description ?? '').includes(w) ? 1 : 0), 0) }))
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, 3)
      .map(({ a }) => ({ title: a.name, kind: 'Catalogue', link: '/catalogue', excerpt: excerpt(`${a.name} (${a.publicPath}, ${a.version}). ${a.description ?? ''}`, words) }));
    return [...docs, ...services];
  }

  async ask(raw: string, bank: BankContext) {
    this.throttle(bank.actor);
    const question = sanitize(raw);
    const sources = await this.sources(question, bank);
    if (sources.length === 0) {
      return { answer: 'Je n’ai trouvé aucun document publié qui réponde à cette question. Vous pouvez la poser au support SMT.', sources, mode: 'extraits' };
    }
    const url = process.env.ASSISTANT_URL;
    if (!url) {
      return { answer: 'Voici les passages des documents SMT les plus proches de votre question.', sources, mode: 'extraits' };
    }
    const context = sources.map((s, i) => `[${i + 1}] ${s.kind} — ${s.title} : ${s.excerpt}`).join('\n');
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.ASSISTANT_MODEL ?? 'local',
          temperature: 0.1,
          max_tokens: 500,
          messages: [
            { role: 'system', content: 'Tu es l’assistant du portail des banques de Monétique Tunisie. Réponds en français, brièvement, uniquement à partir des extraits fournis, en citant leurs numéros [1], [2]. Si les extraits ne suffisent pas, dis-le et propose de contacter le support SMT.' },
            { role: 'user', content: `Extraits :\n${context}\n\nQuestion : ${question}` },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`modèle ${res.status}`);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const answer = data.choices?.[0]?.message?.content?.trim();
      if (!answer) throw new Error('réponse vide');
      return { answer, sources, mode: 'modele' };
    } catch (e) {
      this.logger.warn(`Modèle indisponible, réponse par extraits : ${(e as Error).message}`);
      return { answer: 'Le modèle est momentanément indisponible ; voici les passages les plus proches de votre question.', sources, mode: 'extraits' };
    }
  }
}

@Controller('portal/assistant')
@UseGuards(PortalGuard)
export class AssistantController {
  constructor(private readonly s: AssistantService) {}
  @Get() status() {
    return this.s.status();
  }
  @Post() ask(@Bank() bank: BankContext, @Body() dto: AskDto) {
    return this.s.ask(dto.question, bank);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([ApiProduct, Partner]), ContentsModule],
  providers: [AssistantService],
  controllers: [AssistantController],
})
export class AssistantModule {}
