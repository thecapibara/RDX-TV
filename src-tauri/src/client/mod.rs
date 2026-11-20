pub mod anubis;

use std::collections::{BTreeMap, HashMap};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, COOKIE, REFERER, USER_AGENT};
use reqwest::{Client, Method, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;
use anubis::AnubisSolver;

/// Single source of truth for the browser identity used by *both* the `reqwest`
/// HTTP layer and the Captcha Bridge WebView.
///
/// This MUST stay identical for the two layers: Cloudflare binds `cf_clearance`
/// to the exact `User-Agent` (and IP) that solved the challenge. If the bridge
/// WebView reports a different UA than our HTTP client, the `cf_clearance`
/// cookie extracted from the WebView is silently rejected by the origin
/// (`403` forever), so the whole Captcha Bridge loop breaks.
pub const DEFAULT_USER_AGENT: &str =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

/// Cookie names that carry the anti-bot / session state we must mirror from the
/// Captcha Bridge WebView into the persistent store.
pub fn is_session_cookie(name: &str) -> bool {
    matches!(
        name,
        "cf_clearance"
            | "PHPSESSID"
            | "dle_user_id"
            | "dle_password"
            | "dle_user_token"
            | "dle_user_taken"
    ) || name.starts_with("techaro.lol-anubis-auth")
        || name.starts_with("techaro.lol-anubis-cookie-verification")
}

/// Typed error returned by the anti-bot HTTP layer.
///
/// It is boxed into `Box<dyn Error + Send + Sync>` (the historical signature of
/// `execute_with_anti_bot`), so callers that care can `downcast_ref` it while
/// the rest of the codebase keeps using `e.to_string()`.
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    /// The origin answered with a Cloudflare / WAF challenge that can only be
    /// solved interactively through the Captcha Bridge WebView.
    #[error("captcha required for mirror {mirror}")]
    CaptchaRequired { mirror: String },
    /// Anubis proof-of-work challenge could not be solved (iteration/time budget
    /// exhausted) or kept reappearing after several fresh attempts.
    #[error("anubis challenge could not be solved for mirror {mirror}")]
    AnubisFailed { mirror: String },
    /// The redirect chain exceeded [`MAX_REDIRECTS`] hops.
    #[error("too many redirects while fetching {url}")]
    TooManyRedirects { url: String },
}

/// Heuristically detects a Cloudflare interstitials / managed challenge.
///
/// * `cf-mitigated: challenge` is the authoritative signal added by CF.
/// * Strong body markers (`_cf_chl_opt`, `challenge-platform`, `cf-chl`) appear
///   only on the challenge page itself.
/// * Weak markers (`Just a moment`, `turnstile`) legitimately appear inside some
///   normal pages (e.g. a login form with a Turnstile widget), so they only
///   count when the response is an error status (403/503).
pub fn is_cloudflare_challenge(status: StatusCode, headers: &HeaderMap, body: &str) -> bool {
    if let Some(value) = headers.get("cf-mitigated") {
        let value = value.to_str().unwrap_or("").to_ascii_lowercase();
        if value.contains("challenge") {
            return true;
        }
    }

    let body_lower = body.to_ascii_lowercase();
    let strong_marker = ["_cf_chl_opt", "challenge-platform", "cf-chl"]
        .iter()
        .any(|m| body_lower.contains(m));
    if strong_marker {
        return true;
    }

    let is_error_status = matches!(status.as_u16(), 403 | 503);
    is_error_status
        && ["just a moment", "turnstile"]
            .iter()
            .any(|m| body_lower.contains(m))
}

/// Unix timestamp (seconds) from which a stored cookie is considered expired.
/// Session cookies (no `Max-Age` / `Expires`) have no entry and live forever.
///
/// Ordered maps keep `cookies.json` stable across runs (no random hash order),
/// which makes diffs and manual inspection predictable.
pub type CookieExpiry = BTreeMap<String, BTreeMap<String, i64>>;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CookieStoreData {
    /// domain -> (cookie_name -> cookie_value)
    pub cookies: BTreeMap<String, BTreeMap<String, String>>,
    /// domain -> (cookie_name -> unix expiry timestamp).
    ///
    /// Kept in a side map (instead of wrapping every value) so `cookies.json`
    /// files written by older versions — which only contain `cookies` — keep
    /// deserializing without migration (`serde(default)` → every cookie eternal).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub expires: CookieExpiry,
}

/// Parses an HTTP `Expires` attribute value (`Wed, 21 Oct 2015 07:28:00 GMT`)
/// into a unix timestamp in seconds.
fn parse_http_date(value: &str) -> Option<i64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc2822(trimmed) {
        return Some(dt.timestamp());
    }
    if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(trimmed, "%a, %d %b %Y %H:%M:%S GMT") {
        return Some(naive.and_utc().timestamp());
    }
    // RFC 850 (`Sunday, 06-Nov-94 08:49:37 GMT`) — still emitted by some servers.
    if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(trimmed, "%A, %d-%b-%y %H:%M:%S GMT") {
        return Some(naive.and_utc().timestamp());
    }
    None
}

/// Parses a `Max-Age` attribute value (seconds from now) into an absolute
/// unix timestamp. Negative / zero values yield a timestamp in the past.
fn parse_max_age_attr(value: &str) -> Option<i64> {
    let secs = value.trim().parse::<i64>().ok()?;
    Some(chrono::Utc::now().timestamp().saturating_add(secs))
}

pub struct PersistentCookieStore {
    file_path: Option<PathBuf>,
    data: Mutex<CookieStoreData>,
}

impl PersistentCookieStore {
    pub fn new<P: AsRef<Path>>(file_path: Option<P>) -> Self {
        let mut store_data = CookieStoreData::default();
        let path_buf = file_path.map(|p| p.as_ref().to_path_buf());

        if let Some(ref path) = path_buf {
            if path.exists() {
                if let Ok(content) = std::fs::read_to_string(path) {
                    if let Ok(deserialized) = serde_json::from_str::<CookieStoreData>(&content) {
                        store_data = deserialized;
                    }
                }
            }
        }

        Self {
            file_path: path_buf,
            data: Mutex::new(store_data),
        }
    }

    pub fn in_memory() -> Self {
        Self::new::<PathBuf>(None)
    }

