//! Pixel work behind text styles: outlines, soft shadows and glows, and background boxes. Everything here
//! works on plain coverage layers (`f32` 0..=1, row by row) of a region of the canvas, and is pure, so the
//! one text rasterizer (`text.rs`) gives the preview and the export the very same picture.

const FAR: f32 = 1.0e20;

/// One-dimensional squared distance transform (Felzenszwalb & Huttenlocher).
fn distance_1d(f: &[f32], out: &mut [f32], v: &mut [usize], z: &mut [f32]) {
    let n = f.len();
    let mut k = 0usize;
    v[0] = 0;
    z[0] = -FAR;
    z[1] = FAR;
    for q in 1..n {
        loop {
            let p = v[k];
            let s =
                ((f[q] + (q * q) as f32) - (f[p] + (p * p) as f32)) / (2.0 * (q as f32 - p as f32));
            if s <= z[k] && k > 0 {
                k -= 1;
            } else {
                k += 1;
                v[k] = q;
                z[k] = s;
                z[k + 1] = FAR;
                break;
            }
        }
    }
    k = 0;
    for (q, slot) in out.iter_mut().enumerate() {
        while z[k + 1] < q as f32 {
            k += 1;
        }
        let p = v[k];
        *slot = (q as f32 - p as f32).powi(2) + f[p];
    }
}

/// Distance in pixels from every pixel to the nearest one the shape covers (coverage at least half);
/// 0 inside the shape.
pub fn distance_outside(mask: &[f32], w: usize, h: usize) -> Vec<f32> {
    let mut d: Vec<f32> = mask
        .iter()
        .map(|&a| if a >= 0.5 { 0.0 } else { FAR })
        .collect();
    let longest = w.max(h);
    let (mut f, mut out) = (vec![0.0; longest], vec![0.0; longest]);
    let (mut v, mut z) = (vec![0usize; longest], vec![0.0; longest + 1]);
    for x in 0..w {
        for y in 0..h {
            f[y] = d[y * w + x];
        }
        distance_1d(&f[..h], &mut out[..h], &mut v, &mut z);
        for y in 0..h {
            d[y * w + x] = out[y];
        }
    }
    for y in 0..h {
        let row = &mut d[y * w..(y + 1) * w];
        f[..w].copy_from_slice(row);
        distance_1d(&f[..w], &mut out[..w], &mut v, &mut z);
        row.copy_from_slice(&out[..w]);
    }
    for value in &mut d {
        *value = value.sqrt();
    }
    d
}

/// The shape grown by `radius` pixels all round (the shape itself included): a pixel `d` pixels away from
/// the shape is covered while `d` is at most `radius`, and fades out over the next pixel.
pub fn outline(mask: &[f32], w: usize, h: usize, radius: f32) -> Vec<f32> {
    distance_outside(mask, w, h)
        .iter()
        .zip(mask)
        .map(|(d, a)| (radius + 1.0 - d).clamp(0.0, 1.0).max(*a))
        .collect()
}

/// The layer moved by whole pixels; what leaves the region is lost.
pub fn shifted(src: &[f32], w: usize, h: usize, dx: i32, dy: i32) -> Vec<f32> {
    let mut out = vec![0.0; src.len()];
    for y in 0..h as i32 {
        let from_y = y - dy;
        if from_y < 0 || from_y >= h as i32 {
            continue;
        }
        for x in 0..w as i32 {
            let from_x = x - dx;
            if from_x >= 0 && from_x < w as i32 {
                out[y as usize * w + x as usize] = src[from_y as usize * w + from_x as usize];
            }
        }
    }
    out
}

fn box_pass(src: &[f32], dst: &mut [f32], len: usize, stride: usize, radius: usize) {
    let window = (2 * radius + 1) as f32;
    let mut sum = 0.0;
    for i in 0..=radius.min(len - 1) {
        sum += src[i * stride];
    }
    for i in 0..len {
        dst[i * stride] = sum / window;
        if i + radius + 1 < len {
            sum += src[(i + radius + 1) * stride];
        }
        if i >= radius {
            sum -= src[(i - radius) * stride];
        }
    }
}

