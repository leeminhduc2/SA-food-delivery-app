# Assignment automation rollout

This runbook describes the P05 cutover. It does not apply migrations or change a deployed environment.

1. Stop or drain every old instance that can accept order transitions. Do not run mixed instances with automation disabled and enabled during bootstrap: an old instance could accept an order after the new instance has scanned it.
2. Back up and preflight the target database according to the deployment procedure. Resolve legacy duplicate active-driver assignments before applying migrations. Apply the pending Prisma migrations, including `20261113030000_operational_invalidation` and `20261113031000_admin_override_receipt`, through the normal release process.
3. Deploy the new application with `ASSIGNMENT_AUTOMATION_ENABLED=true` (the default). Before serving HTTP traffic, each instance runs the idempotent bootstrap: only accepted, preparing or ready orders with unassigned deliveries and no previous search receive a search. Existing active assignments are retained and receive a durable operational check. Concurrent starts and repeat bootstraps are safe.
4. Bring traffic back after startup completes. Monitor the Admin assignment list, exhausted searches, failure/operational incidents and notification outbox; verify workers drain pending searches and operational changes. Never manufacture GPS or heartbeat data to make a driver eligible.
5. To pause automation, drain traffic and restart all instances with `ASSIGNMENT_AUTOMATION_ENABLED=false`. Pending searches and operational work remain durable; manual override still requires an exception, reason, idempotency key and a fully eligible driver. Restart with true and rerun bootstrap before restoring traffic. Do not remove assignment, receipt, incident or audit data as a rollback shortcut.

The bootstrap and migrations were rehearsed only on disposable test schemas; deployment to an application database requires the normal release process.
