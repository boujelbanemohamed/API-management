/** Formes des réponses du BFF du portail (/portal/...). */

export interface Me {
  username: string;
  partner: { id: string; code: string; name: string; status: string };
  roles: string[];
  sections: string[];
}

export interface ServiceRequest {
  id: string;
  partnerId: string;
  type: string;
  subject: string;
  context: Record<string, string> | null;
  status: string;
  team: string;
  openedOn: string;
  dueDate: string;
  sla: string;
  doneOn: string | null;
  rejectionReason: string | null;
}

export interface DisputeEvent {
  id: string;
  action: string;
  party: string;
  actor: string;
  occurredOn: string;
  toStage: string;
  mti: string | null;
  functionCode: string | null;
  amount: number | null;
  documentRef: string | null;
}

export interface Dispute {
  id: string;
  issuerId: string;
  acquirerId: string;
  transactionRef: string;
  maskedPan: string;
  transactionDate: string;
  transactionAmount: number;
  reasonCode: string;
  stage: string;
  deadline: string | null;
  disputedAmount: number | null;
  winner: string | null;
  events?: DisputeEvent[];
}

export interface CatalogueItem {
  id: string;
  name: string;
  slug: string;
  version: string;
  description: string | null;
  publicPath: string;
  status: string;
  securityLevel: string;
}

export interface PlanItem { id: string; name: string; dailyQuota: number; monthlyQuota: number | null; rateLimitPerSecond: number }

export interface TestCase { id: string; code: string; title: string; mandatory: boolean; status: string; evidence: string | null }

export interface Onboarding {
  id: string;
  partnerId: string;
  apiId: string;
  planId: string;
  step: string;
  cancelled: boolean;
  testMode: string | null;
  jointSessions: number;
  contractReference: string | null;
  bankSignedBy: string | null;
  smtSignedBy: string | null;
  productionSubscriptionId: string | null;
  createdAt: string;
  testCases?: TestCase[];
}

export interface Subscription {
  id: string;
  apiId: string;
  planId: string;
  environment: string;
  status: string;
  startDate: string;
  endDate: string | null;
}

export interface UsageRow { apiSlug: string; calls: number; billable: number; errors: number; avgLatencyMs: number }
