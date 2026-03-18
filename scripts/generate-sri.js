#!/usr/bin/env node
/**
 * generate-sri.js – Compute SRI hashes for frontend assets and inject them
 * into index.html as `integrity` attributes.
 *
 * Usage:
 *   node scripts/generate-sri.js
 *
 * The script reads frontend/index.html, computes SHA-384 digests for every
 * local `<link rel="stylesheet">` and `<script src="…">` element, then writes
 * the updated HTML back in place.
 *
 * Run this after any change to the frontend CSS or JS files so the hashes stay
 * current.  Browsers will refuse to load a resource whose hash does not match.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ROOT       = path.resolve(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'frontend', 'index.html');
const FRONTEND   = path.join(ROOT, 'frontend');

function sriHash(filePath) {
  const buf    = fs.readFileSync(filePath);
  const digest = crypto.createHash('sha384').update(buf).digest('base64');
  return `sha384-${digest}`;
}

/** Remove integrity/crossorigin attrs and normalise whitespace from an attr string. */
function stripSriAttrs(attrs) {
  return attrs
    .replace(/\s*integrity="[^"]*"/g, '')
    .replace(/\s*crossorigin="[^"]*"/g, '')
    .replace(/\s*\/?$/, '')   // drop trailing self-close slash
    .trim();
}

let html = fs.readFileSync(INDEX_HTML, 'utf8');

// ── <link … href="local/path"> ───────────────────────────────────────────────
html = html.replace(
  /<link(\s[^>]*?)href="([^"]+)"([^>]*?)\s*\/?>/g,
  (match, before, href, after) => {
    if (href.startsWith('http') || href.startsWith('//')) return match;
    const abs = path.join(FRONTEND, href);
    if (!fs.existsSync(abs)) return match;
    const hash   = sriHash(abs);
    const attrs  = stripSriAttrs(before + after);
    return `<link ${attrs} href="${href}" integrity="${hash}" crossorigin="anonymous" />`;
  },
);

// ── <script … src="local/path"> ──────────────────────────────────────────────
html = html.replace(
  /<script(\s[^>]*?)src="([^"]+)"([^>]*?)>/g,
  (match, before, src, after) => {
    if (src.startsWith('http') || src.startsWith('//')) return match;
    const abs = path.join(FRONTEND, src);
    if (!fs.existsSync(abs)) return match;
    const hash  = sriHash(abs);
    const attrs = stripSriAttrs(before + after);
    return `<script ${attrs} src="${src}" integrity="${hash}" crossorigin="anonymous">`;
  },
);

fs.writeFileSync(INDEX_HTML, html, 'utf8');
console.log('SRI hashes written to', path.relative(ROOT, INDEX_HTML));