    fn persist(&self) {
        if let Some(ref path) = self.file_path {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(guard) = self.data.lock() {
                if let Ok(json) = serde_json::to_string_pretty(&*guard) {
                    // The cookie jar carries session/anti-bot tokens, so keep it
                    // private to the current user (0600) on Unix. `mode()` only
                    // applies on creation, hence the explicit chmod afterwards
                    // for jars written by older versions as 0644.
                    #[cfg(unix)]
                    {
                        use std::io::Write;
                        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

                        if let Ok(mut file) = std::fs::OpenOptions::new()
                            .create(true)
                            .write(true)
                            .truncate(true)
                            .mode(0o600)
                            .open(path)
                        {
                            let _ = file.write_all(json.as_bytes());
                            let _ = file.flush();
                            drop(file);
                            let _ = std::fs::set_permissions(
                                path,
                                std::fs::Permissions::from_mode(0o600),
                            );
                        }
                    }
                    #[cfg(not(unix))]
                    {
                        let _ = std::fs::write(path, json);
                    }
                }
            }
        }
    }

    /// Builds the `Cookie` request header for `url`, skipping (and pruning) any
    /// cookie whose stored expiry is in the past.
    pub fn get_cookie_header_for_url(&self, url: &Url) -> Option<String> {
        let host = url.host_str()?;
        let now = chrono::Utc::now().timestamp();

        let mut matching_cookies: BTreeMap<String, String> = BTreeMap::new();
        let mut removed_any = false;
        {
            let mut guard = self.data.lock().ok()?;
            let domains: Vec<String> = guard.cookies.keys().cloned().collect();

            for domain in domains {
                let matches_domain = if domain.starts_with('.') {
                    let suffix = &domain[1..];
                    host == suffix || host.ends_with(domain.as_str())
                } else {
                    host == domain || host.ends_with(&format!(".{}", domain))
                };

                if !matches_domain {
                    continue;
                }

                let mut expired = Vec::new();
                if let Some(cookies) = guard.cookies.get(&domain) {
                    for (k, v) in cookies {
                        let is_expired = guard
                            .expires
                            .get(&domain)
                            .and_then(|m| m.get(k))
                            .map(|ts| *ts <= now)
                            .unwrap_or(false);
                        if is_expired {
                            expired.push(k.clone());
                        } else {
                            matching_cookies.insert(k.clone(), v.clone());
                        }
                    }
                }

                if !expired.is_empty() {
                    if let Some(cookies) = guard.cookies.get_mut(&domain) {
                        for name in &expired {
                            cookies.remove(name);
                        }
                    }
                    let mut drop_expires_map = false;
                    if let Some(exp) = guard.expires.get_mut(&domain) {
                        for name in &expired {
                            exp.remove(name);
                        }
                        drop_expires_map = exp.is_empty();
                    }
                    if drop_expires_map {
                        guard.expires.remove(&domain);
                    }
                    removed_any = true;
                }
            }
        }

        if removed_any {
            self.persist();
        }

        if matching_cookies.is_empty() {
            None
        } else {
            let header_str = matching_cookies
                .into_iter()
                .map(|(k, v)| format!("{}={}", k, v))
                .collect::<Vec<_>>()
                .join("; ");
            Some(header_str)
        }
    }

