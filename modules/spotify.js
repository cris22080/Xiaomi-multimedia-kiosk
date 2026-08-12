// modules/spotify.js
// Integrazione Spotify via Web API con Authorization Code + PKCE
// (nessun client secret da custodire, adatto a un'app desktop).
//
// Flusso:
//  1) L'utente clicca "Connetti Spotify" nell'app -> apriamo il browser di
//     sistema sull'URL di autorizzazione Spotify.
//  2) Spotify reindirizza a http://127.0.0.1:<porta>/spotify/callback con un
//     "code" -> lo scambiamo per access_token + refresh_token.
//  3) I token vengono salvati su disco (electron-store) e usati per leggere
//     brano in riproduzione e playlist. Il refresh è automatico.

const crypto = require("crypto");
const fetch = require("node-fetch");
const Store = require("electron-store");

const store = new Store({ name: "spotify-auth" });

const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API_BASE = "https://api.spotify.com/v1";

let cfgRef = null;
let pendingVerifier = null; // code_verifier in attesa del callback

function configure(cfg) {
  cfgRef = cfg;
}

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildAuthUrl(cfg) {
  cfgRef = cfg;
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  pendingVerifier = verifier;

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: cfg.redirectUri,
    code_challenge_method: "S256",
    code_challenge: challenge,
    scope: cfg.scopes.join(" ")
  });

  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCode(code) {
  if (!pendingVerifier) throw new Error("Nessun login Spotify in corso");

  const body = new URLSearchParams({
    client_id: cfgRef.clientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: cfgRef.redirectUri,
    code_verifier: pendingVerifier
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) throw new Error(`Spotify token exchange fallito: ${res.status}`);
  const tokens = await res.json();
  saveTokens(tokens);
  pendingVerifier = null;
  return tokens;
}

function saveTokens(tokens) {
  const expiresAt = Date.now() + tokens.expires_in * 1000;
  store.set("access_token", tokens.access_token);
  store.set("expires_at", expiresAt);
  if (tokens.refresh_token) store.set("refresh_token", tokens.refresh_token);
}

async function refreshAccessToken() {
  const refreshToken = store.get("refresh_token");
  if (!refreshToken) throw new Error("Nessun refresh_token salvato, serve rifare il login");

  const body = new URLSearchParams({
    client_id: cfgRef.clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) throw new Error(`Spotify refresh fallito: ${res.status}`);
  const tokens = await res.json();
  saveTokens(tokens);
  return tokens.access_token;
}

async function getValidAccessToken() {
  const token = store.get("access_token");
  const expiresAt = store.get("expires_at") || 0;
  if (token && Date.now() < expiresAt - 10000) return token;
  return refreshAccessToken();
}

function isAuthenticated() {
  return Boolean(store.get("refresh_token"));
}

function logout() {
  store.clear();
}

async function apiGet(path) {
  const token = await getValidAccessToken();
  const res = await fetch(API_BASE + path, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (res.status === 204) return null; // es. nessuna riproduzione attiva
  if (!res.ok) throw new Error(`Spotify API ${path} -> HTTP ${res.status}`);
  return res.json();
}

async function getCurrentlyPlaying() {
  // /me/player, a differenza di /currently-playing, include anche il
  // dispositivo Spotify Connect attivo.
  const data = await apiGet("/me/player");
  if (!data || !data.item) return null;
  return {
    isPlaying: data.is_playing,
    progressMs: data.progress_ms,
    durationMs: data.item.duration_ms,
    title: data.item.name,
    artists: data.item.artists.map((a) => a.name).join(", "),
    album: data.item.album.name,
    albumArt: data.item.album.images[0] ? data.item.album.images[0].url : null,
    device: data.device ? {
      id: data.device.id || null,
      name: data.device.name || "Dispositivo sconosciuto",
      type: data.device.type || null,
      volumePercent: data.device.volume_percent
    } : null
  };
}

async function getPlaylists() {
  const data = await apiGet("/me/playlists?limit=20");
  if (!data) return [];
  return data.items.map((p) => ({
    id: p.id,
    name: p.name,
    image: p.images[0] ? p.images[0].url : null,
    tracksTotal: p.tracks.total
  }));
}

async function getPlaylistTracks(playlistId) {
  const data = await apiGet(`/playlists/${playlistId}/tracks?limit=50`);
  if (!data) return [];
  return data.items
    .filter((it) => it.track)
    .map((it) => ({
      title: it.track.name,
      artists: it.track.artists.map((a) => a.name).join(", "),
      durationMs: it.track.duration_ms
    }));
}

module.exports = {
  configure,
  buildAuthUrl,
  exchangeCode,
  isAuthenticated,
  logout,
  getCurrentlyPlaying,
  getPlaylists,
  getPlaylistTracks
};
