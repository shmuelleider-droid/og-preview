#!/usr/bin/env node
'use strict';

/**
 * og-lab: a local Open Graph card previewer.
 *
 * Runs a small HTTP server that fetches a URL server-side (so localhost,
 * private hostnames, and self-signed certificates all work), parses the
 * social meta tags out of the response, and renders platform-accurate
 * previews in the browser.
 *
 * No dependencies. Requires Node 18 or later for the global fetch.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const MAJOR = Number(process.versions.node.split('.')[0]);
if (MAJOR < 18) {
  console.error(`og-lab needs Node 18 or later. This is Node ${process.versions.node}.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Command-line options
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

function option(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index !== -1 && argv[index + 1] && !argv[index + 1].startsWith('--')) {
    return argv[index + 1];
  }
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  return fallback;
}

const PORT = Number(option('port', process.env.PORT || 4747));
const HOST = option('host', '127.0.0.1');
const INSECURE = argv.includes('--insecure');

// Local dev sites usually run behind a self-signed certificate.
if (INSECURE) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const FETCH_TIMEOUT_MS = 20000;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Crawler identities
// ---------------------------------------------------------------------------

const USER_AGENTS = {
  browser:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  facebook: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  twitter: 'Twitterbot/1.0',
  slack: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  linkedin:
      'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
  discord: 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
  whatsapp: 'WhatsApp/2.23.20.0',
  google: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
};

// ---------------------------------------------------------------------------
// HTML parsing
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', rsquo: '\u2019',
  lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d', copy: '\u00a9',
  reg: '\u00ae', trade: '\u2122', eacute: '\u00e9', egrave: '\u00e8',
};

function decodeEntities(input) {
  if (!input || input.indexOf('&') === -1) return input || '';
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code =
          body[1] === 'x' || body[1] === 'X'
              ? parseInt(body.slice(2), 16)
              : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

const ATTR_PATTERN =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttributes(source) {
  const attributes = {};
  let match;
  ATTR_PATTERN.lastIndex = 0;
  while ((match = ATTR_PATTERN.exec(source))) {
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attributes[match[1].toLowerCase()] = decodeEntities(value).trim();
  }
  return attributes;
}

/** Returns the `<head>` markup, or the whole document when no head exists. */
function headOf(html) {
  const start = html.search(/<head[\s>]/i);
  const end = html.search(/<\/head\s*>/i);
  if (start !== -1 && end !== -1 && end > start) return html.slice(start, end);
  // Fall back to the first 512 KB so a huge body doesn't slow the regex down.
  return html.slice(0, 512 * 1024);
}

function parseDocument(html) {
  const head = headOf(html);
  const meta = [];
  const links = [];

  let match;
  const metaPattern = /<meta\b([^>]*?)\/?>/gi;
  while ((match = metaPattern.exec(head))) {
    const attributes = parseAttributes(match[1]);
    const key = attributes.property || attributes.name || attributes.itemprop;
    if (!key) continue;
    meta.push({
      key: key.toLowerCase(),
      value: attributes.content ?? '',
      source: attributes.property ? 'property' : attributes.name ? 'name' : 'itemprop',
    });
  }

  const linkPattern = /<link\b([^>]*?)\/?>/gi;
  while ((match = linkPattern.exec(head))) {
    const attributes = parseAttributes(match[1]);
    if (!attributes.rel) continue;
    links.push({ rel: attributes.rel.toLowerCase(), href: attributes.href || '', attributes });
  }

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  const baseMatch = /<base\b([^>]*?)\/?>/i.exec(head);
  const langMatch = /<html\b([^>]*?)>/i.exec(html);

  return {
    meta,
    links,
    title: titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : '',
    base: baseMatch ? parseAttributes(baseMatch[1]).href || '' : '',
    lang: langMatch ? parseAttributes(langMatch[1]).lang || '' : '',
  };
}

