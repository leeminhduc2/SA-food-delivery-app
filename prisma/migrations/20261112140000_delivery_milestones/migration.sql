ALTER TABLE deliveries
  ADD COLUMN arrived_at timestamptz,
  ADD COLUMN picked_up_at timestamptz,
  ADD COLUMN in_transit_at timestamptz,
  ADD COLUMN delivered_at timestamptz,
  ADD COLUMN failed_at timestamptz;
