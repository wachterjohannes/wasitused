# greet

A tiny localized greeting CLI.

```bash
node greet.js en World   # Hello, World!
node greet.js de Welt    # Hallo, Welt!
```

Each supported locale is a file in `locales/<locale>.json` holding the
project's canonical template for that language, with `{name}` as the
placeholder for the person being greeted.
