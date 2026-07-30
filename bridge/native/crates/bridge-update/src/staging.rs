use crate::manifest::{ReleasePackage, valid_sha256, validate_package};
use crate::{TEMP_SEQUENCE, UpdateError, replace_file, timestamp_nanos};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::Ordering;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use zip::ZipArchive;

const MAXIMUM_EXPANDED_BYTES: u64 = 1024 * 1024 * 1024;
const MAXIMUM_ARCHIVE_ENTRIES: usize = 16 * 1024;

#[derive(Clone)]
pub struct ReleasePackageStager {
    client: reqwest::Client,
    cache_directory: PathBuf,
}

impl ReleasePackageStager {
    pub fn new(
        client: reqwest::Client,
        cache_directory: impl AsRef<Path>,
    ) -> Result<Self, UpdateError> {
        let cache_directory = std::path::absolute(cache_directory.as_ref())
            .map_err(|_| UpdateError::new("update_cache_path_invalid"))?;
        if cache_directory.file_name().is_none() {
            return Err(UpdateError::new("update_cache_path_invalid"));
        }
        Ok(Self {
            client,
            cache_directory,
        })
    }

    pub fn cache_directory(&self) -> &Path {
        &self.cache_directory
    }

    pub async fn download_verified(
        &self,
        package: &ReleasePackage,
    ) -> Result<PathBuf, UpdateError> {
        if !validate_package(package) {
            return Err(UpdateError::new("update_manifest_package_invalid"));
        }
        tokio::fs::create_dir_all(&self.cache_directory)
            .await
            .map_err(|_| UpdateError::new("update_package_io_failed"))?;
        let final_path = self
            .cache_directory
            .join(format!("{}.zip", package.sha256.to_ascii_lowercase()));
        if tokio::fs::try_exists(&final_path)
            .await
            .map_err(|_| UpdateError::new("update_package_io_failed"))?
        {
            if verify_package_file(package, &final_path).await? {
                return Ok(final_path);
            }
            tokio::fs::remove_file(&final_path)
                .await
                .map_err(|_| UpdateError::new("update_package_io_failed"))?;
        }
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temporary = self.cache_directory.join(format!(
            ".package.{}.{}.{}.part",
            std::process::id(),
            timestamp_nanos(),
            sequence
        ));
        let _temporary_cleanup = TemporaryFileCleanup(temporary.clone());
        self.download_to(package, &temporary, &final_path).await
    }

    async fn download_to(
        &self,
        package: &ReleasePackage,
        temporary: &Path,
        final_path: &Path,
    ) -> Result<PathBuf, UpdateError> {
        let mut response = self
            .client
            .get(package.url.clone())
            .send()
            .await
            .map_err(|_| UpdateError::new("update_package_download_failed"))?;
        if !super::manifest::valid_transport_url(response.url()) {
            return Err(UpdateError::new("update_package_redirect_invalid"));
        }
        if !response.status().is_success() {
            return Err(UpdateError::new("update_package_download_failed"));
        }
        if response
            .content_length()
            .is_some_and(|length| length != package.size_bytes)
        {
            return Err(UpdateError::new("update_package_size_mismatch"));
        }
        let mut destination = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(temporary)
            .await
            .map_err(|_| UpdateError::new("update_package_io_failed"))?;
        let mut hash = Sha256::new();
        let mut total = 0_u64;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| UpdateError::new("update_package_download_failed"))?
        {
            total = total
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| UpdateError::new("update_package_size_mismatch"))?;
            if total > package.size_bytes {
                return Err(UpdateError::new("update_package_size_mismatch"));
            }
            hash.update(&chunk);
            destination
                .write_all(&chunk)
                .await
                .map_err(|_| UpdateError::new("update_package_io_failed"))?;
        }
        destination
            .sync_all()
            .await
            .map_err(|_| UpdateError::new("update_package_io_failed"))?;
        drop(destination);
        if total != package.size_bytes
            || hash.finalize().as_slice() != decode_sha256(&package.sha256)?
        {
            return Err(UpdateError::new("update_package_integrity_failed"));
        }
        replace_file(temporary, final_path)
            .map_err(|_| UpdateError::new("update_package_io_failed"))?;
        Ok(final_path.to_path_buf())
    }
}

struct TemporaryFileCleanup(PathBuf);

