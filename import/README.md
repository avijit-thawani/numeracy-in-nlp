# Everything you feed the survey lives here

**[`papers.txt`](papers.txt)** is the seed list. One paper per line: a link, a
bare DOI or arXiv id, or just the paper's title. Prefix a line with `refs:` to
pull in everything that paper cites.

**`.bib` and `.ris` files** dropped in this folder are read too. That is the
export button in Zotero, Mendeley, EndNote, Google Scholar and most journal
sites, so an existing library comes over in one drag and drop. Entries are
matched by DOI, then arXiv id, then URL, and finally by title for entries that
carry no identifier at all.

Anything that cannot be matched is reported in the run log and left in
`papers.txt` rather than dropped silently. Leave bibliography files here after
importing; they are a record of what came from where, and re-running never adds
anything twice.
