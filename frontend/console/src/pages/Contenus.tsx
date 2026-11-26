import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, post, readAsBase64, Card, ErrorBanner, Field, formatDate, Loading, PageHeader, Pill, Table } from '@smt/ui';
import { PartnerRow, useList } from '../common';

interface ContentRow { id: string; kind: string; title: string; body: string; important: boolean; audience: string; partnerIds: string[] | null; status: string; publishedAt: string | null; version: number; category: string | null; eventDate: string | null }
const KIND: Record<string, string> = { COMMUNIQUE: 'Communiqué', EVENEMENT: 'Événement', ENQUETE: 'Enquête', DOCUMENT: 'Document (bibliothèque)' };
const STATUS: Record<string, { text: string; tone?: 'ok' | 'warn' }> = { DRAFT: { text: 'Brouillon', tone: 'warn' }, PUBLISHED: { text: 'Publié', tone: 'ok' }, ARCHIVED: { text: 'Archivé' } };

/** Questions saisies une par ligne : « Libellé | option 1, option 2 » (sans options : réponse libre). */
function parseQuestions(text: string) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l, i) => {
    const [label, opts] = l.split('|').map((x) => x.trim());
    const options = opts ? opts.split(',').map((o) => o.trim()).filter(Boolean) : [];
    return { id: `q${i + 1}`, label, type: options.length ? 'choice' : 'text', ...(options.length ? { options } : {}) };
  });
}

