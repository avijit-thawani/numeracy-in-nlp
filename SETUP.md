# Setting up your own living survey

A living survey is a GitHub repo whose README *is* the survey: a table of the papers you have read, plus a regularly refreshed list of papers you probably should read next. There is no website to deploy, no server, and no API keys.

## 1. Create your repo

Click **Use this template** → **Create a new repository** at the top of the template repo.

> **Use the template button, not Fork.** They look similar and behave differently: GitHub disables scheduled workflows on forks by default, so a fork will never refresh itself. Template-created repos run workflows straight away.

Make the repo **public**. GitHub Actions is free and unlimited on public repos, so a public survey costs nothing to run forever. (It works in a private repo too, but then it consumes your account's monthly Actions minutes.)

The template ships with a small demo survey so its own page shows something real. **You do not need to delete it** — your new repo clears the demo papers and resets the title automatically on its first run.

## 2. Name your survey

Edit [`survey.config.json`](survey.config.json):

```json
{
  "title": "Numeracy in NLP",
  "description": "Papers on how language models represent and reason about numbers.",
  "contactEmail": "you@university.edu",
  "candidateCount": 25,
  "sortBy": "year"
}
```

- `contactEmail` is optional. It is sent to OpenAlex only, which puts your requests in their faster "polite pool". It is never sent anywhere else.
- `sortBy` accepts `year`, `citations`, `title`, or `added`.

## 3. Add your seed papers

Edit [`papers.txt`](papers.txt) and paste one paper per line:

```
https://arxiv.org/abs/2103.03874
https://aclanthology.org/2020.acl-main.463
10.18653/v1/N18-2074
```

arXiv, ACL Anthology, ACM, bioRxiv, OpenReview, PubMed, doi.org and Semantic Scholar links all work, as do bare DOIs and bare arXiv ids. Lines starting with `#` are ignored.

Commit the file. Within a minute or two a bot commit rewrites `README.md` with your table. Aim for at least ten seed papers: suggestions are based on papers that cite *several* of yours, so a handful of seeds produces few or no suggestions.

## 4. That's it

From then on the survey maintains itself:

| When | What happens |
| --- | --- |
| You edit `papers.txt` | New papers are looked up and added |
| Someone opens an **Add a paper** issue | The bot ingests the links, replies, and closes the issue |
| Every Monday | Citation counts refresh and suggestions are recomputed |
| You click **Run workflow** in the Actions tab | Same as the weekly run, on demand |

To act on a suggestion, copy its link into `papers.txt` and commit.

## Writing your own prose

Everything between the `<!-- SURVEY:END -->` marker and the footer is yours and is never overwritten. Put your scope notes, open questions, or a call for contributions there. Only the region between `<!-- SURVEY:START -->` and `<!-- SURVEY:END -->` is regenerated, so leave those two comments alone.

## Files

| File | What it is |
| --- | --- |
| `README.md` | The survey. Generated between the markers. |
| `papers.txt` | Your input queue. Links you add; anything unrecognised stays behind. |
| `survey.config.json` | Title, description, settings. |
| `data/papers.json` | The papers, with full metadata. The real source of truth. |
| `data/candidates.json` | The current suggestions. |
| `data/papers.csv` | Spreadsheet export. |
| `data/dismissed.json` | Paper ids to never suggest again (optional; create it yourself). |

## When something goes wrong

Open the **Actions** tab and look at the most recent run. Every run writes a summary showing how many papers were added, how many suggestions were produced, and any warnings.

- **A link stayed in `papers.txt`.** It could not be identified or neither database knows it. Try a different link for the same paper, ideally an arXiv or DOI one.
- **Warnings about HTTP 429.** Semantic Scholar's free tier is shared by everyone and throttles in bursts. The run retries with backoff, then falls back to OpenAlex; anything still missing is retried next run. This is normal and self-correcting.
- **No suggestions.** Expected until you have enough seed papers for several of them to share a citing paper.
- **The weekly refresh stopped.** GitHub disables cron in public repos after 60 days of no repository activity. Normally the bot's own commits prevent this, but if the survey has been completely static, open the Actions tab and re-enable the workflow.

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
