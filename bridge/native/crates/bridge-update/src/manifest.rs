use crate::UpdateError;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use p256::ecdsa::signature::Verifier as _;
use p256::ecdsa::{Signature, VerifyingKey};
use p256::pkcs8::DecodePublicKey as _;
use reqwest::header::{ETAG, IF_NONE_MATCH};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;

const MAXIMUM_MANIFEST_BYTES: usize = 128 * 1024;
const MAXIMUM_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;
const MAXIMUM_SIGNATURE_TEXT_BYTES: usize = 1024;
const CURRENT_MANIFEST_PATH: &str = "/api/bridge/v3/releases/current";
const BOOTSTRAP_MANIFEST_PATH: &str = "/api/bridge/v3/releases/bootstrap";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleasePackage {
    pub module_id: String,
    pub version: String,
    pub url: Url,
    pub size_bytes: u64,
    pub sha256: String,
    pub signature: String,
    pub minimum_core_version: Option<String>,
    pub maximum_core_version: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseManifest {
    #[serde(default = "manifest_schema_version")]
    pub schema_version: u32,
    pub release_version: String,
    pub release_id: Option<String>,
    pub generated_at_utc_msc: i64,
    pub published_at_utc_msc: Option<i64>,
    pub expires_at_utc_msc: Option<i64>,
    pub priority: Option<String>,
    pub minimum_launcher_version: String,
    pub minimum_idle_seconds: Option<u32>,
    pub activation_deadline_utc_msc: Option<i64>,
    pub rollout_channel: Option<String>,
    pub rollout_percentage: Option<u32>,
    pub packages: Vec<ReleasePackage>,
    pub signature: String,
}

#[derive(Clone)]
pub struct ReleaseManifestVerifier {
    public_key: VerifyingKey,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl ReleaseManifestVerifier {
    pub fn new(subject_public_key_info_pem: &str) -> Result<Self, UpdateError> {
        Self::with_clock(subject_public_key_info_pem, now_utc_msc)
    }

    pub fn with_clock(
        subject_public_key_info_pem: &str,
        clock: impl Fn() -> i64 + Send + Sync + 'static,
    ) -> Result<Self, UpdateError> {
        if subject_public_key_info_pem.trim().is_empty()
            || subject_public_key_info_pem.len() > 16 * 1024
        {
            return Err(UpdateError::new("update_public_key_invalid"));
        }
        let public_key = VerifyingKey::from_public_key_pem(subject_public_key_info_pem)
            .map_err(|_| UpdateError::new("update_public_key_invalid"))?;
        Ok(Self {
            public_key,
            clock: Arc::new(clock),
        })
    }

    pub fn verify(
        &self,
        manifest: &ReleaseManifest,
        launcher_version: &str,
    ) -> Result<(), UpdateError> {
        validate_manifest(manifest, launcher_version, (self.clock)())?;
        let signature = decode_signature(&manifest.signature, "update_manifest_signature_invalid")?;
        let canonical = canonicalize_manifest(manifest)?;
        self.public_key
            .verify(canonical.as_bytes(), &signature)
            .map_err(|_| UpdateError::new("update_manifest_signature_invalid"))?;
        for package in &manifest.packages {
            let signature =
                decode_signature(&package.signature, "update_package_signature_invalid")?;
            self.public_key
                .verify(canonicalize_package(package).as_bytes(), &signature)
                .map_err(|_| UpdateError::new("update_package_signature_invalid"))?;
        }
        Ok(())
    }
}

pub struct ReleaseManifestClient {
    endpoint: Url,
    client: Client,
    cache_key: Option<String>,
    etag: Option<String>,
    cached_manifest: Option<ReleaseManifest>,
}

impl ReleaseManifestClient {
    pub fn new(server_base: Url, client: Client) -> Result<Self, UpdateError> {
        Self::with_endpoint(server_base, client, CURRENT_MANIFEST_PATH)
    }

    pub fn with_endpoint(
        server_base: Url,
        client: Client,
        endpoint_path: &str,
    ) -> Result<Self, UpdateError> {
        if !valid_transport_url(&server_base) {
            return Err(UpdateError::new("update_server_uri_invalid"));
        }
        if endpoint_path != CURRENT_MANIFEST_PATH && endpoint_path != BOOTSTRAP_MANIFEST_PATH {
            return Err(UpdateError::new("update_endpoint_path_invalid"));
        }
        let endpoint = server_base
            .join(endpoint_path)
            .map_err(|_| UpdateError::new("update_endpoint_path_invalid"))?;
        Ok(Self {
            endpoint,
            client,
            cache_key: None,
            etag: None,
            cached_manifest: None,
        })
    }

    pub async fn fetch_verified(
        &mut self,
        verifier: &ReleaseManifestVerifier,
        launcher_version: &str,
        installation_id: &str,
        rollout_channel: &str,
    ) -> Result<Option<ReleaseManifest>, UpdateError> {
        if !valid_installation_id(installation_id)
            || !matches!(rollout_channel, "internal" | "stable")
        {
            return Err(UpdateError::new("update_rollout_identity_invalid"));
        }
        let cache_key = format!("{installation_id}:{rollout_channel}");
        let mut request = self
            .client
            .get(self.endpoint.clone())
            .header("X-Aurum-Installation-Id", installation_id)
            .header("X-Aurum-Release-Channel", rollout_channel);
        if self.cache_key.as_deref() == Some(cache_key.as_str())
            && self.cached_manifest.is_some()
            && let Some(etag) = self.etag.as_deref()
        {
            request = request.header(IF_NONE_MATCH, etag);
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| UpdateError::new("update_manifest_request_failed"))?;
        if !valid_transport_url(response.url()) {
            return Err(UpdateError::new("update_manifest_redirect_invalid"));
        }
        match response.status() {
            StatusCode::NO_CONTENT => {
                self.clear_cache();
                return Ok(None);
            }
            StatusCode::NOT_MODIFIED => {
                if self.cache_key.as_deref() != Some(cache_key.as_str()) {
                    return Err(UpdateError::new("update_manifest_cache_missing"));
                }
                let manifest = self
                    .cached_manifest
                    .as_ref()
                    .ok_or_else(|| UpdateError::new("update_manifest_cache_missing"))?;
                verifier.verify(manifest, launcher_version)?;
                return Ok(Some(manifest.clone()));
            }
            status if !status.is_success() => {
                return Err(UpdateError::new("update_manifest_request_failed"));
            }
            _ => {}
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAXIMUM_MANIFEST_BYTES as u64)
        {
            return Err(UpdateError::new("update_manifest_too_large"));
        }
        let mut payload = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| UpdateError::new("update_manifest_request_failed"))?
        {
            if payload.len() + chunk.len() > MAXIMUM_MANIFEST_BYTES {
                return Err(UpdateError::new("update_manifest_too_large"));
            }
            payload.extend_from_slice(&chunk);
        }
        let manifest = serde_json::from_slice::<ReleaseManifest>(&payload)
            .map_err(|_| UpdateError::new("update_manifest_invalid"))?;
        verifier.verify(&manifest, launcher_version)?;
        self.cache_key = Some(cache_key);
        self.etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.len() <= 1024)
            .map(ToOwned::to_owned);
        self.cached_manifest = Some(manifest.clone());
        Ok(Some(manifest))
    }

    fn clear_cache(&mut self) {
        self.cache_key = None;
        self.etag = None;
        self.cached_manifest = None;
    }
}

