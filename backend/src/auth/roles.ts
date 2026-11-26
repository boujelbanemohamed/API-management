/**
 * Droits par section de menu (spécifications §14, F-ROL-01).
 * Une section non autorisée n'apparaît pas dans le menu et ses API répondent 403.
 */

export enum ConsoleRole {
  ADMIN = 'console-admin',
  AGENT_OPERATIONS = 'console-agent-operations',
  AGENT_INTEGRATION = 'console-agent-integration',
  AGENT_SECURITE = 'console-agent-securite',
  AGENT_SUPPORT = 'console-agent-support',
  AGENT_LITIGES = 'console-agent-litiges',
  ARBITRE = 'console-arbitre',
  FACTURATION = 'console-facturation',
  AUDITEUR = 'console-auditeur',
}

export enum BankRole {
  ADMIN_SECURITE = 'banque-admin-securite',
  OPERATEUR = 'banque-operateur-monetique',
  LITIGES = 'banque-gestionnaire-litiges',
  DEVELOPPEUR = 'banque-developpeur',
  FACTURATION = 'banque-facturation',
  LECTURE = 'banque-lecture',
}

const AGENTS = [
  ConsoleRole.AGENT_OPERATIONS,
  ConsoleRole.AGENT_INTEGRATION,
  ConsoleRole.AGENT_SECURITE,
  ConsoleRole.AGENT_SUPPORT,
  ConsoleRole.AGENT_LITIGES,
];

/** Sections de la console → rôles autorisés à écrire. L'administrateur a tout ; l'auditeur lit tout. */
export const CONSOLE_SECTIONS = {
  demandes: [...AGENTS],
  litiges: [ConsoleRole.AGENT_LITIGES, ConsoleRole.ARBITRE],
  'mises-en-service': [ConsoleRole.AGENT_INTEGRATION],
  banques: [ConsoleRole.AGENT_INTEGRATION, ConsoleRole.AGENT_SECURITE],
  catalogue: [ConsoleRole.AGENT_INTEGRATION],
  finance: [ConsoleRole.FACTURATION],
  administration: [] as ConsoleRole[],
} as const;

export type ConsoleSection = keyof typeof CONSOLE_SECTIONS;

/** Sections du portail → rôles autorisés à écrire. L'administrateur sécurité a tout ; « lecture » lit tout. */
export const PORTAL_SECTIONS = {
  operations: [BankRole.OPERATEUR],
  demandes: [BankRole.OPERATEUR, BankRole.DEVELOPPEUR, BankRole.LITIGES],
  litiges: [BankRole.LITIGES],
  developpeurs: [BankRole.DEVELOPPEUR],
  compte: [BankRole.FACTURATION],
} as const;

export type PortalSection = keyof typeof PORTAL_SECTIONS;

/** Rôles qui peuvent seulement lire dans une section (GET). */
const CONSOLE_READERS: Partial<Record<ConsoleSection, ConsoleRole[]>> = {
  // L'arbitre lit les banques pour identifier les parties d'un litige.
  banques: [...AGENTS, ConsoleRole.FACTURATION, ConsoleRole.ARBITRE],
  catalogue: [...AGENTS],
  finance: [ConsoleRole.AGENT_INTEGRATION],
};

const PORTAL_READERS: Partial<Record<PortalSection, BankRole[]>> = {
  developpeurs: [BankRole.OPERATEUR],
  compte: [BankRole.DEVELOPPEUR],
};

export function canConsole(roles: string[], section: ConsoleSection, write: boolean): boolean {
  if (roles.includes(ConsoleRole.ADMIN)) return true;
  if (!write && roles.includes(ConsoleRole.AUDITEUR)) return true;
  const allowed: string[] = [...CONSOLE_SECTIONS[section], ...(write ? [] : (CONSOLE_READERS[section] ?? []))];
  return roles.some((r) => allowed.includes(r));
}

export function canPortal(roles: string[], section: PortalSection, write: boolean): boolean {
  if (roles.includes(BankRole.ADMIN_SECURITE)) return true;
  if (!write && roles.includes(BankRole.LECTURE)) return true;
  const allowed: string[] = [...PORTAL_SECTIONS[section], ...(write ? [] : (PORTAL_READERS[section] ?? []))];
  return roles.some((r) => allowed.includes(r));
}

/** Sections visibles dans le menu (au moins la lecture). */
export function visibleConsoleSections(roles: string[]): ConsoleSection[] {
  return (Object.keys(CONSOLE_SECTIONS) as ConsoleSection[]).filter((s) => canConsole(roles, s, false));
}

export function visiblePortalSections(roles: string[]): PortalSection[] {
  return (Object.keys(PORTAL_SECTIONS) as PortalSection[]).filter((s) => canPortal(roles, s, false));
}
