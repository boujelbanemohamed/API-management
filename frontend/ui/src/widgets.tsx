import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, download, post, readAsBase64 } from './api';
import { ErrorBanner } from './components';

interface Notif { id: string; title: string; body: string; link: string | null; createdAt: string; readAt: string | null }

/** Cloche de notifications : liste, lecture, navigation vers l'objet concerné. */
export function NotificationsBell({ base }: { base: string }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => api<Notif[]>(base), refetchInterval: 30_000 });
  const read = useMutation({ mutationFn: (id: string) => post(`${base}/${id}/read`), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const readAll = useMutation({ mutationFn: () => post(`${base}/read-all`), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const unread = (q.data ?? []).filter((n) => !n.readAt).length;
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" className="btn btn-secondary" aria-expanded={open} aria-label={`Notifications (${unread} non lues)`} onClick={() => setOpen(!open)}>
        Notifications {unread > 0 && <span className="pill pill-danger">{unread}</span>}
      </button>
      {open && (
        <div className="card" role="dialog" aria-label="Notifications" style={{ position: 'absolute', right: 0, top: 52, width: 380, maxHeight: 460, overflowY: 'auto', zIndex: 10, boxShadow: '0 8px 24px rgba(15,23,42,.12)' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>Notifications</strong>
            {unread > 0 && <button type="button" className="btn btn-secondary" onClick={() => readAll.mutate()}>Tout marquer comme lu</button>}
          </div>
          {(q.data ?? []).length === 0 && <p className="kpi-label">Aucune notification.</p>}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {(q.data ?? []).map((n) => (
              <li key={n.id} style={{ padding: '10px 0', borderTop: '1px solid var(--line)', opacity: n.readAt ? 0.65 : 1 }}>
                <button type="button" onClick={() => { read.mutate(n.id); setOpen(false); if (n.link) navigate(n.link); }} style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}>
                  <strong>{n.title}</strong>
                  <div>{n.body}</div>
                  <div className="kpi-label">{new Date(n.createdAt).toLocaleString('fr-FR')}</div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export interface FileInfo { id: string; name: string; size: number; mime: string; createdAt: string; uploadedBy?: string }

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.txt,.csv,.docx,.xlsx';

/** Pièces jointes d'un dossier : liste, téléchargement, dépôt (analyse antivirus côté serveur). */
export function Attachments({ ownerType, ownerId, apiBase, canUpload, onUploaded }: { ownerType: string; ownerId: string; apiBase: string; canUpload: boolean; onUploaded?: (f: FileInfo) => void }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const key = ['files', ownerType, ownerId];
  const q = useQuery({ queryKey: key, queryFn: () => api<FileInfo[]>(`${apiBase}?ownerType=${ownerType}&ownerId=${ownerId}`) });
  const up = useMutation({
    mutationFn: async (file: File) => post<FileInfo>(apiBase, { ownerType, ownerId, name: file.name, mime: file.type || 'application/octet-stream', content: await readAsBase64(file) }),
    onSuccess: (f) => {
      qc.invalidateQueries({ queryKey: key });
      onUploaded?.(f);
      if (input.current) input.current.value = '';
    },
  });
  const [dlError, setDlError] = useState<unknown>(null);
  return (
    <div className="stack">
      {(q.data ?? []).length === 0 ? <p className="kpi-label">Aucune pièce jointe.</p> : (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {(q.data ?? []).map((f) => (
            <li key={f.id}>
              <button type="button" className="btn btn-secondary" style={{ minHeight: 32, padding: '0 10px' }} onClick={() => download(`${apiBase}/${f.id}/content`, f.name).catch(setDlError)}>{f.name}</button>{' '}
              <span className="kpi-label">{Math.ceil(f.size / 1024)} Ko · {new Date(f.createdAt).toLocaleDateString('fr-FR')}{f.uploadedBy ? ` · ${f.uploadedBy}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
      {canUpload && (
        <div className="field">
          <label htmlFor={`up-${ownerId}`}>Ajouter une pièce</label>
          <input id={`up-${ownerId}`} ref={input} type="file" accept={ACCEPT} onChange={(e) => e.target.files?.[0] && up.mutate(e.target.files[0])} disabled={up.isPending} />
          <span className="hint">PDF, image, texte, CSV, Word ou Excel ; 3 Mo au maximum ; analysée par l’antivirus.</span>
        </div>
      )}
      {up.isPending && <p aria-live="polite" className="kpi-label">Analyse antivirus et envoi…</p>}
      <ErrorBanner error={up.error ?? dlError} />
    </div>
  );
}