/// Soften a layer: three box blurs each way, which is very close to a Gaussian of about `radius` pixels.
pub fn blur(layer: &mut Vec<f32>, w: usize, h: usize, radius: usize) {
    if radius == 0 || w == 0 || h == 0 {
        return;
    }
    let mut tmp = vec![0.0; layer.len()];
    for _ in 0..3 {
        for y in 0..h {
            box_pass(&layer[y * w..], &mut tmp[y * w..], w, 1, radius);
        }
        for x in 0..w {
            box_pass(&tmp[x..], &mut layer[x..], h, w, radius);
        }
    }
}

/// A rectangle given by its edges, in region pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

/// Add a rounded rectangle to a layer (keeping whichever coverage is larger where shapes meet).
pub fn rounded_rect(layer: &mut [f32], w: usize, h: usize, r: Rect, radius: f32) {
    let radius = radius
        .min((r.x1 - r.x0) / 2.0)
        .min((r.y1 - r.y0) / 2.0)
        .max(0.0);
    let (cx, cy) = ((r.x0 + r.x1) / 2.0, (r.y0 + r.y1) / 2.0);
    let (hx, hy) = ((r.x1 - r.x0) / 2.0 - radius, (r.y1 - r.y0) / 2.0 - radius);
    let rows = (r.y0.floor().max(0.0) as usize)..(r.y1.ceil().min(h as f32) as usize);
    let cols = (r.x0.floor().max(0.0) as usize)..(r.x1.ceil().min(w as f32) as usize);
    for y in rows {
        for x in cols.clone() {
            // signed distance to the rounded box, measured at the pixel centre
            let qx = (x as f32 + 0.5 - cx).abs() - hx;
            let qy = (y as f32 + 0.5 - cy).abs() - hy;
            let outside =
                (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt() + qx.max(qy).min(0.0) - radius;
            let cover = (0.5 - outside).clamp(0.0, 1.0);
            let slot = &mut layer[y * w + x];
            *slot = slot.max(cover);
        }
    }
}

/// How far a zigzag edge is pushed in at height `t` (in teeth): 0 at a tip, 1 at a notch.
fn zigzag(t: f32) -> f32 {
    (2.0 * (t - t.floor()) - 1.0).abs()
}

/// Add a box whose left and right edges are cut into a zigzag: teeth `tooth` pixels deep and twice as tall,
/// the right edge half a tooth out of step with the left so the two sides do not mirror each other. Our own
/// shape; the top and bottom stay straight so stacked lines of text sit on it cleanly.
pub fn jagged_rect(layer: &mut [f32], w: usize, h: usize, r: Rect, tooth: f32) {
    let tooth = tooth.max(0.0).min((r.x1 - r.x0) / 4.0);
    let period = (tooth * 2.0).max(1.0);
    let rows = (r.y0.floor().max(0.0) as usize)..(r.y1.ceil().min(h as f32) as usize);
    for y in rows {
        let centre = y as f32 + 0.5;
        let vertical = ((centre - r.y0) + 0.5)
            .clamp(0.0, 1.0)
            .min(((r.y1 - centre) + 0.5).clamp(0.0, 1.0));
        let t = (centre - r.y0) / period;
        let left = r.x0 + tooth * zigzag(t);
        let right = r.x1 - tooth * zigzag(t + 0.5);
        let cols = (left.floor().max(0.0) as usize)..(right.ceil().min(w as f32) as usize);
        for x in cols {
            let px = x as f32;
            let horizontal = (px + 1.0 - left)
                .clamp(0.0, 1.0)
                .min((right - px).clamp(0.0, 1.0));
            let slot = &mut layer[y * w + x];
            *slot = slot.max(horizontal * vertical);
        }
    }
}

/// A picture being built up layer by layer: premultiplied colour and coverage per pixel.
pub struct Canvas {
    rgb: Vec<[f32; 3]>,
    alpha: Vec<f32>,
}

impl Canvas {
    pub fn new(pixels: usize) -> Self {
        Self {
            rgb: vec![[0.0; 3]; pixels],
            alpha: vec![0.0; pixels],
        }
    }

    /// Lay a single-colour layer over what is there ("over" compositing). `strength` scales the layer.
    pub fn paint(&mut self, coverage: &[f32], color: (u8, u8, u8), strength: f32) {
        let c = [color.0 as f32, color.1 as f32, color.2 as f32];
        for (i, cover) in coverage.iter().enumerate() {
            let a = (cover * strength).clamp(0.0, 1.0);
            if a <= 0.0 {
                continue;
            }
            for k in 0..3 {
                self.rgb[i][k] = c[k] * a + self.rgb[i][k] * (1.0 - a);
            }
            self.alpha[i] = a + self.alpha[i] * (1.0 - a);
        }
    }

    /// The pixel as straight (not premultiplied) 8-bit RGBA, or `None` where nothing was painted.
    pub fn pixel(&self, i: usize) -> Option<[u8; 4]> {
        let a = self.alpha[i];
        let alpha = (a * 255.0).round() as u8;
        if alpha == 0 {
            return None;
        }
        let channel = |k: usize| (self.rgb[i][k] / a).round().clamp(0.0, 255.0) as u8;
        Some([channel(0), channel(1), channel(2), alpha])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `w` x `h` layer with a filled square from (x0, y0) to (x1, y1) exclusive.
    fn square(w: usize, h: usize, x0: usize, y0: usize, x1: usize, y1: usize) -> Vec<f32> {
        let mut m = vec![0.0; w * h];
        for y in y0..y1 {
            for x in x0..x1 {
                m[y * w + x] = 1.0;
            }
        }
        m
    }

    #[test]
    fn distances_are_measured_to_the_nearest_covered_pixel() {
        let (w, h) = (20, 12);
        let d = distance_outside(&square(w, h, 8, 4, 12, 8), w, h);
        let at = |x: usize, y: usize| d[y * w + x];
        assert_eq!(at(9, 5), 0.0, "inside");
        assert_eq!(at(7, 5), 1.0);
        assert_eq!(at(4, 5), 4.0);
        assert_eq!(at(9, 0), 4.0);
        assert!(
            (at(5, 1) - (3.0f32 * 3.0 + 3.0 * 3.0).sqrt()).abs() < 1e-4,
            "diagonal: {}",
            at(5, 1)
        );
        // nothing covered at all: far everywhere, and no panic on a 1-pixel layer
        assert!(
            distance_outside(&vec![0.0; 6], 3, 2)
                .iter()
                .all(|v| *v > 1e6)
        );
        assert_eq!(distance_outside(&[1.0], 1, 1), vec![0.0]);
    }

    #[test]
    fn an_outline_grows_the_shape_evenly_and_rounds_its_corners() {
        let (w, h) = (30, 30);
        let o = outline(&square(w, h, 12, 12, 18, 18), w, h, 3.5);
        let at = |x: usize, y: usize| o[y * w + x];
        assert_eq!(at(14, 14), 1.0, "the shape itself");
        assert_eq!(at(9, 14), 1.0, "three pixels to the left");
        assert_eq!(at(14, 20), 1.0, "three pixels below");
        assert_eq!(at(7, 14), 0.0, "five pixels away");
        assert!(at(8, 14) > 0.0 && at(8, 14) < 1.0, "a soft edge");
        assert_eq!(at(8, 8), 0.0, "the corner is rounded, not square");
        assert!(at(10, 10) > 0.5);
    }

    #[test]
    fn blur_spreads_a_shape_and_keeps_its_weight() {
        let (w, h) = (40, 40);
        let mut m = square(w, h, 18, 18, 22, 22);
        let before: f32 = m.iter().sum();
        blur(&mut m, w, h, 3);
        let after: f32 = m.iter().sum();
        assert!((before - after).abs() < 0.05, "{before} vs {after}");
        assert!(
            m[20 * w + 20] < 1.0 && m[20 * w + 20] > 0.1,
            "the middle is fainter"
        );
        assert!(m[20 * w + 12] > 0.0, "and it reaches further out");
        assert_eq!(m[2 * w + 2], 0.0);
        let mut same = square(w, h, 18, 18, 22, 22);
        blur(&mut same, w, h, 0);
        assert_eq!(
            same,
            square(w, h, 18, 18, 22, 22),
            "radius 0 changes nothing"
        );

        let moved = shifted(&square(w, h, 18, 18, 22, 22), w, h, 5, -3);
        assert_eq!(moved[16 * w + 24], 1.0);
        assert_eq!(moved[19 * w + 19], 0.0);
        assert!(
            shifted(&square(w, h, 0, 0, 4, 4), w, h, -10, 0)
                .iter()
                .all(|v| *v == 0.0)
        );
    }

    #[test]
    fn boxes_are_filled_with_round_corners_or_a_zigzag_edge() {
        let (w, h) = (60, 40);
        let r = Rect {
            x0: 10.0,
            y0: 8.0,
            x1: 50.0,
            y1: 32.0,
        };
        let mut round = vec![0.0; w * h];
        rounded_rect(&mut round, w, h, r, 8.0);
        let at = |m: &[f32], x: usize, y: usize| m[y * w + x];
        assert_eq!(at(&round, 30, 20), 1.0);
        assert_eq!(
            at(&round, 10, 20),
            1.0,
            "the straight part of the left edge"
        );
        assert_eq!(at(&round, 10, 8), 0.0, "the corner is cut away");
        assert!(
            at(&round, 12, 10) > 0.0 && at(&round, 12, 10) < 1.0,
            "smoothly"
        );
        assert_eq!(at(&round, 9, 20), 0.0);
        let mut sharp = vec![0.0; w * h];
        rounded_rect(&mut sharp, w, h, r, 0.0);
        assert_eq!(at(&sharp, 10, 8), 1.0, "no radius: a plain rectangle");
        // a rectangle partly outside the layer is simply cut off
        rounded_rect(
            &mut sharp,
            w,
            h,
            Rect {
                x0: -20.0,
                y0: -20.0,
                x1: 5.0,
                y1: 5.0,
            },
            2.0,
        );
        assert_eq!(at(&sharp, 0, 0), 1.0);

        let mut jag = vec![0.0; w * h];
        jagged_rect(&mut jag, w, h, r, 4.0);
        assert_eq!(at(&jag, 30, 20), 1.0);
        // the left edge moves in and out by the tooth depth as it goes down
        let left_edge = |y: usize| (0..w).find(|x| at(&jag, *x, y) > 0.5).unwrap();
        let edges: Vec<usize> = (9..31).map(left_edge).collect();
        let (tip, notch) = (*edges.iter().min().unwrap(), *edges.iter().max().unwrap());
        assert!(
            tip <= 11 && notch == 14,
            "teeth about four pixels deep: {edges:?}"
        );
        assert!(
            edges.windows(2).filter(|p| p[0] != p[1]).count() > 8,
            "it really zigzags: {edges:?}"
        );
        assert!(
            (0..w).all(|x| at(&jag, x, 6) == 0.0),
            "nothing above the box"
        );
    }

    #[test]
    fn layers_are_painted_over_each_other_and_come_out_as_straight_colour() {
        let mut c = Canvas::new(3);
        c.paint(&[1.0, 0.5, 0.0], (255, 0, 0), 1.0);
        c.paint(&[1.0, 0.0, 0.0], (0, 0, 255), 0.5);
        assert_eq!(
            c.pixel(0),
            Some([128, 0, 128, 255]),
            "half blue over solid red"
        );
        assert_eq!(
            c.pixel(1),
            Some([255, 0, 0, 128]),
            "a half-covered pixel keeps its full colour"
        );
        assert_eq!(c.pixel(2), None);
    }
}
