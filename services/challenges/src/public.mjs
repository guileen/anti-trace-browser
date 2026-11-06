/** Public overview and consented, server-verified Turnstile experiments. */
import { challengeRoute } from './challenge.mjs';
export { AttemptObject } from './attempt-object.mjs';
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = `${url.protocol}//${url.host}`;
    const challenge = await challengeRoute(request, env);
    if (challenge) return challenge;

    if (url.pathname === '/robots.txt') {
      return text(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`, 'text/plain');
    }

    if (url.pathname === '/sitemap.xml') {
      return text(
        `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${origin}/</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>
  <url><loc>${origin}/check</loc><changefreq>monthly</changefreq><priority>0.6</priority></url>
</urlset>`,
        'application/xml',
      );
    }


    return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=600' } });
  },
};

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

const text = (body, type) => new Response(body, { headers: { 'content-type': `${type}; charset=utf-8` } });

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Browser Fingerprint Test — see what your browser reveals</title>
<meta name="description" content="A free browser fingerprint test. Check which headers and browser signals your visit exposes, and whether a Cloudflare bot check accepts or challenges it.">
<link rel="canonical" href="/">
<meta property="og:title" content="Browser Fingerprint Test">
<meta property="og:description" content="See which headers and browser signals your visit exposes, and run a real Cloudflare check.">
<meta property="og:type" content="website">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"WebApplication","name":"Browser Fingerprint Test","applicationCategory":"SecurityApplication","operatingSystem":"Any","description":"Check browser fingerprint exposure and run a real Cloudflare bot check.","offers":{"@type":"Offer","price":"0","priceCurrency":"USD"}}
</script>
<style>
body{font:17px/1.7 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;color:#18181b;background:#fafafa}
main{max-width:46rem;margin:0 auto;padding:4rem 1.25rem}
h1{font-size:2.25rem;line-height:1.2;margin:0 0 .75rem}
h2{font-size:1.15rem;margin:2.5rem 0 .5rem}
p.lead{font-size:1.15rem;color:#3f3f46;margin:0 0 2rem}
a.button{display:inline-block;background:#18181b;color:#fff;padding:.7rem 1.3rem;border-radius:.5rem;text-decoration:none}
ul{padding-left:1.2rem}
code{background:#f4f4f5;padding:.1rem .35rem;border-radius:.25rem}
footer{margin-top:3rem;color:#71717a;font-size:.9rem}
</style>
</head>
<body><main>
<h1>Browser Fingerprint Test</h1>
<p class="lead">Find out what a website can read from your browser, and whether a real Cloudflare bot check lets the visit through.</p>
<p><a class="button" href="/check">Run the check</a></p>

<h2>What you will see</h2>
<ul>
<li>Whether Cloudflare challenged this visit or returned the page.</li>
<li>The HTTP headers your browser actually sent: user agent, language, client hints.</li>
<li>The edge location that answered, from the <code>cf-ray</code> header.</li>
</ul>

<h2>Why headers matter</h2>
<p>A user agent alone rarely settles anything: modern checks compare it against the language, the client hints, the TLS fingerprint and the exit IP. A browser that claims one platform while its headers describe another is easy to single out.</p>

<h2>Privacy</h2>
<p>Detailed fingerprint reports stay local. Starting verification creates a private, run-scoped result retained for 24 hours. The server verifies the single-use Turnstile token; access credentials and raw IP addresses stay out of public reports.</p>

<footer>Operated with Cloudflare Turnstile and Workers. Source: the anti-trace project.</footer>
</main></body></html>`;