pub fn canonicalize_manifest(manifest: &ReleaseManifest) -> Result<String, UpdateError> {
    let mut value = match manifest.schema_version {
        1 => format!(
            "AURUM-RELEASE-V1\n{}\n{}\n{}\n{}\n",
            manifest.schema_version,
            manifest.release_version,
            manifest.generated_at_utc_msc,
            manifest.minimum_launcher_version
        ),
        2 => format!(
            concat!("AURUM-RELEASE-V2\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n"),
            manifest.schema_version,
            manifest.release_id.as_deref().unwrap_or_default(),
            manifest.release_version,
            manifest.generated_at_utc_msc,
            display_option(manifest.published_at_utc_msc),
            display_option(manifest.expires_at_utc_msc),
            manifest.priority.as_deref().unwrap_or_default(),
            manifest.minimum_launcher_version,
            display_option(manifest.minimum_idle_seconds),
            display_option(manifest.activation_deadline_utc_msc),
            manifest.rollout_channel.as_deref().unwrap_or_default(),
            display_option(manifest.rollout_percentage),
        ),
        _ => return Err(UpdateError::new("update_manifest_schema_unsupported")),
    };
    let mut packages = manifest.packages.iter().collect::<Vec<_>>();
    packages.sort_by(|left, right| left.module_id.cmp(&right.module_id));
    for package in packages {
        value.push_str(&format!(
            "{}|{}|{}|{}|{}|{}|{}|{}\n",
            package.module_id,
            package.version,
            package.url.as_str(),
            package.size_bytes,
            package.sha256.to_ascii_lowercase(),
            package.signature,
            package.minimum_core_version.as_deref().unwrap_or_default(),
            package.maximum_core_version.as_deref().unwrap_or_default(),
        ));
    }
    Ok(value)
}