impl Drop for TemporaryFileCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub async fn verify_package_file(
    package: &ReleasePackage,
    package_path: impl AsRef<Path>,
) -> Result<bool, UpdateError> {
    if !validate_package(package) {
        return Err(UpdateError::new("update_manifest_package_invalid"));
    }
    let package_path = package_path.as_ref();
    let mut source = match tokio::fs::File::open(package_path).await {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(UpdateError::new("update_package_io_failed")),
    };
    let metadata = source
        .metadata()
        .await
        .map_err(|_| UpdateError::new("update_package_io_failed"))?;
    if !metadata.is_file() || metadata.len() != package.size_bytes {
        return Ok(false);
    }
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = source
            .read(&mut buffer)
            .await
            .map_err(|_| UpdateError::new("update_package_io_failed"))?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hash.finalize().as_slice() == decode_sha256(&package.sha256)?)
}

pub fn verified_expanded_size(
    package: &ReleasePackage,
    package_path: impl AsRef<Path>,
) -> Result<u64, UpdateError> {
    if !validate_package(package) {
        return Err(UpdateError::new("update_manifest_package_invalid"));
    }
    let mut source =
        File::open(package_path).map_err(|_| UpdateError::new("update_package_io_failed"))?;
    let metadata = source
        .metadata()
        .map_err(|_| UpdateError::new("update_package_io_failed"))?;
    if !metadata.is_file() || metadata.len() != package.size_bytes {
        return Err(UpdateError::new("update_package_integrity_failed"));
    }
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|_| UpdateError::new("update_package_io_failed"))?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    if hash.finalize().as_slice() != decode_sha256(&package.sha256)? {
        return Err(UpdateError::new("update_package_integrity_failed"));
    }
    source
        .seek(SeekFrom::Start(0))
        .map_err(|_| UpdateError::new("update_package_io_failed"))?;
    let mut archive =
        ZipArchive::new(source).map_err(|_| UpdateError::new("update_package_archive_invalid"))?;
    inspect_archive(&mut archive)?
        .iter()
        .try_fold(0_u64, |total, entry| {
            total
                .checked_add(if entry.directory { 0 } else { entry.size })
                .ok_or_else(|| UpdateError::new("update_package_expanded_size_exceeded"))
        })
}

pub fn extract_verified_package(
    package: &ReleasePackage,
    package_path: impl AsRef<Path>,
    destination_directory: impl AsRef<Path>,
) -> Result<PathBuf, UpdateError> {
    if !validate_package(package) {
        return Err(UpdateError::new("update_manifest_package_invalid"));
    }
    let destination = std::path::absolute(destination_directory.as_ref())
        .map_err(|_| UpdateError::new("update_staging_path_invalid"))?;
    if destination.file_name().is_none() || destination.parent().is_none() {
        return Err(UpdateError::new("update_staging_path_invalid"));
    }
    if destination.exists() {
        return Err(UpdateError::new("update_staging_path_exists"));
    }
    let mut source =
        File::open(package_path).map_err(|_| UpdateError::new("update_package_io_failed"))?;
    let metadata = source
        .metadata()
        .map_err(|_| UpdateError::new("update_package_io_failed"))?;
    if !metadata.is_file() || metadata.len() != package.size_bytes {
        return Err(UpdateError::new("update_package_integrity_failed"));
    }
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|_| UpdateError::new("update_package_io_failed"))?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    if hash.finalize().as_slice() != decode_sha256(&package.sha256)? {
        return Err(UpdateError::new("update_package_integrity_failed"));
    }
    source
        .seek(SeekFrom::Start(0))
        .map_err(|_| UpdateError::new("update_package_io_failed"))?;
    let mut archive =
        ZipArchive::new(source).map_err(|_| UpdateError::new("update_package_archive_invalid"))?;
    let plan = inspect_archive(&mut archive)?;
    fs::create_dir(&destination).map_err(|_| UpdateError::new("update_staging_create_failed"))?;
    let result = extract_archive(&mut archive, &destination, &plan);
    if result.is_err() {
        let _ = fs::remove_dir_all(&destination);
    }
    result?;
    Ok(destination)
}

