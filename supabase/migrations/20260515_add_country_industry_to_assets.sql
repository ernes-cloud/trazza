-- Migration: add country and industry columns to assets table
-- These are enriched from Yahoo Finance getProfile() and used for
-- the Portfolio Distribution donut widget (Regions and Industries tabs).

ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS country  TEXT,
  ADD COLUMN IF NOT EXISTS industry TEXT;