    pub fn parse_and_store_response_cookies(&self, url: &Url, response: &Response) {
        let host = match url.host_str() {
            Some(h) => h.to_string(),
            None => return,
        };

        let now = chrono::Utc::now().timestamp();
        let mut changed = false;
        let mut guard = match self.data.lock() {
            Ok(g) => g,
            Err(_) => return,
        };

        for header in response.headers().get_all(reqwest::header::SET_COOKIE) {
            if let Ok(header_str) = header.to_str() {
                if let Some(cookie_part) = header_str.split(';').next() {
                    let mut parts = cookie_part.splitn(2, '=');
                    if let (Some(name), Some(value)) = (parts.next(), parts.next()) {
                        let name = name.trim().to_string();
                        let value = value.trim().to_string();

                        // Parse attributes (domain / Max-Age / Expires), case-insensitively.
                        let mut target_domain = host.clone();
                        let mut expires_at: Option<i64> = None;
                        let mut delete = false;
                        for attr in header_str.split(';').skip(1) {
                            let mut attr_parts = attr.trim().splitn(2, '=');
                            if let (Some(attr_name), Some(attr_val)) = (attr_parts.next(), attr_parts.next()) {
                                match attr_name.trim().to_lowercase().as_str() {
                                    "domain" => {
                                        target_domain = attr_val.trim().trim_start_matches('.').to_string();
                                    }
                                    "max-age" => {
                                        let ts = parse_max_age_attr(attr_val);
                                        if ts.map(|t| t <= now).unwrap_or(false) {
                                            delete = true;
                                        }
                                        if expires_at.is_none() {
                                            expires_at = ts;
                                        }
                                    }
                                    "expires" => {
                                        let ts = parse_http_date(attr_val);
                                        if ts.map(|t| t <= now).unwrap_or(false) {
                                            delete = true;
                                        }
                                        if expires_at.is_none() {
                                            expires_at = ts;
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }

                        if value.is_empty() {
                            delete = true;
                        }

                        if delete {
                            if let Some(domain_map) = guard.cookies.get_mut(&target_domain) {
                                domain_map.remove(&name);
                            }
                            let mut drop_expires_map = false;
                            if let Some(exp) = guard.expires.get_mut(&target_domain) {
                                exp.remove(&name);
                                drop_expires_map = exp.is_empty();
                            }
                            if drop_expires_map {
                                guard.expires.remove(&target_domain);
                            }
                        } else {
                            guard
                                .cookies
                                .entry(target_domain.clone())
                                .or_default()
                                .insert(name.clone(), value);
                            match expires_at {
                                Some(ts) => {
                                    guard
                                        .expires
                                        .entry(target_domain)
                                        .or_default()
                                        .insert(name, ts);
                                }
                                None => {
                                    if let Some(exp) = guard.expires.get_mut(&target_domain) {
                                        exp.remove(&name);
                                    }
                                }
                            }
                        }
                        changed = true;
                    }
                }
            }
        }

        drop(guard);
        if changed {
            self.persist();
        }
    }

    pub fn set_cookie(&self, domain: &str, name: &str, value: &str) {
        if let Ok(mut guard) = self.data.lock() {
            let domain_map = guard.cookies.entry(domain.to_string()).or_default();
            domain_map.insert(name.to_string(), value.to_string());
            // Explicitly provided cookies (Captcha Bridge WebView) are treated as
            // session cookies: any previously stored expiry is dropped.
            if let Some(exp) = guard.expires.get_mut(domain) {
                exp.remove(name);
                if exp.is_empty() {
                    guard.expires.remove(domain);
                }
            }
            drop(guard);
            self.persist();
        }
    }

    pub fn get_all_cookies(&self) -> BTreeMap<String, BTreeMap<String, String>> {
        self.data.lock().map(|g| g.cookies.clone()).unwrap_or_default()
    }
}

/// Callback invoked once per detected Cloudflare challenge (already debounced).
pub type CaptchaNotifier = Arc<dyn Fn(&str) + Send + Sync>;

pub struct HttpClient {
    client: RwLock<Client>,
    no_redirect_client: RwLock<Client>,
    doh_client: Client,
    /// host -> Some(ip) if resolved via DoH (ISP DNS blocked/spoofed), None if system DNS is clean
    doh_cache: Mutex<HashMap<String, Option<IpAddr>>>,
    proxy_url: Mutex<Option<String>>,
    cookie_store: Arc<PersistentCookieStore>,
    user_agent: RwLock<String>,
    /// Optional sink for `captcha-required` notifications (wired to the Tauri
    /// event loop in `lib.rs::setup`, so `client/` stays free of Tauri deps).
    captcha_notifier: Mutex<Option<CaptchaNotifier>>,
    last_captcha_notify: Mutex<Option<(String, Instant)>>,
}

/// Minimum delay between two `captcha-required` notifications for the same mirror.
const CAPTCHA_NOTIFY_DEBOUNCE: Duration = Duration::from_secs(15);

/// Maximum number of redirect hops followed by `execute_with_anti_bot`.
///
/// This mirrors the `reqwest::redirect::Policy::limited(10)` behaviour that used
/// to run inside the client, but every hop is now issued manually through the
/// no-redirect client so `Set-Cookie` headers on 30x responses are persisted
/// (mirrors frequently set session cookies in the middle of a redirect chain).
const MAX_REDIRECTS: usize = 10;

/// Maximum number of Anubis solve+retry rounds for a single HTTP request.
const MAX_ANUBIS_ATTEMPTS: usize = 3;
/// Pause between two Anubis rounds (fresh challenge, fresh pass-challenge call).
const ANUBIS_RETRY_DELAY: Duration = Duration::from_millis(300);
/// Hard wall-clock cap for a single PoW search running on the blocking pool.
const ANUBIS_SOLVE_TIMEOUT: Duration = Duration::from_secs(30);

impl HttpClient {
    pub fn new(cookie_store: Arc<PersistentCookieStore>, proxy_url: Option<&str>) -> reqwest::Result<Self> {
        let proxy_clean = proxy_url
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let (client, no_redirect_client) = Self::build_clients(proxy_clean.as_deref(), &HashMap::new())?;
        let doh_client = Client::builder()
            .timeout(Duration::from_secs(5))
            .connect_timeout(Duration::from_secs(3))
            .tcp_nodelay(true)
            .pool_max_idle_per_host(8)
            .pool_idle_timeout(Duration::from_secs(90))
            .build()?;

        Ok(Self {
            client: RwLock::new(client),
            no_redirect_client: RwLock::new(no_redirect_client),
            doh_client,
            doh_cache: Mutex::new(HashMap::new()),
            proxy_url: Mutex::new(proxy_clean),
            cookie_store,
            user_agent: RwLock::new(DEFAULT_USER_AGENT.to_string()),
            captcha_notifier: Mutex::new(None),
            last_captcha_notify: Mutex::new(None),
        })
    }

    /// Current browser identity shared with the Captcha Bridge WebView.
    pub fn user_agent(&self) -> String {
        self.user_agent
            .read()
            .map(|g| g.clone())
            .unwrap_or_else(|_| DEFAULT_USER_AGENT.to_string())
    }

    /// Overrides the browser identity (e.g. to mirror a custom WebView UA).
    /// Changing it invalidates previously obtained `cf_clearance` cookies.
    pub fn set_user_agent(&self, ua: &str) {
        let trimmed = ua.trim();
        if trimmed.is_empty() {
            return;
        }
        if let Ok(mut guard) = self.user_agent.write() {
            *guard = trimmed.to_string();
        }
    }

    /// Registers the `captcha-required` sink (see `lib.rs`).
    pub fn set_captcha_notifier<F>(&self, notifier: F)
    where
        F: Fn(&str) + Send + Sync + 'static,
    {
        if let Ok(mut guard) = self.captcha_notifier.lock() {
            *guard = Some(Arc::new(notifier));
        }
    }

    /// Fires the `captcha-required` sink, debounced per mirror so a burst of
    /// failing requests does not spam the UI.
    fn notify_captcha(&self, mirror: &str) {
        let now = Instant::now();
        {
            let Ok(mut guard) = self.last_captcha_notify.lock() else {
                return;
            };
            if let Some((last_mirror, last_at)) = guard.as_ref() {
                if last_mirror == mirror
                    && now
                        .checked_duration_since(*last_at)
                        .map(|d| d < CAPTCHA_NOTIFY_DEBOUNCE)
                        .unwrap_or(false)
                {
                    return;
                }
            }
            *guard = Some((mirror.to_string(), now));
        }

        let notifier = self.captcha_notifier.lock().ok().and_then(|g| g.clone());
        if let Some(notifier) = notifier {
            notifier(mirror);
        }
    }

    fn build_clients(
        proxy_url: Option<&str>,
        doh_overrides: &HashMap<String, Option<IpAddr>>,
    ) -> reqwest::Result<(Client, Client)> {
        let mut builder = Client::builder()
            .timeout(Duration::from_secs(20))
            .connect_timeout(Duration::from_secs(12))
            .max_tls_version(reqwest::tls::Version::TLS_1_2)
            .tcp_nodelay(true)
            .pool_max_idle_per_host(16)
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::limited(10));

        let mut no_redirect_builder = Client::builder()
            .timeout(Duration::from_secs(20))
            .connect_timeout(Duration::from_secs(12))
            .max_tls_version(reqwest::tls::Version::TLS_1_2)
            .tcp_nodelay(true)
            .pool_max_idle_per_host(16)
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none());

        for (host, maybe_ip) in doh_overrides {
            if let Some(ip) = maybe_ip {
                let addr = SocketAddr::new(*ip, 443);
                builder = builder.resolve(host, addr);
                no_redirect_builder = no_redirect_builder.resolve(host, addr);
            }
        }

        if let Some(proxy) = proxy_url {
            if !proxy.trim().is_empty() {
                if let Ok(p) = reqwest::Proxy::all(proxy) {
                    builder = builder.proxy(p.clone());
                    no_redirect_builder = no_redirect_builder.proxy(p);
                }
            }
        }

        Ok((builder.build()?, no_redirect_builder.build()?))
    }

    fn rebuild_clients(&self) {
        let proxy = self.proxy_url.lock().ok().and_then(|g| g.clone());
        let cache = self.doh_cache.lock().map(|g| g.clone()).unwrap_or_default();
        if let Ok((c, nrc)) = Self::build_clients(proxy.as_deref(), &cache) {
            if let Ok(mut w) = self.client.write() {
                *w = c;
            }
            if let Ok(mut w) = self.no_redirect_client.write() {
                *w = nrc;
            }
        }
    }

    pub fn set_proxy(&self, proxy_url: Option<&str>) {
        let clean = proxy_url
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        if let Ok(mut g) = self.proxy_url.lock() {
            *g = clean;
        }
        self.rebuild_clients();
    }

    pub fn is_doh_routed(&self, host: &str) -> bool {
        self.doh_cache
            .lock()
            .ok()
            .and_then(|g| g.get(host).copied().flatten())
            .is_some()
    }

    fn is_valid_public_ip(ip: &IpAddr) -> bool {
        match ip {
            IpAddr::V4(v4) => {
                !v4.is_loopback()
                    && !v4.is_unspecified()
                    && !v4.is_private()
                    && !v4.is_link_local()
                    && v4.octets()[0] != 0
            }
            IpAddr::V6(v6) => !v6.is_loopback() && !v6.is_unspecified(),
        }
    }

    /// Ensures a single host is checked against system DNS and falls back to DoH if ISP-spoofed (e.g. 127.0.0.1)
    pub async fn ensure_host_resolved(&self, host: &str) {
        if host.is_empty() || host.parse::<IpAddr>().is_ok() {
            return;
        }
        let already_known = self
            .doh_cache
            .lock()
            .ok()
            .map(|g| g.contains_key(host))
            .unwrap_or(false);
        if already_known {
            return;
        }

        self.ensure_hosts_resolved(&[host.to_string()]).await;
    }

    /// Batch-resolves multiple hosts in parallel and rebuilds the HTTP client once if any DoH overrides were added
    pub async fn ensure_hosts_resolved(&self, hosts: &[String]) {
        let mut unknown_hosts = Vec::new();
        if let Ok(guard) = self.doh_cache.lock() {
            for h in hosts {
                let h_trim = h.trim().to_lowercase();
                if !h_trim.is_empty()
                    && h_trim.parse::<IpAddr>().is_err()
                    && !guard.contains_key(&h_trim)
                    && !unknown_hosts.contains(&h_trim)
                {
                    unknown_hosts.push(h_trim);
                }
            }
        }

        if unknown_hosts.is_empty() {
            return;
        }

        let mut join_set = tokio::task::JoinSet::new();
        for host in unknown_hosts {
            let doh_client = self.doh_client.clone();
            join_set.spawn(async move {
                // 1. Check what local ISP DNS returns (may be 127.0.0.1, NXDOMAIN, or an ISP block-page IP!)
                let sys_ips: Vec<IpAddr> = match tokio::time::timeout(
                    Duration::from_millis(1000),
                    tokio::net::lookup_host((host.as_str(), 443)),
                )
                .await
                {
                    Ok(Ok(addrs)) => addrs
                        .map(|a| a.ip())
                        .filter(|ip| Self::is_valid_public_ip(ip))
                        .collect(),
                    _ => Vec::new(),
                };

                // 2. Always query independent DoH (by direct IP literals 1.1.1.1 / 8.8.8.8 + hostnames)
                // so even ISP redirects to public block-page IPs are bypassed universally
                let endpoints = [
                    format!("https://1.1.1.1/dns-query?name={}&type=A", host),
                    format!("https://8.8.8.8/resolve?name={}&type=A", host),
                    format!("https://cloudflare-dns.com/dns-query?name={}&type=A", host),
                ];
                let mut doh_ip = None;
                for ep in &endpoints {
                    if let Ok(resp) = doh_client
                        .get(ep)
                        .header(ACCEPT, "application/dns-json")
                        .send()
                        .await
                    {
                        if let Ok(json) = resp.json::<Value>().await {
                            if let Some(answers) = json.get("Answer").and_then(|v| v.as_array()) {
                                for ans in answers {
                                    if ans.get("type").and_then(|v| v.as_u64()) == Some(1) {
                                        if let Some(ip_str) = ans.get("data").and_then(|v| v.as_str()) {
                                            if let Ok(ip) = ip_str.trim().parse::<IpAddr>() {
                                                if Self::is_valid_public_ip(&ip) {
                                                    doh_ip = Some(ip);
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if doh_ip.is_some() {
                        break;
                    }
                }

                // If ISP DNS did not return the authentic DoH IP (e.g. returned 127.0.0.1, NXDOMAIN, or ISP block page),
                // activate DoH override for this domain.
                match doh_ip {
                    Some(real_ip) if !sys_ips.contains(&real_ip) => (host, Some(real_ip)),
                    _ => (host, None),
                }
            });
        }

        let mut added_doh_override = false;
        let mut results = Vec::new();
        while let Some(Ok((host, maybe_ip))) = join_set.join_next().await {
            if maybe_ip.is_some() {
                added_doh_override = true;
            }
            results.push((host, maybe_ip));
        }

        if let Ok(mut guard) = self.doh_cache.lock() {
            for (h, maybe_ip) in results {
                guard.insert(h, maybe_ip);
            }
        }

        if added_doh_override {
            self.rebuild_clients();
        }
    }

    pub fn cookie_store(&self) -> &Arc<PersistentCookieStore> {
        &self.cookie_store
    }

    pub fn get_reqwest_client(&self) -> Client {
        self.current_reqwest()
    }

    /// Clone of the live `reqwest::Client`, including DoH host overrides and the
    /// active proxy. Callers that outlive a single request (e.g. the Turbo proxy)
    /// must fetch it per request so later `rebuild_clients` are picked up.
    pub fn current_reqwest(&self) -> Client {
        self.get_client()
    }

    fn get_client(&self) -> Client {
        self.client.read().unwrap().clone()
    }

    fn get_no_redirect_client(&self) -> Client {
        self.no_redirect_client.read().unwrap().clone()
    }

    fn prepare_headers(&self, url: &Url, referer: Option<&str>, is_ajax: bool) -> HeaderMap {
        let mut headers = HeaderMap::new();

        let user_agent = self.user_agent();
        headers.insert(
            USER_AGENT,
            HeaderValue::from_str(&user_agent).unwrap_or(HeaderValue::from_static("Mozilla/5.0")),
        );
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"),
        );
        headers.insert(
            ACCEPT_LANGUAGE,
            HeaderValue::from_static("uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7"),
        );

        if let Some(ref_str) = referer {
            if let Ok(ref_val) = HeaderValue::from_str(ref_str) {
                headers.insert(REFERER, ref_val);
            }
        }

        if is_ajax {
            headers.insert("X-Requested-With", HeaderValue::from_static("XMLHttpRequest"));
        }

        if let Some(cookie_hdr) = self.cookie_store.get_cookie_header_for_url(url) {
            if let Ok(cookie_val) = HeaderValue::from_str(&cookie_hdr) {
                headers.insert(COOKIE, cookie_val);
            }
        }

        headers
    }

    fn is_redirect_status(status: StatusCode) -> bool {
        matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
    }

    /// Sends a request and follows up to [`MAX_REDIRECTS`] hops manually with the
    /// no-redirect client, persisting `Set-Cookie` from **every** hop (30x
    /// responses included) into the persistent cookie store.
    ///
    /// Method rewriting matches `reqwest`/browser semantics: `303` always
    /// becomes `GET`, `301`/`302` downgrade `POST` to `GET`, `307`/`308` keep
    /// the method and body.
    async fn send_following_redirects(
        &self,
        method: Method,
        initial_url: Url,
        form_params: Option<&[(&str, &str)]>,
        referer: Option<&str>,
        is_ajax: bool,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        let mut url = initial_url;
        let mut method = method;
        let mut referer = referer.map(str::to_string);
        let mut use_form = form_params.is_some();

        for hop in 0..=MAX_REDIRECTS {
            // Redirect targets may live on other (possibly ISP-blocked) hosts.
            if let Some(host) = url.host_str() {
                self.ensure_host_resolved(host).await;
            }

            // Fetch the live client per hop: the DoH check above may have rebuilt
            // the underlying clients.
            let client = self.get_no_redirect_client();
            let headers = self.prepare_headers(&url, referer.as_deref(), is_ajax);
            let mut request = client.request(method.clone(), url.clone()).headers(headers);
            if let (true, Some(params)) = (use_form, form_params) {
                request = request.form(params);
            }

            let response = request.send().await?;
            // Persist cookies from *this* hop before deciding whether to follow,
            // so 30x `Set-Cookie` headers make it into the jar.
            self.cookie_store
                .parse_and_store_response_cookies(&url, &response);

            let status = response.status();
            if !Self::is_redirect_status(status) {
                return Ok(response);
            }

            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let Some(location) = location else {
                // A redirect without `Location` cannot be followed; hand the
                // response back untouched.
                return Ok(response);
            };

            if hop == MAX_REDIRECTS {
                return Err(Box::new(ClientError::TooManyRedirects {
                    url: url.to_string(),
                }));
            }

            let next_url = url.join(&location)?;

            match status.as_u16() {
                303 => {
                    method = Method::GET;
                    use_form = false;
                }
                301 | 302 => {
                    if method == Method::POST {
                        method = Method::GET;
                    }
                    use_form = false;
                }
                // 307 / 308 preserve both method and body.
                _ => {}
            }

            referer = Some(url.to_string());
            url = next_url;
        }

        unreachable!("redirect loop returns within MAX_REDIRECTS + 1 hops")
    }

    /// Executes an HTTP request with automatic DoH anti-blocking + Anubis PoW solving
    pub async fn execute_with_anti_bot(
        &self,
        method: Method,
        url_str: &str,
        form_params: Option<&[(&str, &str)]>,
        referer: Option<&str>,
        is_ajax: bool,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        let target_url = Url::parse(url_str)?;
        if let Some(host) = target_url.host_str() {
            self.ensure_host_resolved(host).await;
        }

        let mirror = format!(
            "{}://{}",
            target_url.scheme(),
            target_url.host_str().unwrap_or_default()
        );

        // Anubis may hand out a *fresh* challenge even after a "solved" pass
        // (rotation, clock skew, wrong cookie), so retry the whole solve loop a
        // bounded number of times before surfacing an error.
        let mut anubis_attempts: usize = 0;

        loop {
            // Redirects are followed manually so `Set-Cookie` from intermediate
            // 30x responses is captured (see `send_following_redirects`).
            let resp = self
                .send_following_redirects(
                    method.clone(),
                    target_url.clone(),
                    form_params,
                    referer,
                    is_ajax,
                )
                .await?;

            let status = resp.status();
            if !(status.is_success() || status.as_u16() == 403 || status.as_u16() == 503) {
                return Ok(resp);
            }

            let response_headers = resp.headers().clone();
            let content_type = response_headers
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_ascii_lowercase();

            // Cloudflare and Anubis challenge pages are always HTML. Any other
            // content type is returned as-is so the (possibly streaming) body is
            // not buffered for nothing.
            if !content_type.contains("text/html") {
                return Ok(resp);
            }

            let body_bytes = resp.bytes().await?;
            let body_str = String::from_utf8_lossy(&body_bytes);

            if AnubisSolver::is_anubis_challenge(&body_str) {
                if let Some(challenge_payload) = AnubisSolver::extract_challenge(&body_str) {
                    if anubis_attempts >= MAX_ANUBIS_ATTEMPTS {
                        eprintln!(
                            "[RDX Client] Anubis challenge still present after {} attempts: {}",
                            anubis_attempts, url_str
                        );
                        return Err(Box::new(ClientError::AnubisFailed { mirror }));
                    }
                    anubis_attempts += 1;

                    let Some(solution) = Self::solve_anubis_off_thread(challenge_payload).await else {
                        return Err(Box::new(ClientError::AnubisFailed { mirror }));
                    };

                    // Submit pass-challenge request
                    let base_origin = format!("{}://{}", target_url.scheme(), target_url.host_str().unwrap_or(""));
                    let redir_path = target_url.path();
                    let redir_query = target_url.query().map(|q| format!("?{}", q)).unwrap_or_default();
                    let redir = if redir_path.is_empty() {
                        "/".to_string()
                    } else {
                        format!("{}{}", redir_path, redir_query)
                    };

                    let pass_url_str = format!(
                        "{}/.within.website/x/cmd/anubis/api/pass-challenge?id={}&response={}&nonce={}&redir={}&elapsedTime={}",
                        base_origin,
                        solution.challenge_id,
                        solution.response_hash,
                        solution.nonce,
                        urlencoding::encode(&redir),
                        AnubisSolver::clamp_elapsed_ms(solution.elapsed_ms)
                    );

                    let pass_url = Url::parse(&pass_url_str)?;
                    let pass_headers = self.prepare_headers(&pass_url, Some(url_str), false);
                    let no_redir_client = self.get_no_redirect_client();
                    let pass_resp = no_redir_client.get(pass_url.clone()).headers(pass_headers).send().await?;
                    self.cookie_store.parse_and_store_response_cookies(&pass_url, &pass_resp);

                    // Small back-off so a mis-behaving origin is not hammered.
                    tokio::time::sleep(ANUBIS_RETRY_DELAY).await;
                    continue;
                }
            }

            // Cloudflare / WAF managed challenge: only the interactive Captcha
            // Bridge WebView can solve it, so surface a typed error the commands
            // layer (and the UI banner) can react to.
            if is_cloudflare_challenge(status, &response_headers, &body_str) {
                self.notify_captcha(&mirror);
                return Err(Box::new(ClientError::CaptchaRequired { mirror }));
            }

            // Not a challenge: rebuild a response from the buffered bytes so the
            // caller can read it. Every header is preserved (status alone used to
            // be carried over, which dropped Content-Type and friends); the
            // length is recomputed because gzip decoding may have changed it.
            let mut builder = http::Response::builder().status(status);
            for (name, value) in response_headers.iter() {
                if name == reqwest::header::CONTENT_LENGTH
                    || name == reqwest::header::TRANSFER_ENCODING
                    || name == reqwest::header::CONTENT_ENCODING
                {
                    continue;
                }
                builder = builder.header(name.clone(), value.clone());
            }
            let final_resp = builder
                .header(
                    reqwest::header::CONTENT_LENGTH,
                    body_bytes.len().to_string(),
                )
                .body(body_bytes)?;
            return Ok(Response::from(final_resp));
        }
    }

    /// Runs the CPU-bound PoW search on the blocking pool with a hard timeout so
    /// the async runtime is never stalled and a hostile difficulty cannot hang
    /// the request forever.
    async fn solve_anubis_off_thread(
        challenge: anubis::AnubisChallengePayload,
    ) -> Option<anubis::AnubisSolution> {
        let handle = tokio::task::spawn_blocking(move || AnubisSolver::solve(&challenge));
        match tokio::time::timeout(ANUBIS_SOLVE_TIMEOUT, handle).await {
            Ok(Ok(solution)) if solution.solved => Some(solution),
            Ok(Ok(_)) => {
                eprintln!(
                    "[RDX Client] Anubis PoW not solved (unsupported algorithm or attempt budget exhausted)"
                );
                None
            }
            Ok(Err(e)) => {
                eprintln!("[RDX Client] Anubis solver task failed: {e}");
                None
            }
            Err(_) => {
                eprintln!(
                    "[RDX Client] Anubis PoW timed out after {:?}",
                    ANUBIS_SOLVE_TIMEOUT
                );
                None
            }
        }
    }

    pub async fn get_html(&self, url: &str, referer: Option<&str>) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let resp = self.execute_with_anti_bot(Method::GET, url, None, referer, false).await?;
        let text = resp.text().await?;
        Ok(text)
    }

    pub async fn post_ajax(
        &self,
        url: &str,
        params: &[(&str, &str)],
        referer: Option<&str>,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let resp = self.execute_with_anti_bot(Method::POST, url, Some(params), referer, true).await?;
        let text = resp.text().await?;
        Ok(text)
    }
}

pub fn default_cookie_path() -> PathBuf {
    if let Some(mut dir) = dirs::data_dir() {
        dir.push("rdx");
        dir.push("cookies.json");
        dir
    } else {
        PathBuf::from("cookies.json")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn header_map(name: &str, value: &str) -> HeaderMap {
        let mut map = HeaderMap::new();
        map.insert(
            reqwest::header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
            HeaderValue::from_str(value).unwrap(),
        );
        map
    }

    #[test]
    fn test_is_session_cookie_filters_anti_bot_state() {
        for name in [
            "cf_clearance",
            "PHPSESSID",
            "dle_user_id",
            "dle_password",
            "dle_user_token",
            "dle_user_taken",
            "techaro.lol-anubis-auth",
            "techaro.lol-anubis-auth-token",
            "techaro.lol-anubis-cookie-verification",
        ] {
            assert!(is_session_cookie(name), "expected {name} to be captured");
        }

        for name in ["_ga", "dle_cookie", "some_random", "anubis"] {
            assert!(!is_session_cookie(name), "expected {name} to be ignored");
        }
    }

    #[test]
    fn test_is_cloudflare_challenge_via_header() {
        let headers = header_map("cf-mitigated", "challenge");
        assert!(is_cloudflare_challenge(StatusCode::FORBIDDEN, &headers, ""));
    }

    #[test]
    fn test_is_cloudflare_challenge_via_strong_body_marker() {
        assert!(is_cloudflare_challenge(
            StatusCode::OK,
            &HeaderMap::new(),
            "<html><script src=\"/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1\"></script></html>"
        ));
        assert!(is_cloudflare_challenge(
            StatusCode::FORBIDDEN,
            &HeaderMap::new(),
            "var _cf_chl_opt = {};"
        ));
        assert!(is_cloudflare_challenge(
            StatusCode::SERVICE_UNAVAILABLE,
            &HeaderMap::new(),
            "window._cf_chl_opt={}"
        ));
    }

    #[test]
    fn test_is_cloudflare_challenge_weak_markers_require_error_status() {
        let turnstile_page = "<div class=\"cf-turnstile\" data-sitekey=\"x\"></div>Just a moment...";

        // Error statuses → challenge
        assert!(is_cloudflare_challenge(StatusCode::FORBIDDEN, &HeaderMap::new(), turnstile_page));
        assert!(is_cloudflare_challenge(
            StatusCode::SERVICE_UNAVAILABLE,
            &HeaderMap::new(),
            turnstile_page
        ));

        // A normal 200 page embedding a Turnstile widget is *not* a challenge
        assert!(!is_cloudflare_challenge(StatusCode::OK, &HeaderMap::new(), turnstile_page));
    }

    #[test]
    fn test_is_cloudflare_challenge_negative() {
        assert!(!is_cloudflare_challenge(
            StatusCode::OK,
            &HeaderMap::new(),
            "<html><body>b-content__inline_item</body></html>"
        ));
        assert!(!is_cloudflare_challenge(
            StatusCode::NOT_FOUND,
            &HeaderMap::new(),
            "Not Found"
        ));
    }

    #[test]
    fn test_client_error_downcasts_from_boxed_error() {
        let boxed: Box<dyn std::error::Error + Send + Sync> =
            Box::new(ClientError::CaptchaRequired { mirror: "https://rezka-tv.org".into() });
        assert_eq!(boxed.to_string(), "captcha required for mirror https://rezka-tv.org");
        match boxed.downcast_ref::<ClientError>() {
            Some(ClientError::CaptchaRequired { mirror }) => assert_eq!(mirror, "https://rezka-tv.org"),
            other => panic!("expected ClientError::CaptchaRequired, got {other:?}"),
        }
    }

    #[test]
    fn test_anubis_failed_error_preserves_variant() {
        let boxed: Box<dyn std::error::Error + Send + Sync> =
            Box::new(ClientError::AnubisFailed { mirror: "https://rezka-tv.org".into() });
        assert_eq!(
            boxed.to_string(),
            "anubis challenge could not be solved for mirror https://rezka-tv.org"
        );
        assert!(matches!(
            boxed.downcast_ref::<ClientError>(),
            Some(ClientError::AnubisFailed { .. })
        ));
    }

    #[test]
    fn test_user_agent_getter_setter_and_empty_guard() {
        let client = HttpClient::new(Arc::new(PersistentCookieStore::in_memory()), None).unwrap();
        assert_eq!(client.user_agent(), DEFAULT_USER_AGENT);

        client.set_user_agent("  Mozilla/5.0 (X11; Linux x86_64) TestUA/1.0  ");
        assert_eq!(client.user_agent(), "Mozilla/5.0 (X11; Linux x86_64) TestUA/1.0");

        client.set_user_agent("   ");
        assert_eq!(client.user_agent(), "Mozilla/5.0 (X11; Linux x86_64) TestUA/1.0");
    }

    #[test]
    fn test_captcha_notifier_is_debounced_per_mirror() {
        let client = HttpClient::new(Arc::new(PersistentCookieStore::in_memory()), None).unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_clone = hits.clone();
        client.set_captcha_notifier(move |_mirror| {
            hits_clone.fetch_add(1, Ordering::SeqCst);
        });

        client.notify_captcha("https://rezka-tv.org");
        client.notify_captcha("https://rezka-tv.org"); // debounced
        assert_eq!(hits.load(Ordering::SeqCst), 1);

        client.notify_captcha("https://hdrezka.me"); // other mirror
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    fn response_with_set_cookie(values: &[&str]) -> Response {
        let mut builder = http::Response::builder().status(200);
        for value in values {
            builder = builder.header(reqwest::header::SET_COOKIE, *value);
        }
        let resp = builder.body(bytes::Bytes::new()).expect("build http response");
        Response::from(resp)
    }

    fn url(raw: &str) -> Url {
        Url::parse(raw).expect("valid url")
    }

    #[test]
    fn test_parse_http_date_formats() {
        // RFC 1123 (standard HTTP date)
        assert_eq!(
            parse_http_date("Wed, 21 Oct 2015 07:28:00 GMT"),
            Some(1_445_412_480)
        );
        // Case / whitespace tolerant
        assert!(parse_http_date("  Wed, 21 Oct 2015 07:28:00 GMT ").is_some());
        // Garbage / empty
        assert_eq!(parse_http_date(""), None);
        assert_eq!(parse_http_date("not-a-date"), None);
    }

    #[test]
    fn test_cookie_store_deserializes_legacy_format_without_expiry() {
        let legacy = r#"{"cookies":{"rezka-tv.org":{"PHPSESSID":"abc"}}}"#;
        let data: CookieStoreData = serde_json::from_str(legacy).expect("legacy json");
        assert_eq!(data.cookies["rezka-tv.org"]["PHPSESSID"], "abc");
        assert!(data.expires.is_empty(), "legacy cookies must be treated as eternal");
    }

    #[test]
    fn test_cookie_header_order_is_deterministic() {
        let store = PersistentCookieStore::in_memory();
        // Insert in reverse-alphabetical order to prove the header is sorted.
        store.set_cookie("rezka-tv.org", "PHPSESSID", "1");
        store.set_cookie("rezka-tv.org", "dle_user_id", "2");
        store.set_cookie("rezka-tv.org", "cf_clearance", "3");

        let header = store
            .get_cookie_header_for_url(&url("https://rezka-tv.org/"))
            .expect("cookie header");
        assert_eq!(header, "PHPSESSID=1; cf_clearance=3; dle_user_id=2");

        // Same result on a second call (no hash-map randomness).
        assert_eq!(
            store
                .get_cookie_header_for_url(&url("https://rezka-tv.org/"))
                .expect("cookie header"),
            header
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_cookie_jar_is_written_with_0600_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("rdx-cookie-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("cookies.json");

        // Pre-existing world-readable jar (as written by older versions).
        std::fs::write(&path, "{}").expect("seed jar");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
            .expect("seed perms");

        let store = PersistentCookieStore::new(Some(&path));
        store.set_cookie("rezka-tv.org", "PHPSESSID", "abc");

        let mode = std::fs::metadata(&path)
            .expect("cookie jar")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "cookie jar must be private, got {mode:o}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Minimal one-shot HTTP/1.1 server used by the redirect tests below.
    async fn spawn_one_shot_server(response: String) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let addr = listener.local_addr().expect("test server addr");

        tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut buf = [0u8; 2048];
            let _ = socket.read(&mut buf).await;
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.shutdown().await;
        });

        format!("http://{}/page", addr)
    }

    /// Two-hop server: `302` (with two `Set-Cookie` headers) → `/final` (200 + one cookie).
    async fn spawn_redirect_server() -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind redirect server");
        let addr = listener.local_addr().expect("redirect server addr");

        tokio::spawn(async move {
            for hop in 0..2 {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let mut buf = [0u8; 2048];
                let _ = socket.read(&mut buf).await;

                let response = if hop == 0 {
                    "HTTP/1.1 302 Found\r\n\
                     Location: /final\r\n\
                     Set-Cookie: PHPSESSID=from-redirect; Path=/\r\n\
                     Set-Cookie: cf_clearance=hop-1; Path=/\r\n\
                     Content-Length: 0\r\n\
                     Connection: close\r\n\r\n"
                        .to_string()
                } else {
                    "HTTP/1.1 200 OK\r\n\
                     Content-Type: text/html; charset=utf-8\r\n\
                     Set-Cookie: dle_user_id=final; Path=/\r\n\
                     Content-Length: 2\r\n\
                     Connection: close\r\n\r\nok"
                        .to_string()
                };

                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });

        format!("http://{}/start", addr)
    }

    #[tokio::test]
    async fn test_redirect_chain_persists_intermediate_set_cookie() {
        let start_url = spawn_redirect_server().await;
        let store = Arc::new(PersistentCookieStore::in_memory());
        let client = HttpClient::new(store.clone(), None).expect("client creation");

        let resp = client
            .execute_with_anti_bot(Method::GET, &start_url, None, None, false)
            .await
            .expect("redirected request");

        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.text().await.expect("body"), "ok");

        let host = url(&start_url).host_str().expect("host").to_string();
        let all = store.get_all_cookies();
        let jar = all.get(&host).expect("cookie jar for test host");
        assert_eq!(
            jar.get("PHPSESSID").map(String::as_str),
            Some("from-redirect"),
            "Set-Cookie from the 302 hop must be persisted: {jar:?}"
        );
        assert_eq!(jar.get("cf_clearance").map(String::as_str), Some("hop-1"));
        assert_eq!(jar.get("dle_user_id").map(String::as_str), Some("final"));
    }

    #[tokio::test]
    async fn test_redirect_chain_is_limited_to_ten_hops() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loop server");
        let addr = listener.local_addr().expect("loop server addr");
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_clone = hits.clone();

        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                hits_clone.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0u8; 2048];
                let _ = socket.read(&mut buf).await;
                let _ = socket
                    .write_all(
                        b"HTTP/1.1 302 Found\r\nLocation: /loop\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await;
                let _ = socket.shutdown().await;
            }
        });

        let client = HttpClient::new(Arc::new(PersistentCookieStore::in_memory()), None)
            .expect("client creation");
        let err = client
            .execute_with_anti_bot(Method::GET, &format!("http://{}/loop", addr), None, None, false)
            .await
            .expect_err("redirect loop must be rejected");

        assert!(
            err.to_string().contains("too many redirects"),
            "unexpected error: {err}"
        );
        assert_eq!(
            hits.load(Ordering::SeqCst),
            MAX_REDIRECTS + 1,
            "the client must follow at most {MAX_REDIRECTS} redirects"
        );
    }

    #[tokio::test]
    async fn test_non_html_response_is_returned_untouched() {
        let body = r#"{"success":true}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\n\
             Content-Type: application/json\r\n\
             X-Custom: kept\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let page_url = spawn_one_shot_server(response).await;
        let client = HttpClient::new(Arc::new(PersistentCookieStore::in_memory()), None)
            .expect("client creation");

        let resp = client
            .execute_with_anti_bot(Method::GET, &page_url, None, None, false)
            .await
            .expect("json request");

        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get("content-type").and_then(|v| v.to_str().ok()),
            Some("application/json")
        );
        assert_eq!(
            resp.headers().get("x-custom").and_then(|v| v.to_str().ok()),
            Some("kept")
        );
        assert_eq!(resp.text().await.expect("body"), body);
    }

    #[tokio::test]
    async fn test_html_rebuild_preserves_headers() {
        let body = "<html><body>b-content__inline_item</body></html>";
        let response = format!(
            "HTTP/1.1 200 OK\r\n\
             Content-Type: text/html; charset=utf-8\r\n\
             X-Custom: kept\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let page_url = spawn_one_shot_server(response).await;
        let client = HttpClient::new(Arc::new(PersistentCookieStore::in_memory()), None)
            .expect("client creation");

        let resp = client
            .execute_with_anti_bot(Method::GET, &page_url, None, None, false)
            .await
            .expect("html request");

        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get("content-type").and_then(|v| v.to_str().ok()),
            Some("text/html; charset=utf-8")
        );
        assert_eq!(
            resp.headers().get("x-custom").and_then(|v| v.to_str().ok()),
            Some("kept")
        );
        let expected_len = body.len().to_string();
        assert_eq!(
            resp.headers().get("content-length").and_then(|v| v.to_str().ok()),
            Some(expected_len.as_str())
        );
        assert_eq!(resp.text().await.expect("body"), body);
    }

    #[test]
    fn test_set_cookie_max_age_lowercase_deletes_cookie() {
        let store = PersistentCookieStore::in_memory();
        store.set_cookie("rezka-tv.org", "PHPSESSID", "abc");
        assert!(store
            .get_cookie_header_for_url(&url("https://rezka-tv.org/"))
            .unwrap()
            .contains("PHPSESSID=abc"));

        // Lowercase attribute name: previously silently ignored
        store.parse_and_store_response_cookies(
            &url("https://rezka-tv.org/"),
            &response_with_set_cookie(&["PHPSESSID=; max-age=0; Path=/"]),
        );
        assert!(store.get_all_cookies()["rezka-tv.org"].is_empty());
    }

    #[test]
    fn test_set_cookie_uppercase_max_age_zero_deletes_cookie() {
        let store = PersistentCookieStore::in_memory();
        store.set_cookie("rezka-tv.org", "dle_user_id", "42");
        store.parse_and_store_response_cookies(
            &url("https://rezka-tv.org/"),
            &response_with_set_cookie(&["dle_user_id=42; Max-Age=0"]),
        );
        assert!(!store.get_all_cookies()["rezka-tv.org"].contains_key("dle_user_id"));
    }

    #[test]
    fn test_set_cookie_expires_in_past_deletes_and_in_future_keeps() {
        let store = PersistentCookieStore::in_memory();

        store.parse_and_store_response_cookies(
            &url("https://rezka-tv.org/"),
            &response_with_set_cookie(&["cf_clearance=stale; Expires=Wed, 21 Oct 2015 07:28:00 GMT"]),
        );
        assert!(
            !store
                .get_all_cookies()
                .get("rezka-tv.org")
                .map(|c| c.contains_key("cf_clearance"))
                .unwrap_or(false),
            "cookie with a past Expires must be rejected"
        );

        store.parse_and_store_response_cookies(
            &url("https://rezka-tv.org/"),
            &response_with_set_cookie(&["cf_clearance=fresh; Expires=Fri, 01 Jan 2100 00:00:00 GMT"]),
        );
        assert_eq!(store.get_all_cookies()["rezka-tv.org"]["cf_clearance"], "fresh");
        assert!(store
            .get_cookie_header_for_url(&url("https://rezka-tv.org/"))
            .unwrap()
            .contains("cf_clearance=fresh"));
    }

    #[test]
    fn test_expired_cookie_skipped_and_pruned_from_header() {
        let store = PersistentCookieStore::in_memory();
        store.set_cookie("rezka-tv.org", "PHPSESSID", "alive");
        // Simulate a cookie that expired while the app was closed.
        {
            let mut guard = store.data.lock().unwrap();
            guard
                .expires
                .entry("rezka-tv.org".to_string())
                .or_default()
                .insert("dle_user_id".to_string(), 1);
            guard
                .cookies
                .entry("rezka-tv.org".to_string())
                .or_default()
                .insert("dle_user_id".to_string(), "dead".to_string());
        }

        let header = store
            .get_cookie_header_for_url(&url("https://rezka-tv.org/"))
            .expect("header");
        assert!(header.contains("PHPSESSID=alive"));
        assert!(!header.contains("dle_user_id"), "expired cookie leaked: {header}");

        // Pruned from the store as well
        let all = store.get_all_cookies();
        assert!(!all["rezka-tv.org"].contains_key("dle_user_id"));
        assert!(!store.data.lock().unwrap().expires.contains_key("rezka-tv.org"));
    }
}