pub fn canonicalize_package(package: &ReleasePackage) -> String {
    format!(
        "AURUM-PACKAGE-V1\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n",
        package.module_id,
        package.version,
        package.url.as_str(),
        package.size_bytes,
        package.sha256.to_ascii_lowercase(),
        package.minimum_core_version.as_deref().unwrap_or_default(),
        package.maximum_core_version.as_deref().unwrap_or_default(),
    )
}

fn validate_manifest(
    manifest: &ReleaseManifest,
    launcher_version: &str,
    now_utc_msc: i64,
) -> Result<(), UpdateError> {
    let launcher = DotNetVersion::parse(launcher_version)
        .ok_or_else(|| UpdateError::new("update_launcher_version_invalid"))?;
    let minimum_launcher = DotNetVersion::parse(&manifest.minimum_launcher_version)
        .ok_or_else(|| UpdateError::new("update_manifest_invalid"))?;
    if !matches!(manifest.schema_version, 1 | 2)
        || DotNetVersion::parse(&manifest.release_version).is_none()
        || manifest.generated_at_utc_msc <= 0
        || launcher < minimum_launcher
        || !(1..=16).contains(&manifest.packages.len())
        || !valid_signature_text(&manifest.signature)
    {
        return Err(UpdateError::new("update_manifest_invalid"));
    }
    if manifest.schema_version == 2
        && (!valid_release_id(manifest.release_id.as_deref())
            || !matches!(manifest.priority.as_deref(), Some("normal" | "urgent"))
            || manifest.published_at_utc_msc.is_none_or(|value| value <= 0)
            || manifest.expires_at_utc_msc.is_none_or(|value| value <= 0)
            || manifest.expires_at_utc_msc <= manifest.published_at_utc_msc
            || manifest
                .expires_at_utc_msc
                .is_some_and(|value| value <= now_utc_msc)
            || manifest
                .expires_at_utc_msc
                .is_some_and(|value| manifest.generated_at_utc_msc > value)
            || manifest
                .minimum_idle_seconds
                .is_none_or(|value| !(30..=3600).contains(&value))
            || manifest
                .activation_deadline_utc_msc
                .is_some_and(|deadline| {
                    deadline <= manifest.published_at_utc_msc.unwrap_or_default()
                        || deadline > manifest.expires_at_utc_msc.unwrap_or_default()
                })
            || !matches!(
                manifest.rollout_channel.as_deref(),
                Some("internal" | "stable")
            )
            || manifest
                .rollout_percentage
                .is_none_or(|value| !(1..=100).contains(&value)))
    {
        return Err(UpdateError::new("update_manifest_invalid"));
    }
    let mut modules = std::collections::HashSet::new();
    for package in &manifest.packages {
        if !validate_package(package) || !modules.insert(package.module_id.as_str()) {
            return Err(UpdateError::new("update_manifest_package_invalid"));
        }
    }
    Ok(())
}

