import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, download, post, Card, Empty, ErrorBanner, Field, formatDate, Loading, PageHeader, Pill } from '@smt/ui';

export interface ContentItem {
  id: string; kind: 'COMMUNIQUE' | 'EVENEMENT' | 'ENQUETE' | 'DOCUMENT'; title: string; body: string; important: boolean;
  eventDate: string | null; location: string | null; category: string | null; version: number; publishedAt: string | null;
  questions: { id: string; label: string; type: 'choice' | 'text'; options?: string[] }[] | null; answered?: boolean;
  files?: { id: string; name: string; size: number; createdAt: string }[];
}

export const KIND_LABEL = { COMMUNIQUE: 'Communiqué', EVENEMENT: 'Événement', ENQUETE: 'Enquête', DOCUMENT: 'Document' } as const;

export function useContents(kind?: string) {
  return useQuery({ queryKey: ['contents', kind ?? 'all'], queryFn: () => api<ContentItem[]>(`/portal/contents${kind ? `?kind=${kind}` : ''}`) });
}

/** Communiqué, événement ou enquête (avec son formulaire de réponse). */
export function ContenuDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['contents', 'one', id], queryFn: () => api<ContentItem>(`/portal/contents/${id}`) });
  const list = useContents('ENQUETE');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const send = useMutation({ mutationFn: () => post(`/portal/contents/${id}/responses`, { answers }), onSuccess: () => qc.invalidateQueries({ queryKey: ['contents'] }) });
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorBanner error={q.error} />;
  const c = q.data;
  const answered = send.isSuccess || list.data?.find((x) => x.id === c.id)?.answered;
  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <PageHeader title={c.title} subtitle={`${KIND_LABEL[c.kind]} · publié le ${formatDate(c.publishedAt)}`} actions={c.important && <Pill label={{ text: 'Important', tone: 'warn' }} />} />
      {c.kind === 'EVENEMENT' && <div className="banner banner-info">Le {formatDate(c.eventDate)}{c.location ? ` — ${c.location}` : ''}</div>}
      {c.body && <Card><div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div></Card>}
      {c.kind === 'ENQUETE' && (
        answered ? <div className="banner banner-ok" role="status">Merci, votre réponse a été enregistrée.</div> : (
          <form className="card stack" onSubmit={(e) => { e.preventDefault(); send.mutate(); }}>
            {(c.questions ?? []).map((qq) => (
              <Field key={qq.id} label={qq.label}>
                {(p) => qq.type === 'choice' ? (
                  <select {...p} value={answers[qq.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [qq.id]: e.target.value })} required>
                    <option value="">Choisir…</option>
                    {(qq.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : <textarea {...p} value={answers[qq.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [qq.id]: e.target.value })} required maxLength={1000} />}
              </Field>
            ))}
            <ErrorBanner error={send.error} />
            <div><button className="btn btn-primary" type="submit" disabled={send.isPending}>Envoyer ma réponse</button></div>
          </form>
        )
      )}
      <div><Link to="/">Retour à l’accueil</Link></div>
    </div>
  );
}

/** Bibliothèque : documents par rubrique, dernière version et versions précédentes. */
export function Bibliotheque() {
  const q = useContents('DOCUMENT');
  const [open, setOpen] = useState<string | null>(null);
  const one = useQuery({ queryKey: ['contents', 'one', open], queryFn: () => api<ContentItem>(`/portal/contents/${open}`), enabled: !!open });
  const [err, setErr] = useState<unknown>(null);
  const groups = new Map<string, ContentItem[]>();
  for (const d of q.data ?? []) groups.set(d.category ?? 'Divers', [...(groups.get(d.category ?? 'Divers') ?? []), d]);
  return (
    <div className="stack">
      <PageHeader title="Bibliothèque" subtitle="Procédures, spécifications, contrats types et documentation publiés par SMT" />
      <ErrorBanner error={q.error ?? err} />
      {q.isPending ? <Loading /> : groups.size === 0 ? <div className="card"><Empty>Aucun document publié.</Empty></div> : [...groups].map(([cat, docs]) => (
        <Card key={cat} title={cat}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {docs.map((d) => (
              <li key={d.id} style={{ marginBottom: 8 }}>
                <button type="button" className="btn btn-secondary" style={{ minHeight: 32 }} onClick={() => setOpen(open === d.id ? null : d.id)} aria-expanded={open === d.id}>
                  {d.title} — version {d.version}
                </button>
                {open === d.id && one.data && (
                  <ul>
                    {[...(one.data.files ?? [])].reverse().map((f, i) => (
                      <li key={f.id}>
                        <button type="button" className="btn btn-secondary" style={{ minHeight: 32 }} onClick={() => download(`/portal/contents/files/${f.id}`, f.name).catch(setErr)}>{f.name}</button>
                        <span className="kpi-label"> {i === 0 ? 'version courante' : `version ${(one.data.files ?? []).length - i}`} · {formatDate(f.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
