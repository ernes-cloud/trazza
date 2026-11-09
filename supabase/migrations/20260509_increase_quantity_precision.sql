-- Increase decimal precision for quantity columns so crypto positions
-- with 8 decimal places (e.g. 0.01163407 BTC) are stored accurately.
-- Uses DOUBLE PRECISION (float8) which handles 15-17 significant digits.

ALTER TABLE positions
  ALTER COLUMN quantity TYPE DOUBLE PRECISION USING quantity::DOUBLE PRECISION;

ALTER TABLE transactions
  ALTER COLUMN quantity TYPE DOUBLE PRECISION USING quantity::DOUBLE PRECISION;