pub(crate) fn validate_package(package: &ReleasePackage) -> bool {
    matches!(
        package.module_id.as_str(),
        "core" | "adapter.mt5.python" | "adapter.mt4" | "data.symbol-map"
    ) && DotNetVersion::parse(&package.version).is_some()
        && (1..=MAXIMUM_PACKAGE_BYTES).contains(&package.size_bytes)
        && valid_sha256(&package.sha256)
        && valid_signature_text(&package.signature)
        && valid_transport_url(&package.url)
        && package
            .minimum_core_version
            .as_deref()
            .is_none_or(|value| DotNetVersion::parse(value).is_some())
        && package
            .maximum_core_version
            .as_deref()
            .is_none_or(|value| DotNetVersion::parse(value).is_some())
}

pub(crate) fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|value| value.is_ascii_hexdigit())
}

pub(crate) fn valid_transport_url(url: &Url) -> bool {
    let is_local_http =
        url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "::1" | "localhost"));
    (url.scheme() == "https" || is_local_http)
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

fn valid_installation_id(value: &str) -> bool {
    value.len() == 40
        && value.starts_with("install_")
        && value[8..]
            .bytes()
            .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())
}

fn valid_release_id(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        (8..=128).contains(&value.len())
            && value.bytes().all(|value| {
                value.is_ascii_alphanumeric() || matches!(value, b'.' | b'_' | b':' | b'-')
            })
    })
}

fn valid_signature_text(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= MAXIMUM_SIGNATURE_TEXT_BYTES
}

fn decode_signature(value: &str, code: &'static str) -> Result<Signature, UpdateError> {
    if !valid_signature_text(value) {
        return Err(UpdateError::new(code));
    }
    let bytes = STANDARD.decode(value).map_err(|_| UpdateError::new(code))?;
    Signature::from_slice(&bytes).map_err(|_| UpdateError::new(code))
}

fn display_option<T: ToString>(value: Option<T>) -> String {
    value.map(|value| value.to_string()).unwrap_or_default()
}

fn manifest_schema_version() -> u32 {
    1
}

fn now_utc_msc() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DotNetVersion([i32; 4]);

impl DotNetVersion {
    fn parse(value: &str) -> Option<Self> {
        let components = value.split('.').collect::<Vec<_>>();
        if !(2..=4).contains(&components.len()) {
            return None;
        }
        let mut parsed = [-1_i32; 4];
        for (index, component) in components.into_iter().enumerate() {
            if component.is_empty() || !component.bytes().all(|value| value.is_ascii_digit()) {
                return None;
            }
            parsed[index] = component.parse::<i32>().ok()?;
        }
        Some(Self(parsed))
    }
}

impl Ord for DotNetVersion {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0.cmp(&other.0)
    }
}

impl PartialOrd for DotNetVersion {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const PUBLIC_KEY: &str = include_str!("../../../../update-contract/release-public-key.pem");
    const MANIFEST: &str = include_str!("../../../../update-contract/manifest-v2.json");

    #[test]
    fn verifies_the_shared_dotnet_p256_manifest_and_rejects_policy_tampering() {
        let verifier = ReleaseManifestVerifier::with_clock(PUBLIC_KEY, || 1_800_000_000_100)
            .expect("manifest verifier");
        let manifest: ReleaseManifest = serde_json::from_str(MANIFEST).expect("manifest fixture");
        assert_eq!(verifier.verify(&manifest, "3.0.0"), Ok(()));
        assert!(
            canonicalize_manifest(&manifest)
                .expect("canonical manifest")
                .starts_with("AURUM-RELEASE-V2\n2\nrelease-fixture-3.1.0\n")
        );

        let mut tampered = manifest.clone();
        tampered.priority = Some("urgent".to_owned());
        assert_eq!(
            verifier
                .verify(&tampered, "3.0.0")
                .expect_err("tamper")
                .code(),
            "update_manifest_signature_invalid"
        );
        let expired = ReleaseManifestVerifier::with_clock(PUBLIC_KEY, || 4_102_444_800_000)
            .expect("expired verifier");
        assert_eq!(
            expired
                .verify(&manifest, "3.0.0")
                .expect_err("expired manifest")
                .code(),
            "update_manifest_invalid"
        );
    }

