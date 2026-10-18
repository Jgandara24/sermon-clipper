---
status: accepted
date: 2026-10-17
---

# Pulpit Engine keeps one product database, on Railway

The first build of Pulpit Engine stored its data in Supabase. This code base, the second build, stores its data in PostgreSQL on Railway. On 2026-10-17 Jake decided the two are never merged: the Railway database is the only product database, and the first build's Supabase stays alive only as the church directory, a lead list for sales. Two databases for one product would mean two sources of truth for churches, sermons, clips, and posts.

## Consequences

- Nothing in this code base reads or writes the first build's Supabase, except a future one-way import of the church directory as leads, if ever wanted.
- The first build's Supabase can be shut down once the lead list is exported.
