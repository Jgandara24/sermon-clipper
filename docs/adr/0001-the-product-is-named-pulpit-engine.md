---
status: accepted
date: 2026-10-17
---

# The product is named Pulpit Engine; this code base is its second build

Jake built a first version of Pulpit Engine (the `pulpit-engine` folder next to this one), did not like how it worked, and started this code base as a rebuild under the working name "Sermon Clipper". On 2026-10-17 he decided the final product is Pulpit Engine, not Sermon Clipper. This code base is the product. "Sermon Clipper" is retired as a name and must be replaced in the app, titles, emails, code, and documents.

## Consequences

- The first build's live pieces carry over to the product where they are useful: the name, the domain pulpitengine.com, the Meta App and Business Manager, the shared Cloudflare account (Stream and PERC), and the church directory as a lead list. Its application code does not.
- Internal names that other systems depend on (the GitHub repository name, the Railway project and service names, the package name, the production URL) change later and carefully, because deploys and links depend on them.
- Until the repository is renamed, a reader will see `sermon-clipper` in paths and "Pulpit Engine" in the app. This ADR explains why.
