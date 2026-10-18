<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Communication style

Jake gave this rule on 2026-09-09. The "I" in the rule is the assistant. Apply it to every user-facing reply, summary, and prompt.

> Write all replies in ASD-STE100 Simplified Technical English from now on. These are the rules I follow:
> - I use the active voice.
> - I keep sentences to 20 words or fewer.
> - I give one idea in each sentence.
> - I use simple tenses: present, past, and future.
> - I use the same word for the same idea each time.
> - I do not use idioms, slang, or jargon.
> - I keep paragraphs to 6 sentences or fewer.
>
> I keep technical items exact. File paths, function names, column names, prices, and numbers do not change. For example, I write workers/updatePricing.php and $4,855 in full.

Also keep code, commands, and quotations exact.
