# @baton/adapters

Incremental, read-only adapters for supported native agent conversation formats.
Adapters emit normalized semantic records and never expose a complete native
payload to an upload DTO.

Phase 0 intentionally reparses a bounded current snapshot on every read. The
cursor proves whether the new semantic state extends the acknowledged prefix;
rewrites switch the batch to `replace` reconciliation. Phase 2 can optimize
physical reads without changing this contract.
