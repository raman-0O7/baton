# @baton/scrubber

The mandatory local privacy boundary for Baton Cloud uploads. It ports the
legacy Go pattern and entropy detectors and is the only package that can create
a `ScrubbedIngestionBatch` accepted by an upload client.

Redaction happens before canonical event hashes and idempotency identities are
created, so integrity always describes the exact content sent to Baton Cloud.
