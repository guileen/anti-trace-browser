/**
 * Cloudflare Turnstile target practice (deployable).
 *
 * A page whose only job is to run Turnstile and report whether the visitor got
 * a token. Deploy to its own subdomain so real traffic is untouched.
 *
 *   wrangler secret put TURNSTILE_SECRET
 *   wrangler deploy
 *
 * wrangler.toml supplies TURNSTILE_SITEKEY and LAB_ORIGIN.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/verify' && request.method === 'POST') {
      const form = await request.formData();
      const token = String(form.get('cf-turnstile-response') || '');
      if (!token) return json({ status: 'missing_token' }, 400);
      const verified = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: request.headers.get('cf-connecting-ip') || '' }),
      }).then((response) => response.json()).catch(() => ({ success: false }));
      return json({
        status: verified.success ? 'passed' : 'rejected',
        error_codes: verified['error-codes'] || [],
        hostname: verified.hostname,
        challenge_ts: verified.challenge_ts,
      }, verified.success ? 200 : 403);
    }

    if (url.pathname === '/ok') {
      const cookie = request.headers.get('cookie') || '';
      if (!cookie.includes('lab_pass=1')) return json({ status: 'no_proof' }, 403);
      return json({
        status: 'passed',
        user_agent: request.headers.get('user-agent'),
        accept_language: request.headers.get('accept-language'),
        ray: request.headers.get('cf-ray'),
        country: request.headers.get('cf-ipcountry'),
      });
    }

    return new Response(page(env.TURNSTILE_SITEKEY), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  },
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json' } });

const page = (sitekey) => `<!doctype html><meta charset="utf-8"><title>Lab: Turnstile</title>
<h1>Turnstile target</h1>
<p id="status">waiting for the widget…</p>
<div class="cf-turnstile" data-sitekey="${sitekey}" data-callback="done"></div>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<script>
window.done = async (token) => {
  const body = new FormData();
  body.append('cf-turnstile-response', token);
  const answer = await fetch('/verify', { method: 'POST', body });
  const result = await answer.json();
  document.getElementById('status').textContent = result.status;
  if (result.status === 'passed') {
    document.cookie = 'lab_pass=1; path=/; max-age=600';
    location.replace('/ok');
  }
};
</script>`;
