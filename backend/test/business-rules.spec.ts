import { WorkingCalendar, fixedTunisianHolidays } from '../src/common/working-days';
import { RequestStatus, SlaLevel, SlaState, assertAction, assertSecondValidator, dueDate, endSuspension, slaLevel } from '../src/requests/request-rules';
import { OnboardingState, OnboardingStep, TestCaseStatus, TestMode, assertCanAdvance, assertCanSign } from '../src/onboarding/onboarding-rules';
import { DisputeStage, DisputeState, applyAction, expiredLoser, maskPan } from '../src/disputes/dispute-rules';

describe('Calendrier des jours ouvrés tunisiens', () => {
  const cal = new WorkingCalendar(['2026-03-20', '2027-03-10']); // + une fête variable fictive

  it('exclut week-ends et jours fériés fixes et variables', () => {
    expect(cal.isWorkingDay('2026-11-21')).toBe(false); // samedi
    expect(cal.isWorkingDay('2026-12-17')).toBe(false); // révolution
    expect(cal.isWorkingDay('2027-03-10')).toBe(false); // fête variable
    expect(cal.isWorkingDay('2026-11-23')).toBe(true);
    expect(fixedTunisianHolidays(2027)).toContain('2027-07-25');
  });

  it('ajoute des jours ouvrés en sautant week-end et fériés', () => {
    expect(cal.addWorkingDays('2026-11-20', 1)).toBe('2026-11-23'); // vendredi + 1 = lundi
    expect(cal.addWorkingDays('2026-12-16', 2)).toBe('2026-12-21'); // jeudi 17 férié, week-end
    expect(cal.workingDaysBetween('2026-11-20', '2026-11-27')).toBe(5);
  });
});

describe('Demandes : engagement de service', () => {
  const cal = new WorkingCalendar();
  const base: SlaState = { status: RequestStatus.IN_PROGRESS, openedOn: '2026-11-23', slaDays: 4, suspendedWorkingDays: 0, suspendedSince: null, doneOn: null };

  it('calcule échéance, alerte à 75 % et dépassement à 100 %', () => {
    expect(dueDate(base, cal, '2026-11-23')).toBe('2026-11-27');
    expect(slaLevel(base, cal, '2026-11-25')).toBe(SlaLevel.OK); // 2/4
    expect(slaLevel(base, cal, '2026-11-26')).toBe(SlaLevel.ALERT); // 3/4
    expect(slaLevel(base, cal, '2026-11-27')).toBe(SlaLevel.BREACH);
  });

  it('suspend le délai pendant l’attente de la banque', () => {
    const waiting = { ...base, status: RequestStatus.WAITING_BANK, suspendedSince: '2026-11-24' };
    expect(slaLevel(waiting, cal, '2026-12-10')).toBe(SlaLevel.PAUSED);
    const resumed = { ...base, suspendedWorkingDays: endSuspension(waiting, cal, '2026-11-26') };
    expect(resumed.suspendedWorkingDays).toBe(2);
    expect(dueDate(resumed, cal, '2026-11-26')).toBe('2026-12-01');
    expect(slaLevel(resumed, cal, '2026-11-27')).toBe(SlaLevel.OK); // 4 - 2 = 2 jours consommés
  });

  it('exige deux personnes distinctes et refuse les transitions invalides', () => {
    expect(() => assertSecondValidator('amel', 'Amel')).toThrow('autre personne');
    expect(() => assertSecondValidator('amel', 'karim')).not.toThrow();
    expect(() => assertAction(RequestStatus.NEW, 'close')).toThrow('impossible');
  });
});