pub fn verify_extracted_package(
    package: &ReleasePackage,
    package_path: impl AsRef<Path>,
    destination_directory: impl AsRef<Path>,
) -> Result<Vec<PathBuf>, UpdateError> {
    if !validate_package(package) {
        return Err(UpdateError::new("update_manifest_package_invalid"));
    }
    let mut source =
        File::open(package_path).map_err(|_| UpdateError::new("update_package_cache_missing"))?;
    let metadata = source
        .metadata()
        .map_err(|_| UpdateError::new("update_package_io_failed"))?;
    if !metadata.is_file() || metadata.len() != package.size_bytes {
        return Err(UpdateError::new("update_package_integrity_failed"));
    }
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|_| UpdateError::new("update_package_io_failed"))?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    if hash.finalize().as_slice() != decode_sha256(&package.sha256)? {
        return Err(UpdateError::new("update_package_integrity_failed"));
    }
    source
        .seek(SeekFrom::Start(0))
        .map_err(|_| UpdateError::new("update_package_io_failed"))?;
    let mut archive =
        ZipArchive::new(source).map_err(|_| UpdateError::new("update_package_archive_invalid"))?;
    let plan = inspect_archive(&mut archive)?;
    let destination = destination_directory.as_ref();
    let mut verified_files = Vec::new();
    let mut archive_buffer = [0_u8; 64 * 1024];
    let mut staged_buffer = [0_u8; 64 * 1024];
    for planned in plan.iter().filter(|entry| !entry.directory) {
        let staged_path = destination.join(&planned.relative_path);
        let staged_metadata = fs::symlink_metadata(&staged_path)
            .map_err(|_| UpdateError::new("update_staged_release_integrity_failed"))?;
        if staged_metadata.file_type().is_symlink()
            || !staged_metadata.is_file()
            || staged_metadata.len() != planned.size
        {
            return Err(UpdateError::new("update_staged_release_integrity_failed"));
        }
        let mut archived = archive
            .by_index(planned.index)
            .map_err(|_| UpdateError::new("update_package_archive_invalid"))?;
        let mut staged =
            File::open(&staged_path).map_err(|_| UpdateError::new("update_package_io_failed"))?;
        loop {
            let archived_read = archived
                .read(&mut archive_buffer)
                .map_err(|_| UpdateError::new("update_package_archive_invalid"))?;
            let staged_read = staged
                .read(&mut staged_buffer)
                .map_err(|_| UpdateError::new("update_package_io_failed"))?;
            if archived_read != staged_read
                || archive_buffer[..archived_read] != staged_buffer[..staged_read]
            {
                return Err(UpdateError::new("update_staged_release_integrity_failed"));
            }
            if archived_read == 0 {
                break;
            }
        }
        verified_files.push(planned.relative_path.clone());
    }
    Ok(verified_files)
}

#[derive(Debug)]
struct ArchiveEntryPlan {
    index: usize,
    relative_path: PathBuf,
    directory: bool,
    size: u64,
}

fn inspect_archive(source: &mut ZipArchive<File>) -> Result<Vec<ArchiveEntryPlan>, UpdateError> {
    if source.is_empty() || source.len() > MAXIMUM_ARCHIVE_ENTRIES {
        return Err(UpdateError::new("update_package_archive_invalid"));
    }
    let mut total = 0_u64;
    let mut paths = HashSet::new();
    let mut plan = Vec::with_capacity(source.len());
    for index in 0..source.len() {
        let entry = source
            .by_index(index)
            .map_err(|_| UpdateError::new("update_package_archive_invalid"))?;
        if entry.is_symlink() || entry.name().contains('\\') {
            return Err(UpdateError::new("update_package_path_traversal"));
        }
        let relative_path = entry
            .enclosed_name()
            .filter(|path| valid_windows_relative_path(path))
            .ok_or_else(|| UpdateError::new("update_package_path_traversal"))?;
        let identity = relative_path
            .to_string_lossy()
            .replace('/', "\\")
            .to_ascii_lowercase();
        if !paths.insert(identity) {
            return Err(UpdateError::new("update_package_archive_invalid"));
        }
        if !entry.is_dir() {
            total = total
                .checked_add(entry.size())
                .ok_or_else(|| UpdateError::new("update_package_expanded_size_exceeded"))?;
            if total > MAXIMUM_EXPANDED_BYTES {
                return Err(UpdateError::new("update_package_expanded_size_exceeded"));
            }
        }
        plan.push(ArchiveEntryPlan {
            index,
            relative_path,
            directory: entry.is_dir(),
            size: entry.size(),
        });
    }
    Ok(plan)
}

