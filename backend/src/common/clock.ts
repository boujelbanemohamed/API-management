import { todayInTunis } from './dates';

/** Horloge injectable : permet de tester les règles de dates sans dépendre du jour réel. */
export interface Clock {
  now(): Date;
  today(): string;
}

export const CLOCK = Symbol('CLOCK');

export const systemClock: Clock = {
  now: () => new Date(),
  today: () => todayInTunis(),
};

export class FixedClock implements Clock {
  constructor(private day: string) {}
  set(day: string): void {
    this.day = day;
  }
  now(): Date {
    return new Date(`${this.day}T10:00:00+01:00`);
  }
  today(): string {
    return this.day;
  }
}
