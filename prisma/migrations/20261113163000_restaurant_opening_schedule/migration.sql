-- Legacy opening_hours text remains display-only; NULL keeps existing behavior.
ALTER TABLE "restaurants" ADD COLUMN "opening_schedule" JSONB;
