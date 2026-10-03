# Restore Drill

Scheduled proof that backups actually restore.

A small Docker agent restores the latest backup into a throwaway container, runs checks from YAML (row counts, freshness), records restore time, destroys the container, and reports pass/fail. Data never leaves your infra. Monthly evidence report for SOC 2 / ISO 27001.

MVP: Postgres, S3-compatible storage, row-count + freshness checks, email alerts. Dogfooded on the HetOps Coolify stack first.
