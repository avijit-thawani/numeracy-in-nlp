# Setting up your own living survey

A living survey is a GitHub repo whose README *is* the survey: a table of the papers you have read, plus a ✨ regularly refreshed list of papers you probably should read next. There is no website to deploy, no server, and no API keys.

Setup is two steps.

## 1. Click "Use this template"

Use the green **Use this template** button → **Create a new repository**.

Whatever you name the repo becomes your survey's title, and the repo description becomes its subtitle. `numeracy-in-nlp` with the description "Papers on how language models handle numbers" gives you a page headed **Numeracy in NLP** with that line underneath. Nothing else to fill in.

> **Use the template button, not Fork.** They look similar and behave differently: GitHub disables scheduled workflows on forks by default, so a fork will never refresh itself.

Make the repo **public**. GitHub Actions is free and unlimited on public repos, so a public survey costs nothing to run forever. (Private works too, but it consumes your account's monthly Actions minutes.)

You do not need to delete the demo papers this template ships with. Your new repo clears them automatically on its first run, before you touch anything.

## 2. Overwrite `papers.txt`

Open [`papers.txt`](papers.txt) in the GitHub editor, replace whatever is there with your own papers, one per line, and commit:

```
https://arxiv.org/abs/2103.03874
https://aclanthology.org/2020.acl-main.463
10.18653/v1/N18-2074
```

arXiv, ACL Anthology, ACM, bioRxiv, OpenReview, PubMed, doi.org and Semantic Scholar links all work, as do bare DOIs and bare arXiv ids. Lines starting with `#` are ignored.

Within a minute or two a bot commit rewrites `README.md` with your table. **Aim for at least ten papers**: suggestions come from papers that cite *several* of yours, so a handful of seeds produces few or none.

That's it. You're done.

## After that, it runs itself

| When | What happens |
| --- | --- |
| You edit `papers.txt` | New papers are looked up and added |
| Someone opens an **Add a paper** issue | The bot ingests the links, replies, and closes the issue |
| Every Monday | Citation counts refresh and suggestions are recomputed |
| You click **Run workflow** in the Actions tab | Same as the weekly run, on demand |

To act on a suggestion, copy its link into `papers.txt` and commit.

## Optional tweaks

Everything here has a sensible default; skip this section unless something bothers you.

`survey.config.json` overrides what is otherwise derived automatically:

```json
{
  "title": "",
  "description": "",
  "contactEmail": "",
  "candidateCount": 25,
  "sortBy": "year"
}
```

- `title` / `description` — leave empty to use the repo name and description. Set them to override.
- `contactEmail` — optional, sent only to OpenAlex to use their faster "polite pool". Left empty, the bot tries your public GitHub email and quietly skips it if you have none.
- `candidateCount` — how many suggestions to show.
- `sortBy` — `year`, `citations`, `title`, or `added`.

**Writing your own prose.** Everything between `<!-- SURVEY:END -->` and the footer is yours and is never overwritten — scope notes, open questions, a call for contributions. Only the region between `<!-- SURVEY:START -->` and `<!-- SURVEY:END -->` is regenerated, so leave those two comments alone.

## Files

| File | What it is |
| --- | --- |
| `README.md` | The survey. Generated between the markers. |
| `papers.txt` | Your input queue. Anything unrecognised stays behind so you can fix it. |
| `survey.config.json` | Optional overrides. |
| `data/papers.json` | The papers, with full metadata. The real source of truth. |
| `data/candidates.json` | The current suggestions. |
| `data/papers.csv` | Spreadsheet export. |
| `data/dismissed.json` | Paper ids to never suggest again (create it yourself). |

## When something goes wrong

Open the **Actions** tab and look at the most recent run. Every run writes a summary of what it added, what it suggested, and any warnings.

- **A link stayed in `papers.txt`.** It could not be identified, or neither database knows it. Try another link for the same paper, ideally arXiv or DOI.
- **Warnings about HTTP 429.** Semantic Scholar's free tier is shared by everyone and throttles in bursts. The run retries with backoff, falls back to OpenAlex, and retries anything still missing next time. Normal and self-correcting.
- **No suggestions.** Expected until you have roughly ten papers.
- **The weekly refresh stopped.** GitHub disables cron in public repos after 60 days of no repository activity. The bot's own commits normally prevent this; if the survey has been completely static, re-enable the workflow in the Actions tab.

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
