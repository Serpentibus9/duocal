// gauth.js — "Sign in with Google" for the DuoCal web app.
//
// There is no DuoCal server, so the browser gets a short-lived (1 hour) access
// pass straight from Google using OAuth 2.0 (the redirect "token" flow for web apps).
// Your Google password and 2-step verification stay with Google: DuoCal never sees them.
//
// Security measures in this file:
//   * state:      a random one-time value; an answer that doesn't carry it is refused (stops forged sign-ins)
//   * audience:   the pass is checked with Google to really be issued to DuoCal (stops token substitution)
//   * no traces:  the pass is removed from the address bar/history immediately
//   * short life: kept only in sessionStorage (gone when the app is closed), never in a cookie or the URL
//   * revoke:     "Sign out" can also cancel DuoCal's access at Google
(function (root) {
  const CFG = root.DUOCAL_CONFIG || {};
  const SCOPE = 'openid email https://www.googleapis.com/auth/calendar';
  const KEY = 'duocal.gtoken', STATE = 'duocal.oauthState';
  const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');

  function randomString(bytes = 32) {
    const a = new Uint8Array(bytes); crypto.getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  }
  function joinFromUrl() {
    const m = location.hash.match(/(?:^#|&)join=([^&]+)/);
    return m ? decodeURIComponent(m[1]).slice(0, 600) : null;
  }

  // silent: no Google screens if you're already signed in to Google on this device
  function signIn({ silent = false, hint } = {}) {
    if (!CFG.clientId) { alert('DuoCal is not set up yet: the Google Client ID is missing in js/config.js.'); return; }
    const state = randomString();
    const prev = JSON.parse(sessionStorage.getItem(STATE) || 'null');
    sessionStorage.setItem(STATE, JSON.stringify({ state, t: Date.now(), join: joinFromUrl() || (prev && prev.join) || null }));
    const p = new URLSearchParams({
      client_id: CFG.clientId, redirect_uri: redirectUri(), response_type: 'token', scope: SCOPE,
      include_granted_scopes: 'true', state, prompt: silent ? 'none' : 'select_account',
    });
    if (hint) p.set('login_hint', hint);
    location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + p);
  }

  // Called once at start-up. Returns null (nothing to do) or { ok | error, join, email }.
  async function handleRedirect() {
    const hash = location.hash;
    if (!/[#&](access_token|error)=/.test(hash)) return null;
    const h = new URLSearchParams(hash.slice(1));
    history.replaceState(null, '', redirectUri()); // wipe the pass from the address bar and history
    const saved = JSON.parse(sessionStorage.getItem(STATE) || 'null');
    sessionStorage.removeItem(STATE);
    if (!saved || !h.get('state') || saved.state !== h.get('state') || Date.now() - saved.t > 10 * 60e3) return { error: 'state' };
    if (h.get('error')) return { error: String(h.get('error')).slice(0, 60), join: saved.join };
    const token = h.get('access_token');
    if (!token || !/^[\w.\-~+/]+=*$/.test(token) || token.length > 4096) return { error: 'token' };
    // Ask Google who this pass belongs to before using it.
    let info = {};
    try { info = await (await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token))).json(); } catch { }
    if (info.aud !== CFG.clientId && info.azp !== CFG.clientId) return { error: 'audience' };
    if (!String(info.scope || '').includes('auth/calendar')) return { error: 'scope', join: saved.join };
    const email = String(info.email || '').toLowerCase();
    if (!/^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/.test(email)) return { error: 'email' };
    const life = Math.min(+info.expires_in || +h.get('expires_in') || 3600, 3600);
    sessionStorage.setItem(KEY, JSON.stringify({ token, exp: Date.now() + (life - 60) * 1000, email }));
    localStorage.setItem('duocal.lastEmail', email);
    return { ok: true, join: saved.join, email };
  }

  function current() {
    const t = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    return t && t.exp > Date.now() ? t : null;
  }
  async function signOut({ revoke = false } = {}) {
    const t = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (revoke && t) await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t.token), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }).catch(() => { });
    sessionStorage.removeItem(KEY);
  }
  root.GAuth = { signIn, handleRedirect, current, signOut, appUrl: redirectUri };
})(window);
