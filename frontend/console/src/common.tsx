import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, post } from '@smt/ui';

/** Liste lue sur le back-end, partagée par clé. */
export function useList<T>(key: string, path: string, enabled = true) {
  return useQuery({ queryKey: [key, path], queryFn: () => api<T[]>(path), enabled });
}

/** Action POST qui rafraîchit les listes concernées ; l'erreur est rendue par l'écran. */
export function useAction(keys: string[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { path: string; body?: unknown }) => post<unknown>(v.path, v.body ?? {}),
    onSuccess: () => keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] })),
  });
}

/** Motif obligatoire pour les actions qui l'exigent (rejet, suspension…). */
export function askReason(question: string): string | null {
  const r = window.prompt(question);
  return r && r.trim().length >= 3 ? r.trim() : null;
}

export interface PartnerRow { id: string; code: string; name: string; status: string; type: string }
export interface ApiRow { id: string; name: string; slug: string; version: string; publicPath: string; upstreamPath: string; status: string; providerId: string }
export interface PlanRow { id: string; name: string; dailyQuota: number; rateLimitPerSecond: number; approval: string; active: boolean; monthlyFee?: number; pricePerCall?: number }
export interface ProviderRow { id: string; name: string; kind: string; baseUrl: string; sandboxBaseUrl: string | null }
