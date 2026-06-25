-- Vivo BI: load 2026 leadership budget into PRODUCTION targets_monthly
-- 48 rows (scope=region, source=budget, FY2026)
-- Idempotent: clears existing 2026 region/budget rows first, then inserts.
BEGIN;

DELETE FROM targets_monthly
WHERE scope='region' AND source='budget'
  AND EXTRACT(YEAR FROM month)=2026;

INSERT INTO targets_monthly (scope, name, country, month, target_kes, source, updated_at) VALUES
  ('region', 'Kenya - Online', 'Online', '2026-01-01'::date, 8489250, 'budget', now()),
  ('region', 'Kenya - Online', 'Online', '2026-02-01'::date, 6755948, 'budget', now()),
  ('region', 'Kenya - Online', 'Online', '2026-03-01'::date, 8327702, 'budget', now()),
  ('region', 'Kenya - Online', 'Online', '2026-04-01'::date, 8005285, 'budget', now()),
  ('region', 'Kenya - Online', 'Online', '2026-05-01'::date, 7846801, 'budget', now()),
  ('region', 'Kenya - Online', 'Online', '2026-06-01'::date, 8825976, 'budget', now()),
  ('region', 'Kenya - Online', 'Online', '2026-07-01'::date, 7994360, 'budget', now()),
  ('region', 'Kenya - Online', 'Online', '2026-08-01'::date, 7559754, 'budget', now()),
  ('region', 'Kenya - Online', 'Online', '2026-09-01'::date, 8165494, 'budget', now()),
  ('region', 'Kenya - Online', 'Online', '2026-10-01'::date, 7415181, 'budget', now()),
  ('region', 'Kenya - Online', 'Online', '2026-11-01'::date, 13352515, 'budget', now()),
  ('region', 'Kenya - Online', 'Online', '2026-12-01'::date, 6784859, 'budget', now()),
  ('region', 'Kenya - Retail', 'Kenya', '2026-01-01'::date, 73551760, 'budget', now()),
  ('region', 'Kenya - Retail', 'Kenya', '2026-02-01'::date, 78561699, 'budget', now()),
  ('region', 'Kenya - Retail', 'Kenya', '2026-03-01'::date, 83569811, 'budget', now()),
  ('region', 'Kenya - Retail', 'Kenya', '2026-04-01'::date, 90859769, 'budget', now()),
  ('region', 'Kenya - Retail', 'Kenya', '2026-05-01'::date, 90884418, 'budget', now()),
  ('region', 'Kenya - Retail', 'Kenya', '2026-06-01'::date, 86816048, 'budget', now()),
  ('region', 'Kenya - Retail', 'Kenya', '2026-07-01'::date, 106253533, 'budget', now()),
  ('region', 'Kenya - Retail', 'Kenya', '2026-08-01'::date, 112010104, 'budget', now()),
  ('region', 'Kenya - Retail', 'Kenya', '2026-09-01'::date, 93144307, 'budget', now()),
  ('region', 'Kenya - Retail', 'Kenya', '2026-10-01'::date, 98271941, 'budget', now()),
  ('region', 'Kenya - Retail', 'Kenya', '2026-11-01'::date, 119117293, 'budget', now()),
  ('region', 'Kenya - Retail', 'Kenya', '2026-12-01'::date, 127195778, 'budget', now()),
  ('region', 'Rwanda', 'Rwanda', '2026-01-01'::date, 3557665, 'budget', now()),
  ('region', 'Rwanda', 'Rwanda', '2026-02-01'::date, 2630475, 'budget', now()),
  ('region', 'Rwanda', 'Rwanda', '2026-03-01'::date, 3592741, 'budget', now()),
  ('region', 'Rwanda', 'Rwanda', '2026-04-01'::date, 2489631, 'budget', now()),
  ('region', 'Rwanda', 'Rwanda', '2026-05-01'::date, 5063588, 'budget', now()),
  ('region', 'Rwanda', 'Rwanda', '2026-06-01'::date, 4221746, 'budget', now()),
  ('region', 'Rwanda', 'Rwanda', '2026-07-01'::date, 3871062, 'budget', now()),
  ('region', 'Rwanda', 'Rwanda', '2026-08-01'::date, 3839509, 'budget', now()),
  ('region', 'Rwanda', 'Rwanda', '2026-09-01'::date, 2832688, 'budget', now()),
  ('region', 'Rwanda', 'Rwanda', '2026-10-01'::date, 5690753, 'budget', now()),
  ('region', 'Rwanda', 'Rwanda', '2026-11-01'::date, 7614199, 'budget', now()),
  ('region', 'Rwanda', 'Rwanda', '2026-12-01'::date, 6394225, 'budget', now()),
  ('region', 'Uganda', 'Uganda', '2026-01-01'::date, 8464809, 'budget', now()),
  ('region', 'Uganda', 'Uganda', '2026-02-01'::date, 9170957, 'budget', now()),
  ('region', 'Uganda', 'Uganda', '2026-03-01'::date, 9268631, 'budget', now()),
  ('region', 'Uganda', 'Uganda', '2026-04-01'::date, 9175791, 'budget', now()),
  ('region', 'Uganda', 'Uganda', '2026-05-01'::date, 9573757, 'budget', now()),
  ('region', 'Uganda', 'Uganda', '2026-06-01'::date, 9503715, 'budget', now()),
  ('region', 'Uganda', 'Uganda', '2026-07-01'::date, 9608765, 'budget', now()),
  ('region', 'Uganda', 'Uganda', '2026-08-01'::date, 10105378, 'budget', now()),
  ('region', 'Uganda', 'Uganda', '2026-09-01'::date, 9261594, 'budget', now()),
  ('region', 'Uganda', 'Uganda', '2026-10-01'::date, 12420238, 'budget', now()),
  ('region', 'Uganda', 'Uganda', '2026-11-01'::date, 13205085, 'budget', now()),
  ('region', 'Uganda', 'Uganda', '2026-12-01'::date, 13205085, 'budget', now());

COMMIT;

-- Verify after running:
-- SELECT name, SUM(target_kes) AS annual
-- FROM targets_monthly
-- WHERE scope='region' AND source='budget' AND EXTRACT(YEAR FROM month)=2026
-- GROUP BY name ORDER BY name;
-- Expected: Kenya - Online 99,523,125 | Kenya - Retail 1,160,236,461 | Rwanda 51,798,282 | Uganda 122,963,805
