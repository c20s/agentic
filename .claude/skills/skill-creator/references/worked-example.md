# Example: cleaning up a skill

## Before

```markdown
---
name: pdf-helper
description: Helps with PDF files
---

## Extracting text

PDF (Portable Document Format) files are a common format for documents.
To extract text, you need a library. There are many options, but pdfplumber
is a good choice because it's well-maintained and handles most cases.
See [extraction guide](references/extraction.md) for details.

## Naming rule

The skill name must be lowercase. [details](references/naming.md)
```

What's wrong with this:

- The description doesn't say when to use the skill.
- The extraction section explains things Claude already knows (what a PDF is), then sends the one useful fact — use pdfplumber — to a separate file for no reason.
- The naming rule is one short sentence. It doesn't need its own file.

## After

```markdown
---
name: processing-pdfs
description: Extracts text and tables from PDF files, fills forms, merges documents. Use when working with PDF files, forms, or document extraction.
---

## Extracting text

Use pdfplumber:

\`\`\`python
import pdfplumber
with pdfplumber.open("file.pdf") as pdf:
    text = pdf.pages[0].extract_text()
\`\`\`

## Naming

- Use lowercase letters, numbers, and hyphens only.

## Forms

- Filling a PDF form has several steps and things that can go wrong. See [filling forms](references/forms.md).
```

What changed:

- The description says what it does and when to use it.
- The extraction bullet is just the code. No background explanation.
- The naming rule is a plain bullet — short and always true.
- Only the forms section links out, because filling a form is genuinely long, and most tasks won't need it.
