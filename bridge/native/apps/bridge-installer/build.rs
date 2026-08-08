#[path = "../../windows_resource.rs"]
mod windows_resource;

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=AURUM_INSTALLER_PUBLIC_KEY_PATH");
    println!("cargo:rerun-if-env-changed=AURUM_INSTALLER_LAUNCHER_VERSION");
    println!("cargo:rerun-if-env-changed=AURUM_INSTALLER_TARGET_ENVIRONMENT");

    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let public_key = env::var_os("AURUM_INSTALLER_PUBLIC_KEY_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest_dir.join("../../../update-contract/release-public-key.pem"));
    if !public_key.is_file() {
        panic!(
            "installer release public key is missing: {}",
            public_key.display()
        );
    }
    println!("cargo:rerun-if-changed={}", public_key.display());
    let key = fs::read(&public_key).expect("read installer release public key");
    let output =
        PathBuf::from(env::var_os("OUT_DIR").expect("out dir")).join("release-public-key.pem");
    fs::write(output, key).expect("embed installer release public key");

    let launcher_version =
        env::var("AURUM_INSTALLER_LAUNCHER_VERSION").unwrap_or_else(|_| "1.0.0".to_owned());
    let target_environment =
        env::var("AURUM_INSTALLER_TARGET_ENVIRONMENT").unwrap_or_else(|_| "test".to_owned());
    if !matches!(target_environment.as_str(), "test" | "production") {
        panic!("installer target environment is invalid");
    }
    println!("cargo:rustc-env=AURUM_INSTALLER_LAUNCHER_VERSION={launcher_version}");
    println!("cargo:rustc-env=AURUM_INSTALLER_TARGET_ENVIRONMENT={target_environment}");
    windows_resource::embed_windows_executable_resource(
        "量见智桥离线安装组件",
        "LiangjianBridgeInstallBackend.exe",
    );
}
