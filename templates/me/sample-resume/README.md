# sample-resume/

Put your current resume here, in one or more of these formats:

| Format | How intake reads it |
|---|---|
| `.pdf` | The `resume-intake` agent reads it directly with the Read tool's `pages` parameter (for example `pages: "1-3"`). No extraction step. |
| `.docx` | `jh me extract` unzips `word/document.xml` and writes the paragraph text to `.cache/text/<file>.docx.txt`. |
| `.md` / `.txt` | `jh me extract` copies the text to `.cache/text/<file>.md.txt`. |

The resume is **starting material, not the source of truth**. Intake takes employers, titles, dates, education and stated numbers from it. Your `experience/*.md` READMEs add the depth. When the resume and a README disagree on a fixed fact (a date or a title), `/intake` asks you once and saves the answer in that README's front matter.

`_example-sample-resume.md` is a fictional resume that shows the format intake handles best. Files starting with `_` are ignored. Delete it whenever you like.

Tips:

- Keep the original file. Do not hand-edit it to "fix" it for the agents; fix the README instead.
- Two versions (for example a 1-page and a 2-page) are fine. Intake merges them and flags disagreements.
- Scanned image-only PDFs have no text layer. Export a text PDF or a DOCX instead.
