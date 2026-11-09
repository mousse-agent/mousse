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
}
