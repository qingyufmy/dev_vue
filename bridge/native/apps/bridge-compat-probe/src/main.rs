use bridge_foundation::{default_root_data_directory, resolve_profile_paths, validate_profile_id};
use bridge_security_win::CredentialStore;
use bridge_store::{SchemaCompatibilityReport, inspect_existing_schema};
use serde::Serialize;
use std::env;
use std::error::Error;
use std::path::PathBuf;

#[derive(Serialize)]
struct ProbeReport {
    ok: bool,
    implementation: &'static str,
    profile_id: String,
    credential_status: &'static str,
    database: SchemaCompatibilityReport,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let (root, profile_id) = parse_arguments()?;
    let paths = resolve_profile_paths(root, &profile_id)?;
    let store = CredentialStore::new(&paths.credential_path)?;
    let credential_status = if store.load()?.is_some() {
        "compatible"
    } else {
        "not_present"
    };
    let database = inspect_existing_schema(&paths.database_path)?;
    let report = ProbeReport {
        ok: database.is_compatible(),
        implementation: "rust-native-3.0.0-compat-probe",
        profile_id,
        credential_status,
        database,
    };
    println!("{}", serde_json::to_string(&report)?);
    if report.ok {
        Ok(())
    } else {
        Err("native_bridge_v3_compatibility_failed".into())
    }
}

fn parse_arguments() -> Result<(PathBuf, String), &'static str> {
    let mut root = None;
    let mut profile = None;
    let arguments: Vec<_> = env::args_os().skip(1).collect();
    if !arguments.len().is_multiple_of(2) {
        return Err("bridge_arguments_invalid");
    }
    for pair in arguments.chunks_exact(2) {
        let flag = pair[0].to_str().ok_or("bridge_arguments_invalid")?;
        match flag {
            "--root-data-dir" if root.is_none() => root = Some(PathBuf::from(&pair[1])),
            "--profile" if profile.is_none() => {
                profile = Some(
                    pair[1]
                        .to_str()
                        .ok_or("bridge_profile_id_invalid")?
                        .to_owned(),
                );
            }
            _ => return Err("bridge_arguments_invalid"),
        }
    }
    let profile = validate_profile_id(profile.as_deref())?;
    Ok((root.unwrap_or(default_root_data_directory()?), profile))
}
