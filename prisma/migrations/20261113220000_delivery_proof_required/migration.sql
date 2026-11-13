-- P10-T03: proof requirement is snapshotted per delivery. Existing rows keep
-- false so legacy trips complete as before; new deliveries take the configured
-- value when they are created.
ALTER TABLE "deliveries" ADD COLUMN "proof_required" BOOLEAN NOT NULL DEFAULT false;
