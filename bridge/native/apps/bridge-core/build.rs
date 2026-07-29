#[path = "../../windows_resource.rs"]
mod windows_resource;

fn main() {
    windows_resource::embed_windows_executable_resource("量见智桥后台服务", "AURUMBridge.Core.exe");
}
