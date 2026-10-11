fn main() {
    link_macos_compiler_runtime();
    tauri_build::build()
}

/// whisper.cpp's Metal code asks "is this macOS new enough?" at run time (`@available`). When the app targets
/// an older macOS than the build machine, that check needs a helper from clang's runtime library, which Rust
/// does not link by default. Ask clang where the library is and link it.
fn link_macos_compiler_runtime() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let Ok(output) = std::process::Command::new("clang")
        .arg("--print-runtime-dir")
        .output()
    else {
        return;
    };
    let dir = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success()
        && std::path::Path::new(&dir)
            .join("libclang_rt.osx.a")
            .is_file()
    {
        println!("cargo:rustc-link-search=native={dir}");
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
    }
}
