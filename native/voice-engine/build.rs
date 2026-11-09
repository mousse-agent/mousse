// ONNX Runtime's prebuilt Windows libraries come with DirectML, so the binary imports DirectML, Direct3D 12 and
// DXGI. They are loaded only if called, which the CPU-only engine never does: the engine starts on a computer
// whose DirectML is missing or older than the one ONNX Runtime was built against.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        for dll in ["DirectML.dll", "d3d12.dll", "dxgi.dll"] {
            println!("cargo:rustc-link-arg-bins=/DELAYLOAD:{dll}");
        }
        println!("cargo:rustc-link-arg-bins=delayimp.lib");
        // The unit tests use none of them, which the linker would warn about.
        println!("cargo:rustc-link-arg-bins=/IGNORE:4199");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        link_clang_runtime();
    }
}

/// ONNX Runtime's prebuilt macOS library checks the OS version with `@available`, which calls
/// `__isPlatformVersionAtLeast` from clang's runtime library. Rust links with `-nodefaultlibs`, which leaves that
/// library out, so it is added here from the toolchain that does the linking.
fn link_clang_runtime() {
    let output = std::process::Command::new("xcrun")
        .args(["clang", "-print-resource-dir"])
        .output()
        .expect("xcrun clang -print-resource-dir failed; the Xcode command line tools are needed");
    let resource_dir = String::from_utf8(output.stdout).expect("clang printed a path that is not UTF-8");
    let library = std::path::Path::new(resource_dir.trim()).join("lib").join("darwin").join("libclang_rt.osx.a");
    assert!(library.is_file(), "clang's runtime library is missing: {}", library.display());
    println!("cargo:rustc-link-arg={}", library.display());
}