fn extract_archive(
    source: &mut ZipArchive<File>,
    destination: &Path,
    plan: &[ArchiveEntryPlan],
) -> Result<(), UpdateError> {
    for planned in plan {
        let path = destination.join(&planned.relative_path);
        if planned.directory {
            fs::create_dir_all(&path)
                .map_err(|_| UpdateError::new("update_package_extract_failed"))?;
            continue;
        }
        let parent = path
            .parent()
            .ok_or_else(|| UpdateError::new("update_package_path_traversal"))?;
        fs::create_dir_all(parent)
            .map_err(|_| UpdateError::new("update_package_extract_failed"))?;
        let mut input = source
            .by_index(planned.index)
            .map_err(|_| UpdateError::new("update_package_archive_invalid"))?;
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|_| UpdateError::new("update_package_extract_failed"))?;
        let mut copied = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = input
                .read(&mut buffer)
                .map_err(|_| UpdateError::new("update_package_extract_failed"))?;
            if read == 0 {
                break;
            }
            copied = copied
                .checked_add(read as u64)
                .ok_or_else(|| UpdateError::new("update_package_archive_invalid"))?;
            if copied > planned.size {
                return Err(UpdateError::new("update_package_archive_invalid"));
            }
            output
                .write_all(&buffer[..read])
                .map_err(|_| UpdateError::new("update_package_extract_failed"))?;
        }
        if copied != planned.size {
            return Err(UpdateError::new("update_package_archive_invalid"));
        }
        output
            .flush()
            .and_then(|()| output.sync_all())
            .map_err(|_| UpdateError::new("update_package_extract_failed"))?;
    }
    Ok(())
}

fn valid_windows_relative_path(path: &Path) -> bool {
    let mut has_component = false;
    for component in path.components() {
        let Component::Normal(component) = component else {
            return false;
        };
        let Some(component) = component.to_str() else {
            return false;
        };
        has_component = true;
        if component.is_empty()
            || component.ends_with([' ', '.'])
            || component.bytes().any(|value| {
                value < 32 || matches!(value, b'<' | b'>' | b':' | b'"' | b'|' | b'?' | b'*')
            })
            || windows_device_name(component)
        {
            return false;
        }
    }
    has_component
}

fn windows_device_name(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || stem.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && matches!(stem.as_bytes()[3], b'1'..=b'9')
}

fn decode_sha256(value: &str) -> Result<[u8; 32], UpdateError> {
    if !valid_sha256(value) {
        return Err(UpdateError::new("update_package_identity_invalid"));
    }
    let mut decoded = [0_u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        decoded[index] = (decode_hex(pair[0]) << 4) | decode_hex(pair[1]);
    }
    Ok(decoded)
}

