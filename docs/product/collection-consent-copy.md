# Project collection disclosure v1

**Disclosure version:** `hosted-project-enable-v1`  
**Status:** frozen Phase 0 copy; UI layout review remains a Phase 2 gate

## CLI/dashboard copy

> Enable Baton Cloud for **{project_name}** on this device?
>
> Baton will continuously read supported AI-agent conversations created for this
> project and upload only the categories shown below. Baton Cloud can read and
> process this content to organize work, retrieve context, and provide features
> you request.
>
> Baton-managed model providers may process the minimum excerpts needed for
> summaries, retrieval, and memory candidates. Baton and its providers do not
> use your content to train shared models. Provider copies expire within 30
> days; Baton requests shorter or zero retention where available.
>
> Before upload, Baton excludes disallowed categories, applies the displayed
> size limits, and redacts detected credentials on this device. Secret detection
> reduces risk but cannot guarantee that every sensitive value will be found.
>
> Capture continues until you pause or disable it. Pausing or disabling stops
> new uploads but does not delete existing cloud data. You can inspect, export,
> or delete project data from Baton. Deleted content becomes unavailable from
> live systems within 1 hour, is removed from controlled primary and derived
> stores within 24 hours, and expires from encrypted backups within 35 days.
>
> Enabling new capture does not import older conversations. Historical import
> has a separate preview and confirmation.

The interface then lists every allowed category, excluded category, payload cap,
ignored-path rule, policy version, retention link, subprocessor link, and the
controls `Enable`, `Customize`, and `Cancel`. `Enable` is never preselected and
records the exact policy and disclosure digests.
