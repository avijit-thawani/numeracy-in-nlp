# Setting up your own living survey

A living survey is a GitHub repo whose README *is* the survey: a table of the papers you have read, plus a ✨ regularly refreshed list of papers you probably should read next.

**It is your repo and nothing else.** No website to deploy, no server, no database, no account, no API keys. Your papers and every file derived from them (`data/`, `views/`, the README itself) are committed to the repo you own, and a GitHub Action running in your own Actions minutes rewrites them in place. The only thing that leaves is a lookup of each paper's public metadata from Semantic Scholar and OpenAlex; delete the repo and nothing of yours survives anywhere.

**No LLM is involved in the recommendations.** Recs are computed by a citation graph algorithm — `lib/recommend.js`, scored in `lib/score.js`, with every knob exposed in `survey.config.json`. It is deterministic: the same survey produces the same list, every row states exactly why it is there (`cites 4 in Core`), and if you dislike the ranking you can change the rule rather than reword a prompt. Nothing here calls a model at all: the one-line summary under each title is Semantic Scholar's own `tldr` field, fetched like the rest of the metadata.

Setup is two steps.

## 1. Click "Use this template"

Use the green **Use this template** button → **Create a new repository**.

Whatever you name the repo becomes your survey's title, and the repo description becomes its subtitle. `numeracy-in-nlp` with the description "Papers on how language models handle numbers" gives you a page headed **Numeracy in NLP** with that line underneath. Nothing else to fill in.

> **Use the template button, not Fork.** They look similar and behave differently: GitHub disables scheduled workflows on forks by default, so a fork will never refresh itself.

