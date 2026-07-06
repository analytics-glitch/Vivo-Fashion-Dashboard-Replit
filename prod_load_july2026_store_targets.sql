-- July 2026 per-store sales targets for PRODUCTION
-- Run against the production DATABASE_URL (agent cannot write to prod).
-- Mirrors load_targets.py JULY_2026_STORES (scope='store', source='manual', month=2026-07-01).
BEGIN;
INSERT INTO targets_monthly (scope, name, country, month, target_kes, source) VALUES
  ('store', 'Vivo Sarit', 'Kenya', DATE '2026-07-01', 9035000, 'manual'),
  ('store', 'Vivo Junction', 'Kenya', DATE '2026-07-01', 9035000, 'manual'),
  ('store', 'Vivo Mama Ngina St', 'Kenya', DATE '2026-07-01', 7440000, 'manual'),
  ('store', 'Vivo Moi Avenue', 'Kenya', DATE '2026-07-01', 6910000, 'manual'),
  ('store', 'Vivo Village Market', 'Kenya', DATE '2026-07-01', 6110000, 'manual'),
  ('store', 'Vivo Yaya', 'Kenya', DATE '2026-07-01', 6110000, 'manual'),
  ('store', 'Vivo Garden City', 'Kenya', DATE '2026-07-01', 4785000, 'manual'),
  ('store', 'Vivo Galleria', 'Kenya', DATE '2026-07-01', 4465000, 'manual'),
  ('store', 'Vivo Imaara', 'Kenya', DATE '2026-07-01', 4040000, 'manual'),
  ('store', 'Vivo Nakuru', 'Kenya', DATE '2026-07-01', 4040000, 'manual'),
  ('store', 'Vivo TRM', 'Kenya', DATE '2026-07-01', 3935000, 'manual'),
  ('store', 'Vivo Two Rivers', 'Kenya', DATE '2026-07-01', 3720000, 'manual'),
  ('store', 'Vivo Capital Centre', 'Kenya', DATE '2026-07-01', 3720000, 'manual'),
  ('store', 'Vivo Eldoret', 'Kenya', DATE '2026-07-01', 3615000, 'manual'),
  ('store', 'Vivo City Mall', 'Kenya', DATE '2026-07-01', 3510000, 'manual'),
  ('store', 'Vivo Hub', 'Kenya', DATE '2026-07-01', 3510000, 'manual'),
  ('store', 'Vivo Kisumu', 'Kenya', DATE '2026-07-01', 3510000, 'manual'),
  ('store', 'Vivo Runda', 'Kenya', DATE '2026-07-01', 3405000, 'manual'),
  ('store', 'Safari Sarit', 'Kenya', DATE '2026-07-01', 1595000, 'manual'),
  ('store', 'Zoya Sarit', 'Kenya', DATE '2026-07-01', 1595000, 'manual'),
  ('store', 'Vivo MSA Digo Road', 'Kenya', DATE '2026-07-01', 2925000, 'manual'),
  ('store', 'Vivo Signature Mall', 'Kenya', DATE '2026-07-01', 2660000, 'manual'),
  ('store', 'Vivo T- Mall', 'Kenya', DATE '2026-07-01', 2555000, 'manual'),
  ('store', 'Vivo Kileleshwa', 'Kenya', DATE '2026-07-01', 2445000, 'manual'),
  ('store', 'Vivo Meru', 'Kenya', DATE '2026-07-01', 2130000, 'manual'),
  ('store', 'Vivo Greenspan', 'Kenya', DATE '2026-07-01', 2130000, 'manual'),
  ('store', 'Vivo Kigali Heights', 'Rwanda', DATE '2026-07-01', 4680000, 'manual'),
  ('store', 'The Oasis Mall', 'Uganda', DATE '2026-07-01', 3550000, 'manual'),
  ('store', 'Vivo Acacia', 'Uganda', DATE '2026-07-01', 6100000, 'manual'),
  ('store', 'Online - Shop Zetu', 'Online', DATE '2026-07-01', 10000000, 'manual')
ON CONFLICT (scope, name, month, source) DO UPDATE SET
  target_kes = EXCLUDED.target_kes,
  country    = EXCLUDED.country;
-- Sanity check (expect 30 rows / 133,260,000):
SELECT COUNT(*) AS rows, SUM(target_kes) AS total_kes
  FROM targets_monthly
 WHERE scope='store' AND source='manual' AND month=DATE '2026-07-01';
COMMIT;
