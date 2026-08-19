# og-lab

Preview Open Graph share cards for pages that aren't publicly reachable yet.

The debuggers that Facebook, X, and LinkedIn publish all crawl from the public internet, so they can't see `localhost:5000` or an internal staging host. og-lab fetches the page from your machine instead, parses the tags out of the response, and renders what each platform shows.

## Requirements

Node 18 or later. No dependencies, no build step, no network access.

## Run it

```bash
node server.js
```

Open http://127.0.0.1:4747, enter a URL, and select **Preview**.

Options:

| Flag | Default | Purpose |
| --- | --- | --- |
| `--port <n>` | `4747` | Port for og-lab itself. |
| `--host <addr>` | `127.0.0.1` | Bind address. Use `0.0.0.0` to reach it from another device. |
| `--insecure` | off | Skip TLS verification, for dev sites behind a self-signed certificate. |

You can also open a URL directly: `http://127.0.0.1:4747/?url=http://localhost:3000/some-page`.

## What it does

- **Renders nine surfaces.** X large and small, Facebook, LinkedIn, Slack, Discord, iMessage, WhatsApp, and a Google result. Each one uses that platform's real fonts, colors, and truncation, so a title that gets cut off in the preview gets cut off in production.
- **Checks the tags.** Missing tags, oversized titles, relative image URLs, wrong aspect ratios, images that 404, images over the 5 MB limit, and declared dimensions that don't match the file. Errors, warnings, and nits sort to the top in that order.
- **Reads the real image bytes.** The server downloads the image and reads the dimensions out of the header, so what you see is the file itself, not the values in `og:image:width`.
- **Shows the crop gauge.** The left rail overlays the 1.91:1 and 1:1 center crops on the source image, so you can tell before you ship whether a logo or a face falls outside the frame.
- **Flags private hosts.** An `og:image` that points at `localhost` renders here and breaks after deploy. og-lab warns about it rather than showing a green check.

## Previewing pages that need context

**A page behind a login.** Under **More options**, paste request headers, one per line:

```
Cookie: .ASPXAUTH=ABCDEF…; ASP.NET_SessionId=…
```

Copy the value from your browser's network tab.

**A page that varies by crawler.** Some stacks serve different markup to bots. Switch **Fetch as** to `facebookexternalhit` or `Twitterbot` to see what the crawler receives. Changing the selection refetches.

**Copy that isn't in the template yet.** Type into the fields under **Try different copy** in the left rail. The cards update as you type, and **Copy meta tags** gives you a corrected block to paste into the page. Nothing is written back to your site.

**Markup with no server.** Paste HTML into the second box under **More options**. og-lab resolves relative image paths against whatever URL is in the URL field.

## Notes

- The server binds to loopback by default, and it fetches whatever URL you give it. Treat `--host 0.0.0.0` the way you'd treat any open proxy on your network.
- Card layouts track what the platforms render today. Platforms change them without notice, and X in particular now hides the title and description on `summary_large_image`, which is why that card is image-only.
- The API is two endpoints, if you want to script against it: `POST /api/preview` with `{ url, html, agent, headers }`, and `GET /api/image?url=…`.