Make the repo **public**. GitHub Actions is free and unlimited on public repos, so a public survey costs nothing to run forever. (Private works too, but it consumes your account's monthly Actions minutes.)

You do not need to delete the demo papers this template ships with. Your new repo clears them automatically on its first run, before you touch anything.

## 2. Seed it

Four ways to seed a survey. They all work, you can mix them, and each one
triggers a rebuild as soon as you commit.

### Start from a profile

The fastest start, and the one most people want: name a person, and everything
they have published becomes Core. Put one line in
[`import/papers.txt`](import/papers.txt):

```
author: https://www.semanticscholar.org/author/Niyati-Bafna/2090730520
author: https://openalex.org/A5023888391
author: https://orcid.org/0000-0002-1825-0097
author: Niyati Bafna
```

Any of those four forms works — a Semantic Scholar author page, an OpenAlex
author id, an ORCID, or just the name. A name is searched for, and if several
profiles match, the run takes the one with the most papers and writes the
runners-up into the log, so a wrong pick is visible and you can replace the
line with the profile URL.

> **Google Scholar profiles do not work**, and cannot: there is no public API,
> and the URL carries an opaque user id rather than the person's name, so there
> is nothing to fall back on. Use one of the other three, or the name.

Point it at yourself to get a reading list built around your own work, or at
someone whose work you are trying to catch up on. Either way it keeps working:
the profile is followed rather than imported once, so when they publish, the
daily run adds the paper and the suggestions move with it. Followed profiles
are recorded in `data/authors.json`.

Papers by that author are Core, and everything those papers cite feeds the
backward half of the ranking, so the foundations of their field surface as Recs
without a separate import. If you want their *whole* bibliography listed rather
than ranked, add a `refs:` line for the specific paper.

### The other three

**Paste links, DOIs or titles.** Open [`import/papers.txt`](import/papers.txt) and put one paper per line:

```
https://arxiv.org/abs/2103.03874
https://aclanthology.org/2020.acl-main.463
10.18653/v1/N18-2074
```

arXiv, ACL Anthology, ACM, bioRxiv, OpenReview, PubMed, doi.org and Semantic
Scholar links all work, as do bare DOIs, bare arXiv ids, and a paper's plain
title if you do not have a link to hand. Lines starting with `#` are ignored.

**Drop in a bibliography.** Put a `.bib` or `.ris` file in [`import/`](import/).
That is the export button in Zotero, Mendeley, EndNote, Google Scholar and most
journal sites, so an existing library comes over in one drag and drop. Entries
are matched by DOI, then arXiv id, then URL, then by title for entries that
carry no identifier at all.

**Expand from a single paper.** Put `refs:` in front of a link:

```
refs: https://arxiv.org/abs/2103.13136
```

Everything that paper cites becomes a Rec. Useful in several directions: point
it at a survey to adopt a ready-made reading list for the topic, at your own
thesis or preprint to lay out what it rests on, or at a draft before you submit
to catch related work you have missed. One line seeds as many papers as that
one cites, which for a survey is usually dozens — the example above contributes
65. The popularity penalty strips the generic references, so you get the topical
ones rather than Adam and BERT.

These arrive as Recs rather than Core, because the curation was the cited
paper's author's and not yours. Promote the ones you want by copying their links
into `import/papers.txt`.

Within a minute or two a bot commit rewrites `README.md` with your table.

**Three papers is usually enough to get Recs.** A paper is suggested once it
connects to at least two of yours, so the real threshold is two papers with
something in common rather than any particular count. On the demo survey three
seeds already produce sixteen candidates, and eleven produce over two hundred.
Two papers that cite nothing in common produce none, and a single paper cannot
produce any; if you are stuck there, either add another paper or set
`algorithm.minCount` to `1`.

That is it. You are done.

## 3. It runs itself

| When | What happens |
| --- | --- |
| You edit `import/papers.txt` | New papers are looked up and added |
| Someone opens an **Add a paper** issue | The bot ingests the links, replies, and closes the issue |
| Every day | Citation counts refresh and suggestions are recomputed |
| You click **Run workflow** in the Actions tab | Same as the daily run, on demand |

## 4. Grow it from Recs

Every row in the Recs table carries a **Decide** link. `add` and `drop` open a
prefilled issue that the bot acts on and closes. Where a pull request is
waiting, `review` opens it, and accepting the paper is a merge while rejecting
it is a close. Nothing needs editing by hand.

The longhand equivalents, if you prefer them:

| To | Do this |
| --- | --- |
| Add more papers | More lines in `import/papers.txt`, or another `.bib` in `import/`. Both are re-read every run and nothing is added twice. |
| Promote a Rec into Core | Copy its link into `import/papers.txt` and commit. It leaves Recs on the next run. |
| Reject a Rec for good | Add its id to `data/dismissed.json`. |
| Edit by hand or with an agent | Core is `data/core.json`, Recs is `data/recs.json`. Everything else is generated from those and will be overwritten. |

## More than one survey in one repo

A survey is a *directory*, not a repository. Put a `survey.config.json` in a
folder and it becomes one, with its own `import/`, `data/`, `views/` and
README:

```
my-surveys/
  README.md            an index, if you want one
  demos/dean/survey.config.json
  demos/bengio/survey.config.json
```

Nothing to configure: if any survey is nested, the repo root stops being one
and the single daily Action builds each in turn. This is how the template repo
holds its four demos. The tradeoffs, so you can choose knowingly:

- **One Action, one queue.** Surveys are built one after another, not at once,
  because the metadata API throttles hard under any concurrency. Four small
  surveys take about as long as one survey four times the size.
- **One issue tracker.** The Decide links write a `survey: demos/dean` line
  into the issue so a request reaches the right survey. A request typed by hand
  without that line is ignored rather than guessed at.
- **A repo-level index.** Put `<!-- SURVEYS:START -->` and `<!-- SURVEYS:END -->`
  in the root README and each run rewrites the list of surveys and their counts
  between them. Leave them out and your front page is left alone.

One survey at the root is still the default and still works exactly as before.

## The two lists, and the Score

**Core** is what the survey contains. **Recs** is what to read next. Those names
are used throughout: `data/core.json`, `data/recs.json`, `views/core-by-*.md`.

Both carry a **Score** from 0 to 100 for how tied into the survey a paper is,
measured against the most connected paper in its own list. A Core paper scores
on how many other Core papers cite it or it cites, so 0 means nothing else here
connects to it, which usually flags an outlier. Score is the default sort.

**Recent work gets the top slots.** A paper published last month has had no
time to be cited, so on score alone it would sit below everything established —
backwards, if what you want is to know what has appeared lately. The top of the
Recs list is therefore reserved: the best 10 from the past month, then the best
10 from the past six months, then everything else by score. The windows do not
overlap, they are filled by the same Score as the rest, and a window with
nothing in it gives its slots back. Rows that took a reserved slot say so in
the Why column (`past month · cites 3 in Core`). Turn it off or resize it with
`algorithm.freshness`.

Recs come from two directions through the citation graph:

- **`cites N in Core`**: newer work that builds on N of your papers.
- **`cited by N in Core`**: older work that N of your papers rest on. The forward
  pass can never find these, since they predate your papers.
- **`from ...`**: the bibliography of a paper you seeded with `refs:`.

The backward direction is divided by `citationCount ^ popularityPenalty`, the
same idea as the IDF term in TF-IDF. Without it the list fills with the field's
plumbing, since every NLP paper cites Adam and BERT and neither says anything
about your topic.

## Sorting

GitHub renders markdown but runs no JavaScript, so a table cannot be sorted in
the browser. Every sort order is written ahead of time to its own file under
[`views/`](views/), and each column heading links to the file sorted that way.
The active column is marked rather than linked. The README shows the top rows of
each list and links to the rest.

## Settings

All of these have working defaults; change them only if you want to.

`survey.config.json`:

| Key | What it does |
| --- | --- |
| `title`, `description` | Leave empty to use the repo name and description. |
| `contactEmail` | Optional, sent only to OpenAlex for their faster pool. Empty means the bot tries your public GitHub email and skips it if you have none. |
| `candidateCount` | How many Recs to keep. |
| `previewRows` | Rows shown per table on the README. Default 5; the full lists live in `views/`. |
| `algorithm.forward` / `.backward` | Turn either direction off. |
| `algorithm.minCount` | How many of your papers something must connect to before it is suggested. Default 2. Set it to 1 for a survey too small to produce any. |
| `algorithm.popularityPenalty` | Higher favours obscure papers, lower favours famous ones. Default 0.2. |
| `algorithm.freshness.enabled` | Reserve the top of Recs for recent work. Default on. |
| `algorithm.freshness.windows` | The reserved slots, as `{ days, count, label }`. Default: 10 from the past 30 days, then 10 from the past 180. |
| `algorithm.freshness.pool` | How many ranked candidates to fetch dates for, since a paper cut before that is never considered for a window. Default 400. |
| `algorithm.graphBudget` | How many papers' citations to refresh per run. Default 150, which bounds the cost for a large survey. |
| `algorithm.graphMaxAgeDays` | How stale a *recent* paper's citation data may get. Default 7. |
| `algorithm.graphAgeAware` | Let older papers go staler than that, since their citation lists barely move: the allowance is `graphMaxAgeDays` × the paper's age in years, capped at 12×. Default on. Turn it off for a uniform weekly refresh. |
| `recPullRequests.enabled` | Open a pull request per Rec, so accepting is a merge and rejecting a close. Needs *Allow GitHub Actions to create and approve pull requests* in Settings. |
| `recPullRequests.count` | How many may sit open at once. `"all"` gives every Rec one, turning the pull request list into your whole triage queue. Default 3. |
| `recPullRequests.maxPerRun` | Cap on how many to open in a single run, so a large survey fills the queue over a few runs instead of firing dozens of notifications at once. Default 20. |

Elsewhere:

- **How often it runs**: the `cron` line in `.github/workflows/update.yml`.
- **Never suggest a paper again**: add its id to `data/dismissed.json`.
- **The ranking itself**: `lib/recommend.js`, with scoring in `lib/score.js`.

**Writing your own prose.** Everything between `<!-- SURVEY:END -->` and the
footer is yours and is never overwritten. Only the region between
`<!-- SURVEY:START -->` and `<!-- SURVEY:END -->` is regenerated, so leave those
two comments alone.

## Files

| File | What it is |
| --- | --- |
| `README.md` | The survey. Generated between the markers. |
| `import/papers.txt` | Your input queue. Anything unrecognised stays behind so you can fix it. |
| `data/authors.json` | Profiles from `author:` lines, re-checked every run so new work arrives on its own. |
| `import/` | Drop `.bib` / `.ris` files here to bulk-import. |
| `survey.config.json` | Optional overrides. |
| `data/core.json` | Core: the papers in the survey, with full metadata. The source of truth. |
| `data/recs.json` | Recs: the current suggestions. |
| `data/core.csv` | Spreadsheet export of Core. |
| `views/` | The same two lists rendered in every sort order, one file each. |
| `data/seeded.json` | Suggestions pulled from a `refs:` bibliography, pending your review. |
| `data/dismissed.json` | Paper ids to never suggest again (create it yourself). |

## When something goes wrong

Open the **Actions** tab and look at the most recent run. Every run writes a summary of what it added, what it suggested, and any warnings.

- **A link stayed in `import/papers.txt`.** It could not be identified, or neither database knows it. Try another link for the same paper, ideally arXiv or DOI.
- **Warnings about HTTP 429.** Semantic Scholar's free tier is shared by everyone and throttles in bursts. The run retries with backoff, falls back to OpenAlex, and retries anything still missing next time. Normal and self-correcting.
- **No suggestions.** Expected while nothing outside the survey connects to two
  of your papers, which in practice means one or two seeds. Add another, or set
  `algorithm.minCount` to `1`.
- **The daily refresh stopped.** GitHub disables cron in public repos after 60 days of no repository activity. The bot's own commits normally prevent this; if the survey has been completely static, re-enable the workflow in the Actions tab.

## Credits

Based on [EshaanAgg/Research-Literature-Manager](https://github.com/EshaanAgg/Research-Literature-Manager) by Eshaan Aggarwal and Avijit Thawani, which pioneered the idea of a template-driven living survey. Metadata comes from the [Semantic Scholar Academic Graph API](https://www.semanticscholar.org/product/api) and [OpenAlex](https://openalex.org/).

```bibtex
@online{AggarwalThawani:2023,
  author = {Aggarwal, Eshaan and Thawani, Avijit},
  title  = {Research Literature Manager},
  year   = {2023},
  url    = {https://github.com/EshaanAgg/Research-Literature-Manager},
}
```