export function Contenus() {
  const qc = useQueryClient();
  const q = useList<ContentRow>('contents', '/contents');
  const partners = useList<PartnerRow>('partners', '/partners');
  const empty = { kind: 'COMMUNIQUE', title: '', body: '', important: false, audience: 'ALL', partnerIds: [] as string[], eventDate: '', location: '', category: '', questions: '' };
  const [f, setF] = useState(empty);
  const [results, setResults] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['contents'] });
  const create = useMutation({
    mutationFn: () => post('/contents', {
      kind: f.kind, title: f.title, body: f.body, important: f.important, audience: f.audience,
      ...(f.audience === 'SELECTED' ? { partnerIds: f.partnerIds } : {}),
      ...(f.kind === 'EVENEMENT' ? { eventDate: f.eventDate || undefined, location: f.location || undefined } : {}),
      ...(f.kind === 'DOCUMENT' ? { category: f.category || undefined } : {}),
      ...(f.kind === 'ENQUETE' ? { questions: parseQuestions(f.questions) } : {}),
    }),
    onSuccess: () => { setF(empty); refresh(); },
  });
  const act = useMutation({ mutationFn: (v: { id: string; a: 'publish' | 'archive' }) => post(`/contents/${v.id}/${v.a}`), onSuccess: refresh });
  const attach = useMutation({ mutationFn: async (v: { id: string; file: File }) => post(`/contents/${v.id}/file`, { name: v.file.name, mime: v.file.type, content: await readAsBase64(v.file) }), onSuccess: refresh });
  const res = useQuery({ queryKey: ['contents', 'results', results], queryFn: () => api<{ total: number; questions: { label: string; counts?: Record<string, number>; texts?: { bank: string; text: string }[] }[] }>(`/contents/${results}/results`), enabled: !!results });
  return (
    <div className="stack">
      <PageHeader title="Contenus" subtitle="Communiqués, événements, enquêtes et bibliothèque ; les banques ciblées sont notifiées à la publication" />
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <h2>Nouveau contenu</h2>
        <div className="grid grid-3">
          <Field label="Type">{(p) => <select {...p} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
          <Field label="Titre">{(p) => <input {...p} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required />}</Field>
          <Field label="Destinataires">{(p) => <select {...p} value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })}><option value="ALL">Toutes les banques</option><option value="SELECTED">Une sélection</option></select>}</Field>
        </div>
        {f.audience === 'SELECTED' && (
          <fieldset className="row" style={{ border: 0, padding: 0 }}>
            <legend className="kpi-label">Banques</legend>
            {(partners.data ?? []).filter((p) => p.status === 'ACTIVE').map((p) => (
              <label key={p.id} style={{ display: 'flex', gap: 6 }}><input type="checkbox" checked={f.partnerIds.includes(p.id)} onChange={() => setF({ ...f, partnerIds: f.partnerIds.includes(p.id) ? f.partnerIds.filter((x) => x !== p.id) : [...f.partnerIds, p.id] })} /> {p.code}</label>
            ))}
          </fieldset>
        )}
        {f.kind !== 'DOCUMENT' && <Field label="Texte">{(p) => <textarea {...p} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />}</Field>}
        {f.kind === 'COMMUNIQUE' && <label style={{ display: 'flex', gap: 8 }}><input type="checkbox" checked={f.important} onChange={(e) => setF({ ...f, important: e.target.checked })} /> Important : affiché sur l’accueil du portail</label>}
        {f.kind === 'EVENEMENT' && <div className="row"><Field label="Date">{(p) => <input {...p} type="date" value={f.eventDate} onChange={(e) => setF({ ...f, eventDate: e.target.value })} />}</Field><Field label="Lieu">{(p) => <input {...p} value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />}</Field></div>}
        {f.kind === 'DOCUMENT' && <Field label="Rubrique" hint="ex. Procédures, Spécifications, Contrats types">{(p) => <input {...p} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />}</Field>}
        {f.kind === 'ENQUETE' && <Field label="Questions" hint="Une par ligne. Choix : « Votre note | 1, 2, 3, 4, 5 ». Sans « | » : réponse libre.">{(p) => <textarea {...p} value={f.questions} onChange={(e) => setF({ ...f, questions: e.target.value })} required />}</Field>}
        <ErrorBanner error={create.error} />
        <div><button className="btn btn-primary" type="submit" disabled={create.isPending}>Enregistrer en brouillon</button></div>
      </form>
      <ErrorBanner error={q.error ?? act.error ?? attach.error} />
      {q.isPending ? <Loading /> : (
        <Table caption="Contenus" rows={q.data ?? []} rowKey={(c) => c.id} empty="Aucun contenu."
          columns={[
            { header: 'Contenu', cell: (c) => <><strong>{c.title}</strong>{c.important && <> <Pill label={{ text: 'Important', tone: 'warn' }} /></>}<div className="kpi-label">{KIND[c.kind]}{c.kind === 'DOCUMENT' ? ` · ${c.category ?? 'Divers'} · version ${c.version}` : ''}</div></> },
            { header: 'Destinataires', cell: (c) => (c.audience === 'ALL' ? 'Toutes' : (c.partnerIds ?? []).map((id) => partners.data?.find((p) => p.id === id)?.code ?? '…').join(', ')) },
            { header: 'État', cell: (c) => <><Pill label={STATUS[c.status]} />{c.publishedAt && <div className="kpi-label">{formatDate(c.publishedAt)}</div>}</> },
            { header: 'Actions', cell: (c) => (
              <div className="row">
                {c.kind === 'DOCUMENT' && c.status !== 'ARCHIVED' && (
                  <label className="btn btn-secondary">Nouvelle version<input type="file" className="sr-only" accept=".pdf,.docx,.xlsx,.txt,.csv,.png,.jpg" onChange={(e) => e.target.files?.[0] && attach.mutate({ id: c.id, file: e.target.files[0] })} /></label>
                )}
                {c.status === 'DRAFT' && <button className="btn btn-primary" onClick={() => act.mutate({ id: c.id, a: 'publish' })}>Publier</button>}
                {c.status === 'PUBLISHED' && <button className="btn btn-secondary" onClick={() => act.mutate({ id: c.id, a: 'archive' })}>Archiver</button>}
                {c.kind === 'ENQUETE' && <button className="btn btn-secondary" onClick={() => setResults(results === c.id ? null : c.id)}>Résultats</button>}
              </div>
            ) },
          ]} />
      )}
      {results && res.data && (
        <Card title={`Résultats (${res.data.total} réponse(s))`}>
          {res.data.questions.map((qq) => (
            <div key={qq.label}>
              <strong>{qq.label}</strong>
              {qq.counts && <ul>{Object.entries(qq.counts).map(([o, n]) => <li key={o}>{o} : {n}</li>)}</ul>}
              {qq.texts && <ul>{qq.texts.map((t, i) => <li key={i}>{t.bank} — {t.text}</li>)}</ul>}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
