import { describe, it, expect } from 'vitest';
import {
  computeRecurringEndAlerts,
  normalizeAlertPrefs,
  DEFAULT_RECURRING_END_ALERTS,
} from './recurringEndAlerts.js';

const tpl = (over = {}) => ({
  id: 'tpl-1',
  user_id: 'u1',
  type: 'expense',
  category: 'subscriptions',
  amount: 45,
  notes: 'Gimnasio',
  recurrence: 'monthly',
  recurrence_active: true,
  recurrence_until: '2026-09-30',
  ...over,
});

describe('normalizeAlertPrefs', () => {
  it('sin preferencia guardada usa el default (7 y 1 día)', () => {
    expect(normalizeAlertPrefs(null)).toEqual(DEFAULT_RECURRING_END_ALERTS);
    expect(normalizeAlertPrefs(undefined).leadDays).toEqual([7, 1]);
  });

  it('acepta la preferencia como objeto o como string JSON', () => {
    expect(normalizeAlertPrefs({ enabled: true, leadDays: [3] }).leadDays).toEqual([3]);
    expect(normalizeAlertPrefs('{"enabled":true,"leadDays":[3]}').leadDays).toEqual([3]);
  });

  it('un JSON corrupto no tumba el cron: cae al default', () => {
    expect(normalizeAlertPrefs('{no es json')).toEqual(DEFAULT_RECURRING_END_ALERTS);
    expect(normalizeAlertPrefs(42)).toEqual(DEFAULT_RECURRING_END_ALERTS);
    expect(normalizeAlertPrefs([1, 2])).toEqual(DEFAULT_RECURRING_END_ALERTS);
  });

  it('descarta antelaciones fuera de catálogo y duplicados, y ordena de mayor a menor', () => {
    expect(normalizeAlertPrefs({ leadDays: [1, 999, 7, 1, -5, 3] }).leadDays).toEqual([7, 3, 1]);
  });

  it('activado y sin antelaciones es una configuración válida: no avisar', () => {
    // Desmarcar todas las casillas NO puede reinterpretarse como "usa el default"
    expect(normalizeAlertPrefs({ enabled: true, leadDays: [] }).leadDays).toEqual([]);
  });

  it('respeta el apagado explícito', () => {
    expect(normalizeAlertPrefs({ enabled: false, leadDays: [7] }).enabled).toBe(false);
  });
});

describe('computeRecurringEndAlerts', () => {
  it('avisa exactamente en los días configurados', () => {
    const args = { templates: [tpl()], prefsByUser: { u1: { enabled: true, leadDays: [7, 1] } } };
    expect(computeRecurringEndAlerts({ ...args, today: '2026-09-23' })).toHaveLength(1); // −7
    expect(computeRecurringEndAlerts({ ...args, today: '2026-09-29' })).toHaveLength(1); // −1
  });

  it('NO avisa los días intermedios (si no, sería ruido diario)', () => {
    const args = { templates: [tpl()], prefsByUser: { u1: { enabled: true, leadDays: [7, 1] } } };
    for (const day of ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-28']) {
      expect(computeRecurringEndAlerts({ ...args, today: day })).toEqual([]);
    }
  });

  it('leadDay 0 avisa el mismo día que termina', () => {
    const out = computeRecurringEndAlerts({
      templates: [tpl()], prefsByUser: { u1: { enabled: true, leadDays: [0] } }, today: '2026-09-30',
    });
    expect(out[0].daysLeft).toBe(0);
  });

  it('no avisa de recurrentes que ya terminaron', () => {
    expect(computeRecurringEndAlerts({
      templates: [tpl()], prefsByUser: { u1: {} }, today: '2026-10-05',
    })).toEqual([]);
  });

  it('ignora plantillas sin fecha de fin, inactivas o que no son plantillas', () => {
    const prefsByUser = { u1: { enabled: true, leadDays: [7] } };
    const today = '2026-09-23';
    expect(computeRecurringEndAlerts({ templates: [tpl({ recurrence_until: null })], prefsByUser, today })).toEqual([]);
    expect(computeRecurringEndAlerts({ templates: [tpl({ recurrence_active: false })], prefsByUser, today })).toEqual([]);
    expect(computeRecurringEndAlerts({ templates: [tpl({ recurrence: 'none' })], prefsByUser, today })).toEqual([]);
  });

  it('respeta el apagado del usuario', () => {
    expect(computeRecurringEndAlerts({
      templates: [tpl()], prefsByUser: { u1: { enabled: false, leadDays: [7] } }, today: '2026-09-23',
    })).toEqual([]);
  });

  it('cada usuario con su propia configuración', () => {
    const templates = [tpl({ id: 't1', user_id: 'u1' }), tpl({ id: 't2', user_id: 'u2' })];
    const out = computeRecurringEndAlerts({
      templates,
      prefsByUser: { u1: { leadDays: [7] }, u2: { leadDays: [1] } },
      today: '2026-09-23',
    });
    expect(out.map((a) => a.templateId)).toEqual(['t1']); // a u2 le toca el día 29
  });

  it('un usuario sin fila de preferencias recibe el default', () => {
    const out = computeRecurringEndAlerts({ templates: [tpl()], prefsByUser: {}, today: '2026-09-23' });
    expect(out).toHaveLength(1);
  });

  it('lleva los datos que necesita el mensaje', () => {
    const [a] = computeRecurringEndAlerts({ templates: [tpl()], prefsByUser: {}, today: '2026-09-23' });
    expect(a).toMatchObject({
      userId: 'u1', templateId: 'tpl-1', label: 'Gimnasio',
      category: 'subscriptions', amount: 45, type: 'expense',
      endDate: '2026-09-30', daysLeft: 7,
    });
  });

  it('sin nota usa la categoría como etiqueta', () => {
    const [a] = computeRecurringEndAlerts({ templates: [tpl({ notes: '   ' })], prefsByUser: {}, today: '2026-09-23' });
    expect(a.label).toBe('subscriptions');
  });

  it('cuenta días de CALENDARIO, inmune a husos y a cambios de hora', () => {
    // Con timestamps, un until a medianoche y un "hoy" por la tarde daban 6,5
    // días y el aviso de 7 no saltaba nunca.
    const out = computeRecurringEndAlerts({
      templates: [tpl({ recurrence_until: '2026-09-30T00:00:00+02:00' })],
      prefsByUser: { u1: { leadDays: [7] } },
      today: '2026-09-23T18:45:00Z',
    });
    expect(out).toHaveLength(1);
  });

  it('cruza fin de mes y de año sin descuadrarse', () => {
    const out = computeRecurringEndAlerts({
      templates: [tpl({ recurrence_until: '2027-01-03' })],
      prefsByUser: { u1: { leadDays: [7] } },
      today: '2026-12-27',
    });
    expect(out[0].daysLeft).toBe(7);
  });

  it('hoy inválido devuelve vacío en vez de avisar de todo', () => {
    expect(computeRecurringEndAlerts({ templates: [tpl()], prefsByUser: {}, today: 'ayer' })).toEqual([]);
  });
});