    #[test]
    fn rejects_unsupported_keys_versions_packages_and_remote_plaintext() {
        assert_eq!(
            ReleaseManifestVerifier::new("not a public key")
                .err()
                .expect("invalid key")
                .code(),
            "update_public_key_invalid"
        );
        let verifier = ReleaseManifestVerifier::with_clock(PUBLIC_KEY, || 1_800_000_000_100)
            .expect("manifest verifier");
        let manifest: ReleaseManifest = serde_json::from_str(MANIFEST).expect("manifest fixture");
        assert_eq!(
            verifier
                .verify(&manifest, "2.9.9")
                .expect_err("old launcher")
                .code(),
            "update_manifest_invalid"
        );
        let mut duplicate = manifest.clone();
        duplicate.packages[1].module_id = "core".to_owned();
        assert_eq!(
            verifier
                .verify(&duplicate, "3.0.0")
                .expect_err("duplicate module")
                .code(),
            "update_manifest_package_invalid"
        );
        let client = reqwest::Client::new();
        assert_eq!(
            ReleaseManifestClient::new(
                Url::parse("http://updates.example.test").expect("remote URL"),
                client,
            )
            .err()
            .expect("remote plaintext")
            .code(),
            "update_server_uri_invalid"
        );
    }

    #[tokio::test]
    async fn fetches_only_from_loopback_and_revalidates_the_etag_cache() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind server");
        let address = listener.local_addr().expect("server address");
        let observed = Arc::clone(&requests);
        let server = tokio::spawn(async move {
            for index in 0..2 {
                let (mut socket, _) = listener.accept().await.expect("accept request");
                let mut payload = vec![0_u8; 16 * 1024];
                let read = socket.read(&mut payload).await.expect("read request");
                let request = String::from_utf8(payload[..read].to_vec()).expect("HTTP request");
                observed.lock().expect("request log").push(request);
                let response = if index == 0 {
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nETag: \"fixture-v2\"\r\nConnection: close\r\n\r\n{}",
                        MANIFEST.len(),
                        MANIFEST
                    )
                } else {
                    "HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n".to_owned()
                };
                socket
                    .write_all(response.as_bytes())
                    .await
                    .expect("write response");
            }
        });
        let verifier = ReleaseManifestVerifier::with_clock(PUBLIC_KEY, || 1_800_000_000_100)
            .expect("manifest verifier");
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .expect("HTTP client");
        let mut client = ReleaseManifestClient::new(
            Url::parse(&format!("http://{address}")).expect("local URL"),
            http,
        )
        .expect("manifest client");
        for _ in 0..2 {
            let manifest = client
                .fetch_verified(
                    &verifier,
                    "3.0.0",
                    "install_0123456789abcdef0123456789abcdef",
                    "stable",
                )
                .await
                .expect("verified fetch")
                .expect("release manifest");
            assert_eq!(manifest.release_version, "3.1.0");
        }
        server.await.expect("local server");
        let requests = requests.lock().expect("request log");
        assert!(requests[0].starts_with("GET /api/bridge/v3/releases/current HTTP/1.1"));
        assert!(
            requests[0]
                .to_ascii_lowercase()
                .contains("x-aurum-installation-id: install_0123456789abcdef0123456789abcdef")
        );
        assert!(
            requests[1]
                .to_ascii_lowercase()
                .contains("if-none-match: \"fixture-v2\"")
        );
    }
}
