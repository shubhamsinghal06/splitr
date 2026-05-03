# Splitr

A lightweight, Splitwise-style **Progressive Web App** to track and split shared expenses. Built with plain HTML, CSS, and vanilla JavaScript — no frameworks, no backend, no build step. Everything lives in the browser via `localStorage` and works fully offline.

## Features

- Create and list **groups**
- Add **members** to a group (names only, no auth)
- Add **expenses** with description, amount, and payer — split equally
- Show **net balances** per member and a simplified **who-owes-whom** list
- **Delete** expenses, members (when not in use), and groups
- Persists everything in `localStorage` under the single key `splitr_data`
- **Installable PWA** — manifest + service worker for offline use
- Mobile-first responsive UI with light/dark theme support

## Files

| File                | Purpose                                          |
| ------------------- | ------------------------------------------------ |
| `index.html`        | App shell                                        |
| `style.css`         | Mobile-first styles + light/dark theme           |
| `app.js`            | All app logic (storage, routing, views)          |
| `manifest.json`     | PWA manifest                                     |
| `service-worker.js` | Offline caching                                  |
| `icon.svg`          | App icon (used by manifest + favicon)            |

## Run locally

The service worker only registers on `http(s)://`, so serve the folder via any static server:

```bash
# From the project root, pick one:
python3 -m http.server 8080
# or
npx serve .
```

Then open <http://localhost:8080>.

> Opening `index.html` directly via `file://` also works for the core app — only the offline service worker is skipped.

## Deploy on GitHub Pages

1. Push this repo to GitHub.
2. In **Settings → Pages**, set the source to the `main` branch / root.
3. Visit `https://<user>.github.io/<repo>/` — the app is installable from the browser menu.

## Data model

A single key, `splitr_data`, stores:

```json
{
  "groups": [
    {
      "id": "uuid",
      "name": "Goa Trip",
      "createdAt": 1730000000000,
      "members": [{ "id": "uuid", "name": "Alex" }],
      "expenses": [
        {
          "id": "uuid",
          "description": "Dinner",
          "amount": 1200,
          "paidBy": "<member id>",
          "createdAt": 1730000000000
        }
      ]
    }
  ]
}
```

## Balance logic

For every expense:

- `share = amount / members.length`
- Each member's balance is reduced by `share`
- The payer's balance is increased by the full `amount`

Net positive balances are creditors, net negatives are debtors. The settlement view greedily pairs the largest debtor with the largest creditor to produce the minimum number of transfers.
