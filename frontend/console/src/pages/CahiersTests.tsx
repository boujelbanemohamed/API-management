import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ErrorBanner, Field, PageHeader } from '@smt/ui';
import { useCan } from '../session';
import { ApiRow, useList } from '../common';

interface Book { apiId: string; cases: { code: string; title: string; mandatory: boolean }[]; version: number }

/** Cahiers de tests types par service : recopiés dans chaque nouvelle mise en service. */
export function CahiersTests() {
  const can = useCan('catalogue');
  const qc = useQueryClient();
  const apis = useList<ApiRow>('apis', '/apis');
  const [apiId, setApiId] = useState('');
  const book = useQuery({ queryKey: ['book', apiId], queryFn: () => api<Book>(`/test-books/${apiId}`), enabled: !!apiId });
  const [cases, setCases] = useState<Book['cases']>([]);
  useEffect(() => setCases(book.data?.cases ?? []), [book.data]);
  const save = useMutation({ mutationFn: () => api<Book>(`/test-books/${apiId}`, { method: 'PUT', body: { cases } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['book', apiId] }) });
  const set = (i: number, patch: Partial<Book['cases'][number]>) => setCases(cases.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div className="stack" style={{ maxWidth: 960 }}>
      <PageHeader title="Cahiers de tests" subtitle="Cas types par service, recopiés à l’entrée en sandbox de chaque mise en service" />
      <Field label="Service">{(p) => <select {...p} value={apiId} onChange={(e) => setApiId(e.target.value)}><option value="">Choisir…</option>{(apis.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>}</Field>
      {apiId && book.data && (
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <p className="kpi-label">Version {book.data.version}</p>
          {cases.map((c, i) => (
            <div key={i} className="row">
              <Field label={`Code du cas ${i + 1}`}>{(p) => <input {...p} value={c.code} onChange={(e) => set(i, { code: e.target.value })} required disabled={!can} />}</Field>
              <Field label={`Intitulé du cas ${i + 1}`}>{(p) => <input {...p} value={c.title} onChange={(e) => set(i, { title: e.target.value })} required disabled={!can} style={{ minWidth: 320 }} />}</Field>
              <label style={{ display: 'flex', gap: 6 }}><input type="checkbox" checked={c.mandatory} onChange={(e) => set(i, { mandatory: e.target.checked })} disabled={!can} /> Obligatoire</label>
              {can && <button type="button" className="btn btn-secondary" onClick={() => setCases(cases.filter((_, j) => j !== i))}>Retirer</button>}
            </div>
          ))}
          {can && (
            <div className="row">
              <button type="button" className="btn btn-secondary" onClick={() => setCases([...cases, { code: `TC-${String(cases.length + 1).padStart(2, '0')}`, title: '', mandatory: true }])}>Ajouter un cas</button>
              <button type="submit" className="btn btn-primary" disabled={save.isPending}>Enregistrer le cahier</button>
            </div>
          )}
          {save.isSuccess && <div className="banner banner-ok" role="status">Cahier enregistré (version {save.data.version}).</div>}
          <ErrorBanner error={save.error ?? book.error} />
        </form>
      )}
    </div>
  );
}