describe('Mises en service', () => {
  const o = (over: Partial<OnboardingState>): OnboardingState => ({
    step: OnboardingStep.CONTRACT, cancelled: false, contractReference: null, contractValidatedBy: null,
    testMode: null, jointSessions: 0, bankSignedBy: null, smtSignedBy: null, ...over,
  });

  it('bloque sans contrat validé, sans mode de test, sans tests réussis avec preuve', () => {
    expect(() => assertCanAdvance(o({}), [])).toThrow('contrat');
    expect(assertCanAdvance(o({ contractReference: 'C-1', contractValidatedBy: 'juriste' }), [])).toBe(OnboardingStep.SANDBOX);
    expect(() => assertCanAdvance(o({ step: OnboardingStep.SANDBOX }), [])).toThrow('mode de test');
    const tests = o({ step: OnboardingStep.TESTS, testMode: TestMode.AUTONOMOUS });
    expect(() => assertCanAdvance(tests, [{ mandatory: true, status: TestCaseStatus.PASSED, evidence: null }])).toThrow('preuve');
    expect(assertCanAdvance(tests, [
      { mandatory: true, status: TestCaseStatus.PASSED, evidence: 'trace-1' },
      { mandatory: false, status: TestCaseStatus.FAILED, evidence: null },
    ])).toBe(OnboardingStep.ACCEPTANCE);
  });

  it('exige une session conjointe hors autonomie', () => {
    const tests = o({ step: OnboardingStep.TESTS, testMode: TestMode.MIXED });
    const ok = [{ mandatory: true, status: TestCaseStatus.PASSED, evidence: 'x' }];
    expect(() => assertCanAdvance(tests, ok)).toThrow('conjointe');
    expect(assertCanAdvance({ ...tests, jointSessions: 1 }, ok)).toBe(OnboardingStep.ACCEPTANCE);
  });

  it('exige le PV signé par la banque ET par SMT', () => {
    const acc = o({ step: OnboardingStep.ACCEPTANCE, bankSignedBy: 'banque' });
    expect(() => assertCanAdvance(acc, [])).toThrow('banque et par SMT');
    expect(() => assertCanSign(acc, 'BANK')).toThrow('déjà signé');
    expect(assertCanAdvance({ ...acc, smtSignedBy: 'smt' }, [])).toBe(OnboardingStep.PRODUCTION);
  });
});

describe('Litiges : scheme national', () => {
  const s = (over: Partial<DisputeState>): DisputeState => ({
    stage: DisputeStage.OPENED, transactionDate: '2026-10-01', transactionAmount: 100_000, deadline: '2027-01-29', ...over,
  });

  it('produit les messages ISO et délais de chaque étape', () => {
    const cb = applyAction(s({}), 'chargeback', { party: 'ISSUER', amount: 40_000 }, '2026-11-23');
    expect(cb).toEqual({ stage: DisputeStage.CHARGEBACK, deadline: '2027-01-07', message: { mti: '1442', functionCode: '453' } });
    const rep = applyAction(s({ stage: DisputeStage.CHARGEBACK, deadline: cb.deadline }), 'second-presentment', { party: 'ACQUIRER' }, '2026-12-01');
    expect(rep.message).toEqual({ mti: '1240', functionCode: '205' });
    expect(rep.deadline).toBe('2026-12-31');
    const info = applyAction(s({}), 'info-request', { party: 'ISSUER' }, '2026-11-23');
    expect(info.message).toEqual({ mti: '1644', functionCode: '603' });
  });

  it('refuse hors délai, hors tour, et le second chargeback sans nouveau justificatif', () => {
    expect(() => applyAction(s({ deadline: '2026-11-01' }), 'chargeback', { party: 'ISSUER' }, '2026-11-23')).toThrow('Délai dépassé');
    expect(() => applyAction(s({}), 'chargeback', { party: 'ACQUIRER' }, '2026-11-23')).toThrow('ISSUER');
    const rep = s({ stage: DisputeStage.SECOND_PRESENTMENT, deadline: '2026-12-31' });
    expect(() => applyAction(rep, 'second-chargeback', { party: 'ISSUER' }, '2026-12-02')).toThrow('nouveau justificatif');
    expect(applyAction(rep, 'second-chargeback', { party: 'ISSUER', newDocument: true }, '2026-12-02').message?.functionCode).toBe('451');
  });

  it('arbitrage : décision SMT avec frais (1740) ; échéance sans réponse = la partie défaillante perd', () => {
    const arb = s({ stage: DisputeStage.ARBITRATION_REQUESTED, deadline: null });
    expect(applyAction(arb, 'decide', { party: 'SMT', winner: 'ISSUER', fees: 50_000 }, '2027-02-01').message?.mti).toBe('1740');
    expect(expiredLoser(s({ stage: DisputeStage.CHARGEBACK, deadline: '2026-11-01' }), '2026-11-23')).toBe('ACQUIRER');
  });

  it('masque le numéro de carte', () => {
    expect(maskPan('4123 4567 8901 2345')).toBe('412345******2345');
  });
});
