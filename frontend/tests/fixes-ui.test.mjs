/**
 * Static guards for the camera-storage / activation / events-date / reports fixes.
 *
 * `next dev` cannot run in this sandbox, so these assert the invariants that a
 * browser pass would otherwise catch: no fabricated storage numbers, a real
 * activation control, today-by-default events, and reports that cannot show one
 * period's data under another period's label.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SRC = join(ROOT, 'src');

const read = (...parts) => readFileSync(join(SRC, ...parts), 'utf8');

const camerasPage = read('app', '(dashboard)', 'cameras', 'page.tsx');
const eventsPage = read('app', '(dashboard)', 'events', 'page.tsx');
const reportsPage = read('app', '(dashboard)', 'reports', 'page.tsx');
const utils = read('lib', 'utils.ts');
const datetimeLib = read('lib', 'datetime.ts');

const vi = JSON.parse(read('locales', 'vi.json'));
const en = JSON.parse(read('locales', 'en.json'));

const flatten = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flatten(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );

describe('A. camera storage is measured, never fabricated', () => {
  it('keeps no fabricated constants in the cameras page', () => {
    for (const forbidden of ['18.5', 'storageGb ??', 'resolutions[', '4K UHD (3840x2160)']) {
      assert.ok(!camerasPage.includes(forbidden), `cameras page must not contain "${forbidden}"`);
    }
  });

  it('renders the measured value and its explicit states', () => {
    assert.ok(camerasPage.includes('formatBytes'), 'must format real byte counts');
    assert.ok(camerasPage.includes('measurementStatus'), 'must branch on the measurement status');
    assert.ok(camerasPage.includes('cameras.storageUnavailable'), 'must show an unavailable state');
    assert.ok(camerasPage.includes('cameras.storageCalculating'), 'must show a calculating state');
  });

  it('does not invent a resolution', () => {
    assert.ok(!camerasPage.includes('|| "1080p HD"'), 'no hardcoded resolution fallback');
    assert.ok(camerasPage.includes('cameras.resolutionUnknown'), 'unknown resolution must be labelled');
    assert.ok(camerasPage.includes('formatResolution'), 'must render the configured value');
  });

  it('no longer renders a fake percentage bar against a 100 GB cap', () => {
    assert.ok(!camerasPage.includes('/ 100) * 100'), 'the arbitrary quota bar must be gone');
  });

  it('formats bytes with base-1024 units and keeps null distinct from zero', () => {
    assert.ok(utils.includes('1024'), 'must use base-1024');
    assert.ok(utils.includes("if (bytes === 0) return '0 B'"), 'zero must render as 0 B');
    assert.ok(utils.includes("return '—'"), 'unmeasured must not render as a number');
    for (const unit of ['B', 'KB', 'MB', 'GB', 'TB']) {
      assert.ok(utils.includes(`'${unit}'`), `missing unit ${unit}`);
    }
  });
});

describe('B. camera activation control', () => {
  it('calls the dedicated activation endpoint, not delete', () => {
    assert.ok(camerasPage.includes('/activation'), 'must PATCH the activation endpoint');
    assert.ok(camerasPage.includes('isActive'), 'must send the isActive flag');
    // The toggle handler must not delete anything.
    const toggleBlock = camerasPage.slice(
      camerasPage.indexOf('const toggleActivation'),
      camerasPage.indexOf('const statusIcon'),
    );
    assert.ok(toggleBlock.length > 0, 'toggleActivation must exist');
    assert.ok(!toggleBlock.includes('api.delete'), 'deactivation must never call DELETE');
  });

  it('shows connectivity and activation separately', () => {
    assert.ok(camerasPage.includes('cameras.statusOnline'), 'connectivity badge stays');
    assert.ok(camerasPage.includes('cameras.statusActive'), 'activation badge is separate');
    assert.ok(camerasPage.includes('cameras.statusInactive'), 'inactive label exists');
  });

  it('offers an activation filter alongside the connectivity filter', () => {
    assert.ok(camerasPage.includes('activationFilter'), 'activation filter state');
    assert.ok(camerasPage.includes('cameras.activationFilterInactive'));
    assert.ok(camerasPage.includes('statusFilter'), 'connectivity filter is preserved');
  });

  it('is permission aware', () => {
    assert.ok(camerasPage.includes('useAuth'), 'must read the current role');
    assert.ok(camerasPage.includes('canEdit'), 'must gate editing on the role');
  });

  it('keeps deactivated cameras visible (no isActive filter on the default query)', () => {
    assert.ok(
      !/where:\s*\{\s*isActive:\s*true\s*\}/.test(camerasPage),
      'the list must not hide deactivated cameras',
    );
  });
});

describe('C. events default to today with an all-dates option', () => {
  it('defaults to the today mode', () => {
    assert.ok(
      /useState<EventDateMode>\("today"\)/.test(eventsPage),
      'date mode must default to "today"',
    );
  });

  it('supports today, all and custom modes', () => {
    for (const mode of ['"today"', '"all"', '"custom"']) {
      assert.ok(eventsPage.includes(mode), `missing date mode ${mode}`);
    }
    assert.ok(eventsPage.includes('events.dateAll'), 'needs an explicit All dates option');
  });

  it('never derives a calendar date from toISOString', () => {
    for (const [name, source] of [
      ['events', eventsPage],
      ['reports', reportsPage],
      ['cameras', camerasPage],
    ]) {
      assert.ok(
        !source.includes('toISOString().split("T")[0]'),
        `${name} page must not use the UTC date as a local date`,
      );
    }
    assert.ok(eventsPage.includes('todayKey'), 'must use the timezone-aware helper');
  });

  it('keeps live socket inserts inside the active filters', () => {
    assert.ok(eventsPage.includes('matchesCurrentView'), 'new events must be filtered');
    const handler = eventsPage.slice(
      eventsPage.indexOf('const handleNewEvent'),
      eventsPage.indexOf('useSocket('),
    );
    assert.ok(handler.includes('matchesCurrentView(event)'), 'the guard must be applied');
  });

  it('reads statistics from the backend instead of the current page', () => {
    assert.ok(eventsPage.includes('/events/stats'), 'must call the stats endpoint');
    assert.ok(!eventsPage.includes('events.reduce((acc, e) => acc + (e.confidence'), 'no page-level average');
  });

  it('keeps the notification deep link working', () => {
    assert.ok(eventsPage.includes('eventId'), 'the ?eventId= deep link must survive');
    assert.ok(eventsPage.includes('openEvent'), 'the detail dialog must still open');
  });
});

describe('D. reports periods', () => {
  it('keeps a distinct state per period', () => {
    assert.ok(reportsPage.includes('dailyReport'), 'daily state');
    assert.ok(reportsPage.includes('weeklyReport'), 'weekly state');
    assert.ok(reportsPage.includes('monthlyReport'), 'monthly state must be separate');
  });

  it('requests the selected period explicitly', () => {
    assert.ok(reportsPage.includes('/reports/daily?date='), 'daily must send its date');
    assert.ok(reportsPage.includes('/reports/weekly?date='), 'weekly must send its reference date');
    assert.ok(reportsPage.includes('/reports/monthly?year='), 'monthly must send year+month');
  });

  it('can reach a past month (October 2026 case)', () => {
    assert.ok(reportsPage.includes('shiftMonth'), 'needs month stepping');
    assert.ok(reportsPage.includes('type="month"'), 'needs a month picker');
  });

  it('distinguishes an error from an empty report', () => {
    assert.ok(reportsPage.includes('setError'), 'must surface failures');
    assert.ok(reportsPage.includes('reports.loadFailed'), 'must label the failure');
    assert.ok(reportsPage.includes('reports.emptyPeriod'), 'must label a genuinely empty period');
    assert.ok(reportsPage.includes('requestId'), 'must ignore stale responses');
  });

  it('uses stable chart keys so translating does not break the series', () => {
    assert.ok(reportsPage.includes('dataKey="count"'), 'events series must use a stable key');
    assert.ok(reportsPage.includes('dataKey="alerts"'), 'alerts series must use a stable key');
    assert.ok(
      !reportsPage.includes('dataKey={t("reports.chartEvents")}'),
      'translated strings must not be data keys',
    );
  });

  it('escapes CSV cells and blocks formula injection', () => {
    assert.ok(reportsPage.includes('csvCell'), 'must build CSV through an escaper');
    assert.ok(reportsPage.includes("^[=+\\-@"), 'must neutralise leading = + - @');
    assert.ok(reportsPage.includes('replace(/"/g'), 'must escape quotes');
  });
});

describe('i18n parity for the new keys', () => {
  it('keeps vi and en structurally identical for the touched sections', () => {
    for (const section of ['cameras', 'events', 'reports']) {
      assert.deepEqual(
        flatten(vi[section]).sort(),
        flatten(en[section]).sort(),
        `${section} differs between locales`,
      );
    }
  });

  it('has the activation, storage and period labels in both languages', () => {
    for (const key of [
      'cameras.colActive',
      'cameras.storageUnavailable',
      'cameras.resolutionUnknown',
      'events.dateAll',
      'events.dateToday',
      'reports.emptyPeriod',
      'reports.latestData',
    ]) {
      const [section, name] = key.split('.');
      assert.ok(vi[section][name], `vi missing ${key}`);
      assert.ok(en[section][name], `en missing ${key}`);
    }
  });
});

describe('timezone helpers', () => {
  it('uses the app timezone and Intl rather than a hardcoded offset', () => {
    assert.ok(datetimeLib.includes('Asia/Ho_Chi_Minh'), 'default timezone');
    assert.ok(datetimeLib.includes('Intl.DateTimeFormat'), 'must resolve dates via Intl');
    assert.ok(!datetimeLib.includes('getTimezoneOffset'), 'must not rely on the host offset');
  });
});
