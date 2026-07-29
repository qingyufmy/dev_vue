use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

pub fn embed_windows_executable_resource(file_description: &str, original_file_name: &str) {
    println!("cargo:rerun-if-changed=../../../assets/liangjian-bridge.ico");
    println!("cargo:rerun-if-env-changed=AURUM_WINDOWS_PRODUCT_VERSION_OVERRIDE");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let icon = manifest_dir.join("../../../assets/liangjian-bridge.ico");
    if !icon.is_file() {
        panic!("Windows icon is missing: {}", icon.display());
    }

    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("out dir"));
    let resource_script = out_dir.join("liangjian-bridge.rc");
    let compiled_resource = out_dir.join("liangjian-bridge.res");
    let package_version = env::var("AURUM_WINDOWS_PRODUCT_VERSION_OVERRIDE")
        .unwrap_or_else(|_| env::var("CARGO_PKG_VERSION").expect("package version"));
    let numeric_version = numeric_version(&package_version);
    let icon_path = icon.to_string_lossy().replace('\\', "\\\\");
    let resource = format!(
        r#"1 ICON "{icon_path}"
1 VERSIONINFO
 FILEVERSION {numeric_version}
 PRODUCTVERSION {numeric_version}
 FILEFLAGSMASK 0x3fL
 FILEFLAGS 0x0L
 FILEOS 0x00040004L
 FILETYPE 0x1L
 FILESUBTYPE 0x0L
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "080404B0"
    BEGIN
      VALUE "CompanyName", "AURUM\0"
      VALUE "FileDescription", "{file_description}\0"
      VALUE "FileVersion", "{package_version}\0"
      VALUE "InternalName", "{original_file_name}\0"
      VALUE "OriginalFilename", "{original_file_name}\0"
      VALUE "ProductName", "量见智桥\0"
      VALUE "ProductVersion", "{package_version}\0"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x0804, 1200
  END
END
"#
    );
    fs::write(&resource_script, resource).expect("write Windows resource script");

    let resource_compiler = find_resource_compiler().unwrap_or_else(|| {
        panic!("Windows SDK resource compiler rc.exe was not found; install the Windows SDK")
    });
    let output = Command::new(&resource_compiler)
        .arg("/nologo")
        .arg("/c65001")
        .arg(format!("/fo{}", compiled_resource.display()))
        .arg(&resource_script)
        .output()
        .expect("start Windows resource compiler");
    if !output.status.success() {
        panic!(
            "rc.exe failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    println!("cargo:rustc-link-arg={}", compiled_resource.display());
}

fn numeric_version(version: &str) -> String {
    let mut values = version
        .split(|character: char| !character.is_ascii_digit())
        .filter(|value| !value.is_empty())
        .filter_map(|value| value.parse::<u16>().ok())
        .take(4)
        .collect::<Vec<_>>();
    values.resize(4, 0);
    values
        .into_iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

fn find_resource_compiler() -> Option<PathBuf> {
    if let Some(path) = env::var_os("RC_EXE").map(PathBuf::from)
        && path.is_file()
    {
        return Some(path);
    }

    let architecture = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("x86") => "x86",
        Ok("aarch64") => "arm64",
        _ => "x64",
    };
    let program_files = env::var_os("ProgramFiles(x86)")
        .or_else(|| env::var_os("ProgramFiles"))
        .map(PathBuf::from)?;
    let sdk_bin = program_files.join("Windows Kits/10/bin");
    let direct = sdk_bin.join(architecture).join("rc.exe");
    if direct.is_file() {
        return Some(direct);
    }

    let mut versions = fs::read_dir(&sdk_bin)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    versions.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    versions
        .into_iter()
        .map(|version| version.join(architecture).join("rc.exe"))
        .find(|path| path.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prerelease_version_is_accepted_by_windows_version_info() {
        assert_eq!(numeric_version("3.0.0-alpha.1"), "3,0,0,1");
        assert_eq!(numeric_version("3.2"), "3,2,0,0");
    }
}
