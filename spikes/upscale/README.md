# Upscale feasibility spike (Phase 6c-1)

Throwaway code, not part of CutVii. It answers one question: can the two small Real-ESRGAN models run
locally through ONNX Runtime from Rust (`ort`), on the CPU, tile by tile?

    cargo run --release -- <model.onnx> <in.png> <out.png> <tile px> <cpu|coreml>

Models are NOT in the repository. For the spike they were downloaded by hand from the Real-ESRGAN release
page and converted to ONNX with a short PyTorch script kept outside the project.