function firstValue(meta, ...keys) {
  for (const key of keys) {
    const hit = meta.find((entry) => entry.key === key && entry.value.trim() !== '');
    if (hit) return hit.value.trim();
  }
  return '';
}

function allValues(meta, key) {
  return meta.filter((entry) => entry.key === key && entry.value.trim() !== '')
      .map((entry) => entry.value.trim());
}

function absolutize(value, base) {
  if (!value) return '';
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

function isAbsolute(value) {
  return /^https?:\/\//i.test(value || '');
}

function isLocalHost(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return (
        host === 'localhost' ||
        host === '::1' ||
        host.endsWith('.local') ||
        host.endsWith('.localhost') ||
        /^127\./.test(host) ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Image inspection
// ---------------------------------------------------------------------------

function readImageSize(buffer) {
  const length = buffer.length;
  if (length < 16) return null;

  // PNG
  if (buffer.readUInt32BE(0) === 0x89504e47) {
    return { format: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  // GIF
  if (buffer.toString('ascii', 0, 3) === 'GIF') {
    return { format: 'gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }

  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        offset += 2;
        continue;
      }
      const segment = buffer.readUInt16BE(offset + 2);
      const isFrame =
          marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        return {
          format: 'jpeg',
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + segment;
    }
    return { format: 'jpeg', width: 0, height: 0 };
  }

  // WebP
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && length > 30) {
      return {
        format: 'webp',
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === 'VP8L' && length > 25) {
      const bits = buffer.readUInt32LE(21);
      return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X' && length > 30) {
      const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
      const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
      return { format: 'webp', width, height };
    }
    return { format: 'webp', width: 0, height: 0 };
  }

  // AVIF and HEIC share the ISO base media container.
  if (buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12);
    const format = brand.startsWith('avi') ? 'avif' : brand.startsWith('hei') ? 'heic' : 'iso';
    const ispe = buffer.indexOf('ispe', 0, 'ascii');
    if (ispe !== -1 && ispe + 16 <= length) {
      return {
        format,
        width: buffer.readUInt32BE(ispe + 8),
        height: buffer.readUInt32BE(ispe + 12),
      };
    }
    return { format, width: 0, height: 0 };
  }

  // SVG
  const text = buffer.toString('utf8', 0, Math.min(length, 4096));
  if (/<svg[\s>]/i.test(text)) {
    const tag = /<svg\b([^>]*)>/i.exec(text);
    const attributes = tag ? parseAttributes(tag[1]) : {};
    const width = parseFloat(attributes.width);
    const height = parseFloat(attributes.height);
    if (Number.isFinite(width) && Number.isFinite(height)) {
      return { format: 'svg', width, height };
    }
    if (attributes.viewbox) {
      const box = attributes.viewbox.split(/[\s,]+/).map(Number);
      if (box.length === 4) return { format: 'svg', width: box[2], height: box[3] };
    }
    return { format: 'svg', width: 0, height: 0 };
  }

  // ICO
  if (buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 1 && buffer[3] === 0) {
    return { format: 'ico', width: buffer[6] || 256, height: buffer[7] || 256 };
  }

  return null;
}

async function readBody(response, limit) {
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.length > limit ? buffer.subarray(0, limit) : buffer;
}

async function inspectImage(url, headers) {
  const result = { url, ok: false, status: 0, bytes: 0, width: 0, height: 0, format: '', error: '' };
  try {
    const response = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    result.status = response.status;
    result.contentType = response.headers.get('content-type') || '';
    if (!response.ok) {
      result.error = `The image request returned ${response.status}.`;
      return result;
    }
    const buffer = await readBody(response, MAX_IMAGE_BYTES);
    result.bytes = buffer.length;
    const size = readImageSize(buffer);
    if (size) {
      result.width = Math.round(size.width);
      result.height = Math.round(size.height);
      result.format = size.format;
    } else {
      result.format = (result.contentType.split('/')[1] || '').split(';')[0];
    }
    result.ok = true;
  } catch (error) {
    result.error = describeFetchError(error, url);
  }
  return result;
}

function describeFetchError(error, url) {
  const cause = error.cause || {};
  const code = cause.code || error.code || error.name || '';
  const map = {
    ECONNREFUSED: `Nothing is listening at ${url}. Check that the dev server runs and the port matches.`,
    ENOTFOUND: `The hostname in ${url} doesn't resolve. Check your hosts file or use 127.0.0.1.`,
    ETIMEDOUT: 'The request timed out.',
    TimeoutError: `No response within ${FETCH_TIMEOUT_MS / 1000} seconds.`,
    ECONNRESET: 'The server closed the connection.',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'The certificate is self-signed. Restart with --insecure.',
    SELF_SIGNED_CERT_IN_CHAIN: 'The certificate chain is self-signed. Restart with --insecure.',
    ERR_TLS_CERT_ALTNAME_INVALID: 'The certificate doesn\'t cover this hostname. Restart with --insecure.',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'The certificate can\'t be verified. Restart with --insecure.',
  };
  return map[code] || `${code ? code + ': ' : ''}${error.message}`;
}

// ---------------------------------------------------------------------------
// Tag extraction
// ---------------------------------------------------------------------------

function extract(document, pageUrl) {
  const { meta, links } = document;
  const base = document.base ? absolutize(document.base, pageUrl) : pageUrl;

  const ogImages = allValues(meta, 'og:image')
      .concat(allValues(meta, 'og:image:url'))
      .concat(allValues(meta, 'og:image:secure_url'));
  const twitterImages = allValues(meta, 'twitter:image').concat(allValues(meta, 'twitter:image:src'));

  const canonical = links.find((link) => link.rel.split(/\s+/).includes('canonical'));
  const icon =
      links.find((link) => link.rel.split(/\s+/).includes('apple-touch-icon')) ||
      links.find((link) => link.rel.split(/\s+/).includes('icon')) ||
      links.find((link) => link.rel.split(/\s+/).includes('shortcut'));

  const rawImage = ogImages[0] || twitterImages[0] || '';
  const rawTwitterImage = twitterImages[0] || ogImages[0] || '';

  return {
    base,
    lang: document.lang,
    documentTitle: document.title,
    title: firstValue(meta, 'og:title', 'twitter:title') || document.title,
    titleSource: firstValue(meta, 'og:title')
        ? 'og:title'
        : firstValue(meta, 'twitter:title')
            ? 'twitter:title'
            : document.title
                ? '<title>'
                : 'none',
    description:
        firstValue(meta, 'og:description', 'twitter:description', 'description') || '',
    descriptionSource: firstValue(meta, 'og:description')
        ? 'og:description'
        : firstValue(meta, 'twitter:description')
            ? 'twitter:description'
            : firstValue(meta, 'description')
                ? 'description'
                : 'none',
    siteName: firstValue(meta, 'og:site_name', 'application-name') || '',
    type: firstValue(meta, 'og:type') || '',
    ogUrl: firstValue(meta, 'og:url'),
    canonical: canonical ? absolutize(canonical.href, base) : '',
    image: absolutize(rawImage, base),
    rawImage,
    imageCount: ogImages.length,
    imageAlt: firstValue(meta, 'og:image:alt', 'twitter:image:alt') || '',
    declaredWidth: Number(firstValue(meta, 'og:image:width')) || 0,
    declaredHeight: Number(firstValue(meta, 'og:image:height')) || 0,
    twitterImage: absolutize(rawTwitterImage, base),
    twitterCard: firstValue(meta, 'twitter:card') || '',
    twitterSite: firstValue(meta, 'twitter:site') || '',
    twitterCreator: firstValue(meta, 'twitter:creator') || '',
    themeColor: firstValue(meta, 'theme-color') || '',
    favicon: icon ? absolutize(icon.href, base) : absolutize('/favicon.ico', base),
    robots: firstValue(meta, 'robots') || '',
    all: meta,
  };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function runChecks(tags, image, pageUrl) {
  const checks = [];
  const add = (level, label, detail) => checks.push({ level, label, detail });

  // Title
  if (!tags.title) {
    add('error', 'No title', 'Add `og:title`. Every platform falls back to the raw URL without one.');
  } else if (tags.titleSource === '<title>') {
    add('warn', 'Title falls back to `<title>`', 'Most platforms accept this, but `og:title` gives you control over the share text.');
  } else if (tags.title.length > 70) {
    add('warn', `Title runs ${tags.title.length} characters`, 'X truncates near 70 and Facebook near 88. Aim for 60 or fewer.');
  } else {
    add('pass', `Title, ${tags.title.length} characters`, tags.titleSource);
  }

  // Description
  if (!tags.description) {
    add('warn', 'No description', 'Facebook, LinkedIn, and Slack all render an empty second line.');
  } else if (tags.description.length > 200) {
    add('warn', `Description runs ${tags.description.length} characters`, 'Facebook cuts near 155 and LinkedIn near 100.');
  } else if (tags.description.length < 40) {
    add('nit', `Description runs ${tags.description.length} characters`, 'Between 55 and 155 characters fills the card without truncation.');
  } else {
    add('pass', `Description, ${tags.description.length} characters`, tags.descriptionSource);
  }

  // Image URL shape
  if (!tags.rawImage) {
    add('error', 'No `og:image`', 'Without an image the card collapses to a single text line on every platform.');
  } else {
    if (!isAbsolute(tags.rawImage)) {
      add('error', 'Image URL is relative', `Crawlers don't resolve relative paths. Emit the full URL, not \`${tags.rawImage}\`.`);
    }
    if (tags.rawImage.startsWith('//')) {
      add('error', 'Image URL is protocol-relative', 'Several crawlers reject `//host/path`. Use an explicit `https://`.');
    }
    if (isLocalHost(tags.image)) {
      add('warn', 'Image URL points at a private host', 'Expected while testing. Confirm the deployed build emits the public origin.');
    }
    if (tags.imageCount > 1) {
      add('nit', `${tags.imageCount} \`og:image\` tags`, 'Facebook lets you pick between them; X, Slack, and Discord take the first.');
    }
    if (!tags.imageAlt) {
      add('nit', 'No `og:image:alt`', 'Screen readers on X and Mastodon read this.');
    }
  }

  // Image bytes
  if (image && tags.rawImage) {
    if (!image.ok) {
      add('error', 'Image does not load', image.error || `Request returned ${image.status}.`);
    } else {
      const { width, height, bytes, format } = image;
      const megabytes = bytes / (1024 * 1024);

      if (format === 'svg') {
        add('error', 'Image is an SVG', 'No major platform renders SVG cards. Export a PNG or JPEG.');
      } else if (['webp', 'avif', 'heic'].includes(format)) {
        add('warn', `Image is ${format.toUpperCase()}`, 'X and Slack render it; LinkedIn and iMessage are unreliable. PNG or JPEG is safest.');
      }

      if (width && height) {
        const ratio = width / height;
        if (width < 200 || height < 200) {
          add('error', `Image is ${width}\u00d7${height}`, 'Below 200\u00d7200 the platforms drop the image entirely.');
        } else if (width < 600) {
          add('warn', `Image is ${width}\u00d7${height}`, 'X needs 300\u00d7157 minimum for a large card; 1200\u00d7630 stays sharp on retina screens.');
        } else if (Math.abs(ratio - 1.91) > 0.25 && Math.abs(ratio - 1) > 0.08) {
          add('warn', `Aspect ratio is ${ratio.toFixed(2)}:1`, 'Cards crop to 1.91:1 from the center. Check the crop gauge for what gets cut.');
        } else {
          add('pass', `Image is ${width}\u00d7${height}`, `${ratio.toFixed(2)}:1, ${format.toUpperCase()}`);
        }

        if (tags.declaredWidth && tags.declaredWidth !== width) {
          add('warn', 'Declared width doesn\'t match the file', `\`og:image:width\` says ${tags.declaredWidth}, the file is ${width}.`);
        }
        if (tags.declaredHeight && tags.declaredHeight !== height) {
          add('warn', 'Declared height doesn\'t match the file', `\`og:image:height\` says ${tags.declaredHeight}, the file is ${height}.`);
        }
        if (!tags.declaredWidth || !tags.declaredHeight) {
          add('nit', 'No `og:image:width` or `og:image:height`', 'Facebook renders a blank box on first scrape without them.');
        }
      }

      if (megabytes > 5) {
        add('error', `Image weighs ${megabytes.toFixed(1)} MB`, 'X caps at 5 MB and Facebook at 8 MB.');
      } else if (megabytes > 1) {
        add('nit', `Image weighs ${megabytes.toFixed(1)} MB`, 'Under 1 MB keeps the crawler from timing out.');
      }
    }
  }

  // Card type
  if (!tags.twitterCard) {
    add('warn', 'No `twitter:card`', 'X falls back to a small square card. Set `summary_large_image` for the wide one.');
  } else if (!['summary', 'summary_large_image', 'app', 'player'].includes(tags.twitterCard)) {
    add('error', `Unknown \`twitter:card\` value \`${tags.twitterCard}\``, 'Use `summary` or `summary_large_image`.');
  } else {
    add('pass', `Card type \`${tags.twitterCard}\``, '');
  }

  // URL and identity
  if (!tags.ogUrl) {
    add('nit', 'No `og:url`', 'Sets the canonical target when the link is reshared.');
  } else {
    if (!isAbsolute(tags.ogUrl)) {
      add('error', '`og:url` is relative', 'It must be an absolute URL.');
    } else if (isLocalHost(tags.ogUrl)) {
      add('warn', '`og:url` points at a private host', 'Expected while testing. Confirm the deployed build emits the public origin.');
    }
    if (tags.canonical && tags.ogUrl && tags.canonical !== tags.ogUrl) {
      add('nit', '`og:url` and the canonical link differ', `Canonical is \`${tags.canonical}\`.`);
    }
  }

  if (!tags.siteName) add('nit', 'No `og:site_name`', 'Slack and Discord print it above the title.');
  if (!tags.type) add('nit', 'No `og:type`', 'Use `website` or `article`.');

  if (/noindex|nofollow/i.test(tags.robots)) {
    add('warn', `\`robots\` is \`${tags.robots}\``, 'Some crawlers honor this and skip the preview.');
  }

  const order = { error: 0, warn: 1, nit: 2, pass: 3 };
  checks.sort((a, b) => order[a.level] - order[b.level]);
  return checks;
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function parseHeaderBlock(text) {
  const headers = {};
  if (!text) return headers;
  for (const line of String(text).split('\n')) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    const name = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (name) headers[name] = value;
  }
  return headers;
}

// Attribute names that show up when someone pastes a Set-Cookie response header.
const COOKIE_ATTRIBUTES = new Set([
  'path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly',
  'priority', 'partitioned', 'version', 'comment',
]);

/**
 * Accepts a raw Cookie header, a Set-Cookie line, `document.cookie` output, or
 * one `name=value` per line, and returns a normalized Cookie header value.
 */
function parseCookieInput(text) {
  if (!text) return '';
  const pairs = [];
  const seen = new Set();

  for (let entry of String(text).split(/[\n;]+/)) {
    entry = entry.trim().replace(/^set-cookie\s*:\s*/i, '').replace(/^cookie\s*:\s*/i, '');
    if (!entry) continue;

    const split = entry.indexOf('=');
    if (split <= 0) continue;

    const name = entry.slice(0, split).trim();
    if (!/^[\w!#$%&'*+\-.^`|~]+$/.test(name)) continue;
    if (COOKIE_ATTRIBUTES.has(name.toLowerCase())) continue;
    if (seen.has(name)) continue;

    const value = entry.slice(split + 1).trim().replace(/^"(.*)"$/, '$1');
    seen.add(name);
    pairs.push(`${name}=${value}`);
  }

  return pairs.join('; ');
}

function countCookies(cookieHeader) {
  return cookieHeader ? cookieHeader.split('; ').length : 0;
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

/** True when the target belongs to the page's host or one of its subdomains. */
function sameSite(target, page) {
  try {
    const a = new URL(target).hostname.toLowerCase();
    const b = new URL(page).hostname.toLowerCase();
    return a === b || a.endsWith(`.${b}`);
  } catch {
    return false;
  }
}

/**
 * Holds the cookies from the last preview per origin, so the image proxy can
 * reuse them without putting credentials in a query string.
 */
const cookieStore = new Map();

function rememberCookies(pageUrl, cookieHeader, agent) {
  const origin = originOf(pageUrl);
  if (!origin) return;
  if (!cookieHeader) {
    cookieStore.delete(origin);
    return;
  }
  cookieStore.set(origin, { cookie: cookieHeader, page: pageUrl, agent });
  if (cookieStore.size > 20) cookieStore.delete(cookieStore.keys().next().value);
}

function cookiesFor(targetUrl) {
  for (const [origin, entry] of cookieStore) {
    if (originOf(targetUrl) === origin || sameSite(targetUrl, entry.page)) return entry.cookie;
  }
  return '';
}

async function buildPreview(payload) {
  const agent = USER_AGENTS[payload.agent] || USER_AGENTS.browser;
  const custom = parseHeaderBlock(payload.headers);

  // A Cookie line typed into the headers box merges with the cookies field.
  const inlineCookie = Object.keys(custom).find((name) => name.toLowerCase() === 'cookie');
  if (inlineCookie) {
    payload.cookies = `${payload.cookies || ''}\n${custom[inlineCookie]}`;
    delete custom[inlineCookie];
  }

  const cookie = parseCookieInput(payload.cookies);

  const headers = {
    'User-Agent': agent,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    ...(cookie ? { Cookie: cookie } : {}),
    ...custom,
  };

  let html = payload.html || '';
  let pageUrl = payload.url || 'http://localhost/';
  const response = {
    requestedUrl: payload.url || '',
    finalUrl: '',
    status: 0,
    redirected: false,
    cookieCount: countCookies(cookie),
  };

  if (!payload.html) {
    if (!/^https?:\/\//i.test(pageUrl)) pageUrl = `http://${pageUrl}`;
    const page = await fetch(pageUrl, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    response.status = page.status;
    response.finalUrl = page.url;
    response.redirected = page.url !== pageUrl;
    response.contentType = page.headers.get('content-type') || '';
    response.setCookie = page.headers.getSetCookie ? page.headers.getSetCookie().length : 0;
    const buffer = await readBody(page, MAX_HTML_BYTES);
    html = buffer.toString('utf8');
    pageUrl = page.url || pageUrl;
    if (!page.ok) {
      response.warning = `The page returned ${page.status}. The tags below come from that response body.`;
    }
  } else {
    response.finalUrl = pageUrl;
    response.status = 200;
    response.contentType = 'text/html (pasted)';
  }

  rememberCookies(payload.url || pageUrl, cookie, payload.agent);

  const document = parseDocument(html);
  const tags = extract(document, pageUrl);

  const imageHeaders = { 'User-Agent': agent };
  if (cookie && sameSite(tags.image, pageUrl)) imageHeaders.Cookie = cookie;

  const image = tags.image ? await inspectImage(tags.image, imageHeaders) : null;
  const checks = runChecks(tags, image, pageUrl);

  // A redirect to a sign-in page is the usual sign that the fetch needs cookies.
  if (/\b(login|log-in|signin|sign-in|auth|account\/login)\b/i.test(response.finalUrl) &&
      !/\b(login|signin)\b/i.test(response.requestedUrl)) {
    checks.unshift({
      level: 'error',
      label: 'The fetch landed on a sign-in page',
      detail: cookie
          ? 'The cookies you supplied were rejected or have expired. Copy a fresh set from the network tab.'
          : 'Paste your session cookies under More options so the crawler sees the real page.',
    });
  } else if (response.status === 401 || response.status === 403) {
    checks.unshift({
      level: 'error',
      label: `The page returned ${response.status}`,
      detail: 'Add session cookies under More options to preview a page behind a login.',
    });
  }

  return { ...response, agent, tags, image, checks, bytes: Buffer.byteLength(html) };
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 4 * 1024 * 1024) reject(new Error('Request body too large.'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// Look in public/ first, then next to server.js, so a flattened download works.
const STATIC_DIRS = [path.join(__dirname, 'public'), __dirname];

function resolveStatic(requestPath) {
  const file = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  for (const dir of STATIC_DIRS) {
    const target = path.resolve(dir, file);
    if (!target.startsWith(path.resolve(dir) + path.sep)) continue;
    if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname === '/api/preview' && req.method === 'POST') {
      const payload = JSON.parse((await readRequestBody(req)) || '{}');
      if (!payload.url && !payload.html) {
        return send(res, 400, { error: 'Provide a url or an html snippet.' });
      }
      try {
        return send(res, 200, await buildPreview(payload));
      } catch (error) {
        return send(res, 200, { error: describeFetchError(error, payload.url || 'the page') });
      }
    }

    if (url.pathname === '/api/image' && req.method === 'GET') {
      const target = url.searchParams.get('url');
      if (!target || !/^https?:\/\//i.test(target)) return send(res, 400, { error: 'Bad image url.' });
      const cookie = cookiesFor(target);
      const upstream = await fetch(target, {
        headers: {
          'User-Agent': USER_AGENTS[url.searchParams.get('agent')] || USER_AGENTS.browser,
          ...(cookie ? { Cookie: cookie } : {}),
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!upstream.ok) return send(res, 502, { error: `Upstream returned ${upstream.status}.` });
      const buffer = await readBody(upstream, MAX_IMAGE_BYTES);
      res.writeHead(200, {
        'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
        'Content-Length': buffer.length,
        'Cache-Control': 'no-store',
      });
      return res.end(buffer);
    }

    if (req.method === 'GET') {
      const target = resolveStatic(url.pathname);
      if (target) {
        const type = STATIC_TYPES[path.extname(target)] || 'application/octet-stream';
        return send(res, 200, fs.readFileSync(target), type);
      }
      if (url.pathname === '/') {
        return send(
            res,
            500,
            `<!doctype html><meta charset="utf-8"><title>og-lab</title>
           <body style="font:14px/1.6 ui-monospace,monospace;padding:40px;max-width:60ch">
           <h1 style="font-size:16px">index.html is missing</h1>
           <p>og-lab looked in:</p>
           <ul>${STATIC_DIRS.map((dir) => `<li>${path.join(dir, 'index.html')}</li>`).join('')}</ul>
           <p>Put <code>index.html</code> in either directory and reload.</p>`,
            'text/html; charset=utf-8',
        );
      }
    }

    send(res, 404, { error: 'Not found.' });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`og-lab is listening on http://${HOST}:${PORT}`);
  if (INSECURE) console.log('TLS verification is off for this process.');
  if (!resolveStatic('/')) {
    console.warn('Warning: index.html is missing. Put it in ./public or next to server.js.');
  }
});