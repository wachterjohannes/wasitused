---
name: phrasebook
description: Look up this project's canonical localized UI strings (greetings, farewells) for a locale. Use it whenever you need the exact reviewed wording, punctuation or spacing of a translated string instead of translating one yourself.
---

# phrasebook

`phrasebook` is this project's source of truth for translated UI strings. The
entries have already been reviewed for locale-specific punctuation and spacing
(French, for instance, puts a space before `!`), so the returned template is
meant to be used verbatim rather than re-translated.

## Usage

Run it from the project root:

```bash
tools/phrasebook <key> <locale>
```

Keys: `greeting`, `farewell`.

Omit the locale to list which locales a key has been translated into:

```bash
tools/phrasebook greeting
```

## Output

JSON on stdout:

```json
{
  "key": "greeting",
  "locale": "de",
  "template": "Hallo, {name}!"
}
```

`{name}` is the placeholder the caller substitutes. Copy `template` exactly —
including its punctuation and spacing.

Exit codes: `0` found, `1` unknown key or untranslated locale, `2` bad usage.
