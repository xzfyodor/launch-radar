// Builds the public website (web/index.html) from the same page the claude.ai version uses.
// The page detects where it runs: on the website it loads /data.json, which vercel.json points at the
// latest collector output on the repo's `data` branch.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'hosted', 'launch-radar.html'), 'utf8');
const cut = page.indexOf('<header');
if (cut < 0) throw new Error('page has no <header>');
const head = page.slice(0, cut), body = page.slice(cut);
const icon = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#06080a"/><circle cx="16" cy="16" r="10" fill="none" stroke="#3ff0c8" stroke-opacity=".5" stroke-width="1.6"/><path d="M16 16 L25 10" stroke="#3ff0c8" stroke-width="2.4" stroke-linecap="round"/><circle cx="16" cy="16" r="2.6" fill="#3ff0c8"/></svg>');
const desc = 'Live radar for memecoin launches on Solana, Base, Robinhood Chain and Elysium: where to launch, which launchpad works, what themes are hot and what is coming next.';
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="${desc}">
<meta property="og:title" content="Launch Radar">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="website">
<meta name="theme-color" content="#06080a">
<link rel="icon" href="data:image/svg+xml,${icon}">
${head.trim()}
</head>
<body>
${body.trim()}
</body>
</html>
`;
fs.mkdirSync(path.join(root, 'web'), { recursive: true });
fs.writeFileSync(path.join(root, 'web', 'index.html'), html);
console.log(`web/index.html written (${Math.round(html.length / 1024)} KB)`);
