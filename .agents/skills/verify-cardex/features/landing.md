# Read the homepage

A person opens the site and sees the Cantonese pitch, the install prompt, and a button whose name is `複製`. English is a separate page.

## Sub-features

- `home-zh` shows the zh-HK hero at `/`.
- `home-copy` includes a button named `複製`.
- `home-en` shows the English page at `/en`.

## How to get to it (user POV)

- Open `/`.
- Open `/en`.
- Use the button named `複製` on the install prompt.

## Driving it with verify-cardex

Preconditions:

- `verify.sh doctor` succeeded for this run.
- Read the run's `url` from `runs/<run-id>/meta.json`.

- **Cantonese homepage.** Open `/`. Run `curl -fsS "$url/"`. The HTML contains `碌邊張卡` and `複製`.
- **English homepage.** Open `/en`. Run `curl -fsS "$url/en"`. The HTML contains `Know which card` and a button named `Copy`.
- **Proof.** Save both bodies under `evidence/<run-id>/landing-zh.html` and `evidence/<run-id>/landing-en.html`.

## Gotchas

- The copy control's accessible name is its text, `複製`. It has no separate `aria-label`.
- `curl` sees the label in the HTML. It does not press the button, so it does not prove a clipboard write.
- `/admin` is behind the Worker identity check. A homepage run does not verify it.
