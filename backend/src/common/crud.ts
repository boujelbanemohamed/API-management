import { NotFoundException } from '@nestjs/common';
import { ObjectLiteral, Repository } from 'typeorm';

/** Charge un élément par identifiant ou renvoie 404 avec un message lisible. */
export async function findOr404<T extends ObjectLiteral>(repo: Repository<T>, id: string, label: string): Promise<T> {
  const item = UUID.test(id) ? await repo.findOne({ where: { id } as any }) : null;
  if (!item) throw new NotFoundException(`${label} introuvable`);
  return item;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Différence champ par champ, pour la piste d'audit. */
export function diff(before: Record<string, any>, patch: Record<string, any>): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(value)) changes[key] = { from: before[key], to: value };
  }
  return changes;
}