fn decode_hex(value: u8) -> u8 {
    match value {
        b'0'..=b'9' => value - b'0',
        b'a'..=b'f' => value - b'a' + 10,
        b'A'..=b'F' => value - b'A' + 10,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use url::Url;
    use zip::write::SimpleFileOptions;

    #[tokio::test]
    async fn downloads_exact_bytes_to_the_content_addressed_cache_and_reuses_them() {
        let archive = zip_payload(&[("runtime/worker.py", b"print('ready')")]);
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind server");
        let address = listener.local_addr().expect("server address");
        let served = archive.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept request");
            let mut request = [0_u8; 4096];
            let _ = socket.read(&mut request).await.expect("read request");
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                served.len()
            );
            socket
                .write_all(header.as_bytes())
                .await
                .expect("write header");
            socket.write_all(&served).await.expect("write package");
        });
        let root = unique_test_directory("download");
        let package = package_for(
            &archive,
            &format!("http://{address}/bridge/releases/worker.zip"),
        );
        let stager = ReleasePackageStager::new(reqwest::Client::new(), root.join("cache"))
            .expect("package stager");
        let downloaded = stager
            .download_verified(&package)
            .await
            .expect("verified package");
        server.await.expect("local server");
        assert_eq!(fs::read(&downloaded).expect("cached package"), archive);
        let expected_name = format!("{}.zip", package.sha256);
        assert_eq!(
            downloaded.file_name().and_then(|value| value.to_str()),
            Some(expected_name.as_str())
        );
        assert_eq!(
            stager
                .download_verified(&package)
                .await
                .expect("reuse verified package"),
            downloaded
        );
        assert_eq!(
            fs::read_dir(stager.cache_directory())
                .expect("cache directory")
                .count(),
            1
        );
        fs::remove_dir_all(root).expect("remove package fixture");
    }

    #[tokio::test]
    async fn rejects_corrupt_downloads_and_removes_partial_files() {
        let expected = b"expected package".to_vec();
        let corrupt = b"corruptd package".to_vec();
        assert_eq!(expected.len(), corrupt.len());
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind server");
        let address = listener.local_addr().expect("server address");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept request");
            let mut request = [0_u8; 4096];
            let _ = socket.read(&mut request).await.expect("read request");
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                corrupt.len()
            );
            socket
                .write_all(header.as_bytes())
                .await
                .expect("write header");
            socket.write_all(&corrupt).await.expect("write package");
        });
        let root = unique_test_directory("corrupt-download");
        let package = package_for(
            &expected,
            &format!("http://{address}/bridge/releases/corrupt.zip"),
        );
        let stager = ReleasePackageStager::new(reqwest::Client::new(), root.join("cache"))
            .expect("package stager");
        assert_eq!(
            stager
                .download_verified(&package)
                .await
                .expect_err("corrupt package")
                .code(),
            "update_package_integrity_failed"
        );
        server.await.expect("local server");
        assert_eq!(
            fs::read_dir(stager.cache_directory())
                .expect("cache directory")
                .count(),
            0
        );
        fs::remove_dir_all(root).expect("remove package fixture");
    }

    #[test]
    fn extracts_a_verified_archive_into_a_new_isolated_directory() {
        let archive = zip_payload(&[
            ("runtime/worker.py", b"print('ready')"),
            ("config/server-endpoints.json", br#"{"schema_version":1}"#),
        ]);
        let root = unique_test_directory("extract");
        fs::create_dir_all(&root).expect("fixture root");
        let package_path = root.join("package.zip");
        fs::write(&package_path, &archive).expect("package file");
        let package = package_for(&archive, "http://127.0.0.1:3000/package.zip");
        let destination = root.join("version");
        assert_eq!(
            extract_verified_package(&package, &package_path, &destination)
                .expect("extract package"),
            destination
        );
        assert_eq!(
            fs::read_to_string(destination.join("runtime/worker.py")).expect("worker"),
            "print('ready')"
        );
        fs::remove_dir_all(root).expect("remove package fixture");
    }

    #[test]
    fn rejects_traversal_ads_and_case_collisions_before_writing_any_file() {
        for (suffix, entries) in [
            (
                "traversal",
                vec![
                    ("safe.txt", b"safe".as_slice()),
                    ("../escape.txt", b"escape".as_slice()),
                ],
            ),
            ("ads", vec![("safe.txt:payload", b"payload".as_slice())]),
            (
                "case-collision",
                vec![
                    ("Module/file.txt", b"one".as_slice()),
                    ("module/FILE.txt", b"two".as_slice()),
                ],
            ),
        ] {
            let archive = zip_payload(&entries);
            let root = unique_test_directory(suffix);
            fs::create_dir_all(&root).expect("fixture root");
            let package_path = root.join("package.zip");
            fs::write(&package_path, &archive).expect("package file");
            let package = package_for(&archive, "http://127.0.0.1:3000/package.zip");
            let destination = root.join("version");
            let code = extract_verified_package(&package, &package_path, &destination)
                .expect_err("unsafe archive")
                .code();
            assert!(matches!(
                code,
                "update_package_path_traversal" | "update_package_archive_invalid"
            ));
            assert!(!destination.exists());
            assert!(!root.join("escape.txt").exists());
            fs::remove_dir_all(root).expect("remove package fixture");
        }
    }

    #[test]
    fn rejects_symbolic_links_before_creating_the_destination() {
        let cursor = Cursor::new(Vec::new());
        let mut archive = zip::ZipWriter::new(cursor);
        archive
            .add_symlink(
                "runtime/worker.py",
                "../../outside.py",
                SimpleFileOptions::default(),
            )
            .expect("zip symlink");
        let archive = archive.finish().expect("finish zip").into_inner();
        let root = unique_test_directory("symlink");
        fs::create_dir_all(&root).expect("fixture root");
        let package_path = root.join("package.zip");
        fs::write(&package_path, &archive).expect("package file");
        let package = package_for(&archive, "http://127.0.0.1:3000/package.zip");
        let destination = root.join("version");

        assert_eq!(
            extract_verified_package(&package, &package_path, &destination)
                .expect_err("symbolic link")
                .code(),
            "update_package_path_traversal"
        );
        assert!(!destination.exists());
        fs::remove_dir_all(root).expect("remove package fixture");
    }

    fn zip_payload(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut archive = zip::ZipWriter::new(cursor);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, payload) in entries {
            archive.start_file(*name, options).expect("zip entry");
            archive.write_all(payload).expect("zip payload");
        }
        archive.finish().expect("finish zip").into_inner()
    }

    fn package_for(payload: &[u8], url: &str) -> ReleasePackage {
        ReleasePackage {
            module_id: "core".to_owned(),
            version: "3.1.0".to_owned(),
            url: Url::parse(url).expect("package URL"),
            size_bytes: payload.len() as u64,
            sha256: format!("{:x}", Sha256::digest(payload)),
            signature: "c2lnbmF0dXJl".to_owned(),
            minimum_core_version: None,
            maximum_core_version: None,
        }
    }

    fn unique_test_directory(suffix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "liangjian-package-staging-{}-{}-{suffix}",
            std::process::id(),
            timestamp_nanos()
        ))
    }
}
