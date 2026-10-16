fn main() {
    // DPI awareness + common controls v6, like the other Kubuno desktop apps. (The app icon - the module's
    // web logo - is added with the Win32 resource in a later increment.)
    embed_manifest::embed_manifest(embed_manifest::new_manifest("Kubuno.Calendar"))
        .expect("unable to embed application manifest");
    println!("cargo:rerun-if-changed=build.rs");
}
