import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, post, Card, ErrorBanner, Field, FULL_PAN, PageHeader } from '@smt/ui';

interface Answer { answer: string; mode: 'modele' | 'extraits'; sources: { title: string; kind: string; link: string; excerpt: string }[] }

/** Assistant : répond à partir des documents SMT publiés, en citant ses sources. */
export function Assistant() {
  const [question, setQuestion] = useState('');
  const status = useQuery({ queryKey: ['assistant'], queryFn: () => api<{ model: boolean }>('/portal/assistant') });
  const ask = useMutation({ mutationFn: () => post<Answer>('/portal/assistant', { question }) });
  const hasPan = FULL_PAN.test(question);
  return (
    <div className="stack" style={{ maxWidth: 900 }}>
      <PageHeader title="Assistant" subtitle={status.data?.model ? 'Réponses rédigées à partir de la bibliothèque et du catalogue SMT, sources citées' : 'Recherche dans la bibliothèque et le catalogue SMT'} />
      <div className="banner banner-info">L’assistant ne voit aucune donnée de transaction. Ne saisissez jamais de numéro de carte.</div>
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); ask.mutate(); }}>
        <Field label="Votre question" error={hasPan ? 'Retirez le numéro de carte de votre question.' : undefined}>
          {(p) => <textarea {...p} value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={500} required minLength={3} />}
        </Field>
        <div><button className="btn btn-primary" type="submit" disabled={ask.isPending || hasPan || question.trim().length < 3}>Poser la question</button></div>
      </form>
      <ErrorBanner error={ask.error} />
      {ask.isPending && <p aria-live="polite" className="kpi-label">Recherche…</p>}
      {ask.data && (
        <Card title="Réponse">
          <p style={{ whiteSpace: 'pre-wrap' }} aria-live="polite">{ask.data.answer}</p>
          {ask.data.sources.length > 0 && (
            <>
              <h3>Sources</h3>
              <ol>
                {ask.data.sources.map((s, i) => (
                  <li key={i}><strong>{s.kind}</strong> — <Link to={s.link}>{s.title}</Link><div className="kpi-label">{s.excerpt}</div></li>
                ))}
              </ol>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
