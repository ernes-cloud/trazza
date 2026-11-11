/**
 * P0-2 recurringEndAlerts unificado: una sola fuente entre src y server.
 *
 * Si hoy hay dos copias (aunque sean byte-idénticas) este test exige que una
 * importe de la otra o que ambas sean el mismo módulo. La equivalencia de la
 * API pública se comprueba aparte y puede estar verde ya.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as srcAlerts from './recurringEndAlerts.js';
import * as serverAlerts from '../../server/lib/recurringEndAlerts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'src/services/recurringEndAlerts.js');
const SRV = path.join(ROOT, 'server/lib/recurringEndAlerts.js');

function isReexportOf(fileSrc, otherHint) {
  const trimmed = fileSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\n)\s*\/\/.*(?=\n|$)/g, '$1');
  const importsOther = new RegExp(`from\\s+['"][^'"]*${otherHint}[^'"]*['"]`).test(fileSrc);
  const star = /export\s+\*\s+from/.test(fileSrc);
  const named = /export\s+\{[\s\S]*\}\s+from/.test(fileSrc);
  return importsOther && (star || named || trimmed.split('\n').filter((l) => l.trim()).length <= 20);
}

const fixtureArgs = {
  templates: [{
    id: 'tpl-1',
    user_id: 'u1',
    type: 'expense',
    category: 'subscriptions',
    amount: 45,
    notes: 'Gimnasio',
    recurrence: 'monthly',
    recurrence_active: true,
    recurrence_until: '2026-09-30',
  }],
  prefsByUser: { u1: { enabled: true, leadDays: [7, 1] } },
};

describe('P0-2 recurringEndAlerts unificado', () => {
  it('la API pública de src y server es equivalente', () => {
    expect(Object.keys(srcAlerts).sort()).toEqual(Object.keys(serverAlerts).sort());
    expect(srcAlerts.LEAD_DAY_OPTIONS).toEqual(serverAlerts.LEAD_DAY_OPTIONS);
    expect(srcAlerts.DEFAULT_RECURRING_END_ALERTS).toEqual(serverAlerts.DEFAULT_RECURRING_END_ALERTS);
    expect(srcAlerts.normalizeAlertPrefs(null)).toEqual(serverAlerts.normalizeAlertPrefs(null));
    expect(srcAlerts.normalizeAlertPrefs({ enabled: true, leadDays: [1, 999, 7, 1] }))
      .toEqual(serverAlerts.normalizeAlertPrefs({ enabled: true, leadDays: [1, 999, 7, 1] }));
    expect(srcAlerts.computeRecurringEndAlerts({ ...fixtureArgs, today: '2026-09-23' }))
      .toEqual(serverAlerts.computeRecurringEndAlerts({ ...fixtureArgs, today: '2026-09-23' }));
    expect(srcAlerts.computeRecurringEndAlerts({ ...fixtureArgs, today: '2026-09-24' }))
      .toEqual(serverAlerts.computeRecurringEndAlerts({ ...fixtureArgs, today: '2026-09-24' }));
    expect(srcAlerts.computeRecurringEndAlerts({ ...fixtureArgs, today: '2026-09-29' }))
      .toEqual(serverAlerts.computeRecurringEndAlerts({ ...fixtureArgs, today: '2026-09-29' }));
  });

  it('hay una sola fuente: una versión importa de la otra (dos copias, aunque idénticas, no bastan)', () => {
    expect(fs.existsSync(SRC), SRC).toBe(true);
    expect(fs.existsSync(SRV), SRV).toBe(true);
    const sameInode = fs.statSync(SRC).ino === fs.statSync(SRV).ino
      && fs.statSync(SRC).dev === fs.statSync(SRV).dev;
    const src = fs.readFileSync(SRC, 'utf8');
    const srv = fs.readFileSync(SRV, 'utf8');
    const unified = sameInode
      || isReexportOf(src, 'recurringEndAlerts')
      || isReexportOf(srv, 'recurringEndAlerts');
    expect(
      unified,
      'src/services/recurringEndAlerts.js y server/lib/recurringEndAlerts.js son dos módulos; unifica con un reexport (una importa de la otra)',
    ).toBe(true);
  });
});
