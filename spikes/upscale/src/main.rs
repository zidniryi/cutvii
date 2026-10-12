//! Upscale spike: run a 4x Real-ESRGAN "compact" ONNX model over a PNG in overlapping tiles.
use std::time::Instant;

use ort::ep::{CPU, CoreML};
use ort::session::Session;
use ort::value::Tensor;

const SCALE: usize = 4;
/// Input pixels each tile reads beyond what it keeps, so tile borders do not show.
const OVERLAP: usize = 12;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let a: Vec<String> = std::env::args().collect();
    let (model, input, output, tile, provider) = (&a[1], &a[2], &a[3], a[4].parse::<usize>()?, a[5].as_str());

    let load = Instant::now();
    let builder = Session::builder()?;
    let mut session = match provider {
        // a provider that cannot be set up falls back to the CPU instead of failing
        "coreml" => builder
            .with_execution_providers([
                CoreML::default().build(),
                CPU::default().build(),
            ])?
            .commit_from_file(model)?,
        _ => builder
            .with_execution_providers([CPU::default().build()])?
            .commit_from_file(model)?,
    };
    let load_ms = load.elapsed().as_millis();

    let img = image::open(input)?.to_rgb8();
    let (w, h) = (img.width() as usize, img.height() as usize);
    let src = img.as_raw();
    let mut out = vec![0u8; w * SCALE * h * SCALE * 3];

    let run = Instant::now();
    let mut tiles = 0;
    let mut worst = 0u128;
    let mut y0 = 0;
    while y0 < h {
        let y1 = (y0 + tile).min(h);
        let mut x0 = 0;
        while x0 < w {
            let x1 = (x0 + tile).min(w);
            // the tile plus its overlap, clamped to the picture
            let (px0, py0) = (x0.saturating_sub(OVERLAP), y0.saturating_sub(OVERLAP));
            let (px1, py1) = ((x1 + OVERLAP).min(w), (y1 + OVERLAP).min(h));
            let (tw, th) = (px1 - px0, py1 - py0);
            let mut chw = vec![0f32; 3 * tw * th];
            for y in 0..th {
                for x in 0..tw {
                    let s = ((py0 + y) * w + px0 + x) * 3;
                    for c in 0..3 {
                        chw[c * tw * th + y * tw + x] = src[s + c] as f32 / 255.0;
                    }
                }
            }
            let t = Instant::now();
            let tensor = Tensor::from_array(([1usize, 3, th, tw], chw))?;
            let outputs = session.run(ort::inputs!["input" => tensor])?;
            let (shape, data) = outputs["output"].try_extract_tensor::<f32>()?;
            worst = worst.max(t.elapsed().as_millis());
            let (oh, ow) = (shape[2] as usize, shape[3] as usize);
            assert_eq!((oh, ow), (th * SCALE, tw * SCALE));
            // keep only the tile's own part
            for y in (y0 * SCALE)..(y1 * SCALE) {
                for x in (x0 * SCALE)..(x1 * SCALE) {
                    let (ty, tx) = (y - py0 * SCALE, x - px0 * SCALE);
                    let d = (y * w * SCALE + x) * 3;
                    for c in 0..3 {
                        let v = data[c * oh * ow + ty * ow + tx];
                        out[d + c] = (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                    }
                }
            }
            tiles += 1;
            x0 = x1;
        }
        y0 = y1;
    }
    let run_ms = run.elapsed().as_millis();
    image::RgbImage::from_raw((w * SCALE) as u32, (h * SCALE) as u32, out)
        .ok_or("bad output size")?
        .save(output)?;
    println!(
        "{provider} {w}x{h} -> {}x{} tile {tile}: load {load_ms} ms, run {run_ms} ms, {tiles} tiles, slowest tile {worst} ms",
        w * SCALE,
        h * SCALE
    );
    Ok(())
}
