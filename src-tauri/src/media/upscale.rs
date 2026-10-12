//! AI upscale: make a picture four times larger with a small Real-ESRGAN network, on this computer.
//!
//! The models are NOT part of CutVii. The official project publishes them only as PyTorch checkpoints
//! (`.pth`), so the exact official file is downloaded (size and SHA-256 pinned, after the user agrees) and
//! turned into an ONNX model here, in Rust, without PyTorch:
//!
//! 1. a `.pth` is a ZIP of uncompressed entries: a pickle that names every tensor (which storage, what
//!    shape) and one raw little-endian float file per storage. Only that much of ZIP and of pickle is read;
//!    the pickle is treated as DATA (nothing in it is called), and anything unexpected is an error.
//! 2. the network ("SRVGGNetCompact") is a stack of 3x3 convolutions with PReLU, a pixel shuffle, and the
//!    nearest-neighbour enlarged input added back. Its shape is taken from the tensors themselves.
//! 3. that is written out as an ONNX file (the few protobuf messages needed are encoded by hand) and run
//!    with ONNX Runtime on the CPU, in overlapping tiles so memory stays small whatever the picture size.
//!
//! Licences: the Real-ESRGAN code is BSD-3-Clause. Its release page states no licence for the weight files;
//! the UI says so before the download. ONNX Runtime is MIT.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use ort::session::Session;
use ort::value::Tensor;

use crate::errors::{AppError, AppResult};

/// The network enlarges by this factor.
pub const SCALE: usize = 4;
/// Input pixels a tile covers, and how far it reads beyond that so tile borders do not show.
pub const TILE: usize = 192;
pub const OVERLAP: usize = 12;
/// The longer side of a picture that can be upscaled: four times this is the largest result.
pub const MAX_INPUT_SIDE: u32 = 2048;
/// A checkpoint larger than this is not read (the real ones are under 5 MB).
pub const MAX_PTH_BYTES: usize = 64 * 1024 * 1024;
const MAX_LAYERS: usize = 200;
const MAX_CHANNELS: usize = 256;

#[derive(Clone, Copy)]
pub struct UpscaleModel {
    pub id: &'static str,
    pub label: &'static str,
    pub approx_mb: f32,
    pub file: &'static str,
    pub url: &'static str,
    /// Exact size and SHA-256 of the published file: nothing else is accepted.
    pub bytes: u64,
    pub sha256: &'static str,
}

/// The models offered, from the Real-ESRGAN project's own release page (tag v0.2.5.0).
pub const MODELS: &[UpscaleModel] = &[
    UpscaleModel {
        id: "general",
        label: "General (photos and video)",
        approx_mb: 4.7,
        file: "realesr-general-x4v3.pth",
        url: "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth",
        bytes: 4_885_111,
        sha256: "8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292",
    },
    UpscaleModel {
        id: "animation",
        label: "Animation (drawn pictures, faster)",
        approx_mb: 2.4,
        file: "realesr-animevideov3.pth",
        url: "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-animevideov3.pth",
        bytes: 2_504_012,
        sha256: "b8a8376811077954d82ca3fcf476f1ac3da3e8a68a4f4d71363008000a18b75d",
    },
];

pub fn model(id: &str) -> AppResult<&'static UpscaleModel> {
    MODELS
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| AppError::InvalidInput("unknown upscale model".into()))
}

fn bad(what: &str) -> AppError {
    AppError::InvalidInput(format!("the upscale model file is not usable: {what}"))
}

// ---------------------------------------------------------------------------------------------------
// ZIP: uncompressed entries only
// ---------------------------------------------------------------------------------------------------

fn u16_at(b: &[u8], at: usize) -> Option<usize> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?) as usize)
}
fn u32_at(b: &[u8], at: usize) -> Option<usize> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?) as usize)
}

/// The stored (uncompressed) entries of a ZIP archive: name -> byte range in `bytes`.
fn zip_entries(bytes: &[u8]) -> AppResult<HashMap<String, (usize, usize)>> {
    let no = || bad("not a checkpoint archive");
    // the end-of-central-directory record is in the last 64 KB
    let from = bytes.len().saturating_sub(66_000);
    let eocd = (from..bytes.len().saturating_sub(21))
        .rev()
        .find(|i| bytes[*i..].starts_with(&[0x50, 0x4b, 0x05, 0x06]))
        .ok_or_else(no)?;
    let count = u16_at(bytes, eocd + 10).ok_or_else(no)?;
    let mut at = u32_at(bytes, eocd + 16).ok_or_else(no)?;
    let mut out = HashMap::new();
    for _ in 0..count {
        if !bytes
            .get(at..)
            .is_some_and(|b| b.starts_with(&[0x50, 0x4b, 0x01, 0x02]))
        {
            return Err(no());
        }
        let method = u16_at(bytes, at + 10).ok_or_else(no)?;
        let size = u32_at(bytes, at + 20).ok_or_else(no)?;
        let (name_len, extra_len, comment_len) = (
            u16_at(bytes, at + 28).ok_or_else(no)?,
            u16_at(bytes, at + 30).ok_or_else(no)?,
            u16_at(bytes, at + 32).ok_or_else(no)?,
        );
        let local = u32_at(bytes, at + 42).ok_or_else(no)?;
        let name = String::from_utf8_lossy(bytes.get(at + 46..at + 46 + name_len).ok_or_else(no)?)
            .into_owned();
        if method != 0 {
            return Err(bad("it is compressed in a way CutVii does not read"));
        }
        // the data follows the local header, whose name and extra field have their own lengths
        if !bytes
            .get(local..)
            .is_some_and(|b| b.starts_with(&[0x50, 0x4b, 0x03, 0x04]))
        {
            return Err(no());
        }
        let start = local
            + 30
            + u16_at(bytes, local + 26).ok_or_else(no)?
            + u16_at(bytes, local + 28).ok_or_else(no)?;
        if start.checked_add(size).is_none_or(|end| end > bytes.len()) {
            return Err(no());
        }
        out.insert(name, (start, size));
        at += 46 + name_len + extra_len + comment_len;
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------------
// Pickle: just enough to read a state dict as data
// ---------------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum Val {
    None,
    Int(i64),
    Str(String),
    Tuple(Vec<Val>),
    Dict(Vec<(Val, Val)>),
    /// A name from the pickle (`module.name`). Never called: only recognised.
    Global(String),
    /// A storage: its file name inside the archive.
    Storage(String),
    Tensor {
        key: String,
        offset: usize,
        shape: Vec<usize>,
    },
    Mark,
    Other,
}

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}
impl Reader<'_> {
    fn take(&mut self, n: usize) -> AppResult<&[u8]> {
        let s = self
            .b
            .get(self.at..self.at + n)
            .ok_or_else(|| bad("its index is cut short"))?;
        self.at += n;
        Ok(s)
    }
    fn byte(&mut self) -> AppResult<u8> {
        Ok(self.take(1)?[0])
    }
    fn line(&mut self) -> AppResult<String> {
        let rest = &self.b[self.at.min(self.b.len())..];
        let end = rest
            .iter()
            .position(|c| *c == b'\n')
            .ok_or_else(|| bad("its index is cut short"))?;
        let s = String::from_utf8_lossy(&rest[..end]).into_owned();
        self.at += end + 1;
        Ok(s)
    }
}

/// What a recognised function makes of its arguments. Everything else becomes `Other`: no code runs.
fn reduce(callable: &Val, args: Val) -> Val {
    let Val::Global(name) = callable else {
        return Val::Other;
    };
    let Val::Tuple(args) = args else {
        return Val::Other;
    };
    match name.as_str() {
        "collections.OrderedDict" => Val::Dict(Vec::new()),
        "torch._utils._rebuild_tensor_v2" => match (args.first(), args.get(1), args.get(2)) {
            (Some(Val::Storage(key)), Some(Val::Int(offset)), Some(Val::Tuple(dims)))
                if *offset >= 0 =>
            {
                let shape: Option<Vec<usize>> = dims
                    .iter()
                    .map(|d| match d {
                        Val::Int(n) if *n >= 0 => Some(*n as usize),
                        _ => None,
                    })
                    .collect();
                match shape {
                    Some(shape) => Val::Tensor {
                        key: key.clone(),
                        offset: *offset as usize,
                        shape,
                    },
                    None => Val::Other,
                }
            }
            _ => Val::Other,
        },
        // a parameter is its tensor
        "torch._utils._rebuild_parameter" => args.into_iter().next().unwrap_or(Val::Other),
        _ => Val::Other,
    }
}

/// A tensor a checkpoint names: (name, storage file, offset in elements, shape).
type NamedTensor = (String, String, usize, Vec<usize>);

/// Read the pickle of a checkpoint and return every tensor it names: (name, storage file, offset, shape).
fn read_state_dict(pickle: &[u8]) -> AppResult<Vec<NamedTensor>> {
    let mut r = Reader { b: pickle, at: 0 };
    let mut stack: Vec<Val> = Vec::new();
    let mut memo: HashMap<u32, Val> = HashMap::new();
    let underflow = || bad("its index is damaged");
    let pop_mark = |stack: &mut Vec<Val>| -> AppResult<Vec<Val>> {
        let at = stack
            .iter()
            .rposition(|v| matches!(v, Val::Mark))
            .ok_or_else(underflow)?;
        let items = stack.split_off(at + 1);
        stack.pop();
        Ok(items)
    };
    let top = loop {
        if stack.len() > 100_000 {
            return Err(bad("its index is too large"));
        }
        let op = r.byte()?;
        match op {
            0x80 => {
                r.byte()?;
            }
            b'.' => break stack.pop().ok_or_else(underflow)?,
            b'}' => stack.push(Val::Dict(Vec::new())),
            b']' | b')' => stack.push(Val::Tuple(Vec::new())),
            b'(' => stack.push(Val::Mark),
            b'N' => stack.push(Val::None),
            0x88 | 0x89 => stack.push(Val::Int((op == 0x88) as i64)),
            b'K' => {
                let v = r.byte()? as i64;
                stack.push(Val::Int(v));
            }
            b'M' => {
                let v = u16::from_le_bytes(r.take(2)?.try_into().unwrap()) as i64;
                stack.push(Val::Int(v));
            }
            b'J' => {
                let v = i32::from_le_bytes(r.take(4)?.try_into().unwrap()) as i64;
                stack.push(Val::Int(v));
            }
            0x8a => {
                // a long of n bytes, little-endian, signed
                let n = r.byte()? as usize;
                if n > 8 {
                    return Err(bad("its index has a number CutVii does not read"));
                }
                let mut buf = [0u8; 8];
                let raw = r.take(n)?;
                buf[..n].copy_from_slice(raw);
                if n > 0 && raw[n - 1] & 0x80 != 0 {
                    buf[n..].fill(0xff);
                }
                stack.push(Val::Int(i64::from_le_bytes(buf)));
            }
            b'G' => {
                r.take(8)?;
                stack.push(Val::Other);
            }
            b'X' => {
                let n = u32::from_le_bytes(r.take(4)?.try_into().unwrap()) as usize;
                let s = String::from_utf8_lossy(r.take(n)?).into_owned();
                stack.push(Val::Str(s));
            }
            b'c' => {
                let (module, name) = (r.line()?, r.line()?);
                stack.push(Val::Global(format!("{module}.{name}")));
            }
            b'q' => {
                let k = r.byte()? as u32;
                memo.insert(k, stack.last().cloned().ok_or_else(underflow)?);
            }
            b'r' => {
                let k = u32::from_le_bytes(r.take(4)?.try_into().unwrap());
                memo.insert(k, stack.last().cloned().ok_or_else(underflow)?);
            }
            b'h' => {
                let k = r.byte()? as u32;
                stack.push(memo.get(&k).cloned().ok_or_else(underflow)?);
            }
            b'j' => {
                let k = u32::from_le_bytes(r.take(4)?.try_into().unwrap());
                stack.push(memo.get(&k).cloned().ok_or_else(underflow)?);
            }
            b't' => {
                let items = pop_mark(&mut stack)?;
                stack.push(Val::Tuple(items));
            }
            0x85..=0x87 => {
                let n = (op - 0x84) as usize;
                if stack.len() < n {
                    return Err(underflow());
                }
                let items = stack.split_off(stack.len() - n);
                stack.push(Val::Tuple(items));
            }
            b'e' => {
                let items = pop_mark(&mut stack)?;
                if let Some(Val::Tuple(list)) = stack.last_mut() {
                    list.extend(items);
                }
            }
            b'a' => {
                let item = stack.pop().ok_or_else(underflow)?;
                if let Some(Val::Tuple(list)) = stack.last_mut() {
                    list.push(item);
                }
            }
            b'Q' => {
                // ("storage", <storage type>, file name, device, element count)
                let id = stack.pop().ok_or_else(underflow)?;
                let storage = match id {
                    Val::Tuple(parts) => match (parts.first(), parts.get(1), parts.get(2)) {
                        (Some(Val::Str(kind)), Some(Val::Global(ty)), Some(Val::Str(key)))
                            if kind == "storage" && ty == "torch.FloatStorage" =>
                        {
                            Val::Storage(key.clone())
                        }
                        _ => Val::Other,
                    },
                    _ => Val::Other,
                };
                stack.push(storage);
            }
            b'R' => {
                let args = stack.pop().ok_or_else(underflow)?;
                let callable = stack.pop().ok_or_else(underflow)?;
                stack.push(reduce(&callable, args));
            }
            b's' => {
                let value = stack.pop().ok_or_else(underflow)?;
                let key = stack.pop().ok_or_else(underflow)?;
                if let Some(Val::Dict(d)) = stack.last_mut() {
                    d.push((key, value));
                }
            }
            b'u' => {
                let items = pop_mark(&mut stack)?;
                if let Some(Val::Dict(d)) = stack.last_mut() {
                    let mut it = items.into_iter();
                    while let (Some(k), Some(v)) = (it.next(), it.next()) {
                        d.push((k, v));
                    }
                }
            }
            b'b' => {
                // BUILD: state for an object we do not model
                stack.pop().ok_or_else(underflow)?;
            }
            _ => return Err(bad("its index uses something CutVii does not read")),
        }
    };

    // {"params": {...}} or {"params_ema": {...}} or the dict of tensors itself
    let Val::Dict(top) = top else {
        return Err(bad("it holds no weights"));
    };
    let inner = ["params_ema", "params"].iter().find_map(|want| {
        top.iter().find_map(|(k, v)| match (k, v) {
            (Val::Str(k), Val::Dict(d)) if k == want => Some(d.clone()),
            _ => None,
        })
    });
    let entries = inner.unwrap_or(top);
    let mut out = Vec::new();
    for (k, v) in entries {
        if let (Val::Str(name), Val::Tensor { key, offset, shape }) = (k, v) {
            out.push((name, key, offset, shape));
        }
    }
    if out.is_empty() {
        return Err(bad("it holds no weights"));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------------
// The network
// ---------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum Layer {
    /// 3x3 convolution, padding 1: weights `[out, in, 3, 3]`, one bias per output channel.
    Conv {
        out_channels: usize,
        in_channels: usize,
        weight: Vec<f32>,
        bias: Vec<f32>,
    },
    /// One slope per channel.
    PRelu { slope: Vec<f32> },
}

/// Read a Real-ESRGAN "compact" checkpoint into its layers, checking that it is that kind of network:
/// `body.N` layers in order, 3x3 convolutions from 3 channels to `3 * SCALE^2`, PReLU in between.
pub fn layers_from_pth(bytes: &[u8]) -> AppResult<Vec<Layer>> {
    if bytes.len() > MAX_PTH_BYTES {
        return Err(bad("it is too large"));
    }
    let entries = zip_entries(bytes)?;
    let (root, pickle) = entries
        .iter()
        .find_map(|(name, range)| {
            name.strip_suffix("/data.pkl")
                .map(|root| (root.to_string(), *range))
        })
        .ok_or_else(|| bad("it has no index"))?;
    let tensors = read_state_dict(&bytes[pickle.0..pickle.0 + pickle.1])?;

    let floats = |key: &str, offset: usize, shape: &[usize]| -> AppResult<Vec<f32>> {
        if key.is_empty() || !key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') {
            return Err(bad("its index names a strange file"));
        }
        let (start, size) = *entries
            .get(&format!("{root}/data/{key}"))
            .ok_or_else(|| bad("a weight file is missing"))?;
        let count = shape
            .iter()
            .try_fold(1usize, |n, d| n.checked_mul(*d))
            .filter(|n| *n <= 50_000_000)
            .ok_or_else(|| bad("a weight is too large"))?;
        let from = offset
            .checked_mul(4)
            .ok_or_else(|| bad("its index is damaged"))?;
        let to = from
            .checked_add(count * 4)
            .filter(|end| *end <= size)
            .ok_or_else(|| bad("a weight file is cut short"))?;
        let values: Vec<f32> = bytes[start + from..start + to]
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        if values.iter().any(|v| !v.is_finite()) {
            return Err(bad("it holds values that are not numbers"));
        }
        Ok(values)
    };

    // body.<index>.weight / body.<index>.bias
    let mut by_index: HashMap<usize, (Option<usize>, Option<usize>)> = HashMap::new();
    for (i, (name, ..)) in tensors.iter().enumerate() {
        let mut parts = name.split('.');
        let (Some("body"), Some(index), Some(kind), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(bad("it is not a Real-ESRGAN compact model"));
        };
        let index: usize = index
            .parse()
            .map_err(|_| bad("it is not a Real-ESRGAN compact model"))?;
        let slot = by_index.entry(index).or_default();
        match kind {
            "weight" => slot.0 = Some(i),
            "bias" => slot.1 = Some(i),
            _ => return Err(bad("it is not a Real-ESRGAN compact model")),
        }
    }
    if by_index.is_empty() || by_index.len() > MAX_LAYERS {
        return Err(bad("it has an unexpected number of layers"));
    }
    let mut layers = Vec::new();
    let mut channels = 3usize;
    for index in 0..by_index.len() {
        let (weight, bias) = by_index
            .get(&index)
            .copied()
            .ok_or_else(|| bad("a layer is missing"))?;
        let w = &tensors[weight.ok_or_else(|| bad("a layer has no weights"))?];
        match (w.3.as_slice(), bias) {
            ([out_channels, in_channels, 3, 3], Some(bias)) => {
                if *in_channels != channels || *out_channels == 0 || *out_channels > MAX_CHANNELS {
                    return Err(bad("its layers do not fit together"));
                }
                let b = &tensors[bias];
                if b.3 != [*out_channels] {
                    return Err(bad("its layers do not fit together"));
                }
                layers.push(Layer::Conv {
                    out_channels: *out_channels,
                    in_channels: *in_channels,
                    weight: floats(&w.1, w.2, &w.3)?,
                    bias: floats(&b.1, b.2, &b.3)?,
                });
                channels = *out_channels;
            }
            ([n], None) if *n == channels => layers.push(Layer::PRelu {
                slope: floats(&w.1, w.2, &w.3)?,
            }),
            _ => return Err(bad("it has a layer CutVii does not know")),
        }
    }
    if channels != 3 * SCALE * SCALE || !matches!(layers.last(), Some(Layer::Conv { .. })) {
        return Err(bad("it is not a 4x model"));
    }
    Ok(layers)
}

// ---------------------------------------------------------------------------------------------------
// ONNX, written by hand (protobuf: varints and length-delimited fields)
// ---------------------------------------------------------------------------------------------------

fn varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8 & 0x7f) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}
fn field_varint(out: &mut Vec<u8>, field: u32, v: u64) {
    varint(out, (field as u64) << 3);
    varint(out, v);
}
fn field_bytes(out: &mut Vec<u8>, field: u32, bytes: &[u8]) {
    varint(out, ((field as u64) << 3) | 2);
    varint(out, bytes.len() as u64);
    out.extend_from_slice(bytes);
}
/// TensorProto: dims = 1, data_type = 2 (1 = float), name = 8, raw_data = 9.
fn tensor(name: &str, dims: &[usize], values: &[f32]) -> Vec<u8> {
    let mut t = Vec::with_capacity(values.len() * 4 + 64);
    for d in dims {
        field_varint(&mut t, 1, *d as u64);
    }
    field_varint(&mut t, 2, 1);
    field_bytes(&mut t, 8, name.as_bytes());
    let raw: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
    field_bytes(&mut t, 9, &raw);
    t
}

enum Attr<'a> {
    Int(i64),
    Ints(&'a [i64]),
    Str(&'a str),
}

/// AttributeProto: name = 1, i = 3, s = 4, ints = 8, type = 20 (2 = INT, 3 = STRING, 7 = INTS).
fn attribute(name: &str, value: Attr) -> Vec<u8> {
    let mut a = Vec::new();
    field_bytes(&mut a, 1, name.as_bytes());
    match value {
        Attr::Int(v) => {
            field_varint(&mut a, 3, v as u64);
            field_varint(&mut a, 20, 2);
        }
        Attr::Str(s) => {
            field_bytes(&mut a, 4, s.as_bytes());
            field_varint(&mut a, 20, 3);
        }
        Attr::Ints(vs) => {
            for v in vs {
                field_varint(&mut a, 8, *v as u64);
            }
            field_varint(&mut a, 20, 7);
        }
    }
    a
}

/// NodeProto: input = 1, output = 2, name = 3, op_type = 4, attribute = 5.
fn node(op: &str, inputs: &[&str], output: &str, attrs: Vec<Vec<u8>>) -> Vec<u8> {
    let mut n = Vec::new();
    for i in inputs {
        field_bytes(&mut n, 1, i.as_bytes());
    }
    field_bytes(&mut n, 2, output.as_bytes());
    field_bytes(&mut n, 3, output.as_bytes());
    field_bytes(&mut n, 4, op.as_bytes());
    for a in attrs {
        field_bytes(&mut n, 5, &a);
    }
    n
}

/// ValueInfoProto for a float picture tensor `[1, 3, h, w]` whose height and width are free.
fn picture_info(name: &str, h: &str, w: &str) -> Vec<u8> {
    let dim_value = |v: u64| {
        let mut d = Vec::new();
        field_varint(&mut d, 1, v);
        d
    };
    let dim_param = |p: &str| {
        let mut d = Vec::new();
        field_bytes(&mut d, 2, p.as_bytes());
        d
    };
    let mut shape = Vec::new();
    for d in [dim_value(1), dim_value(3), dim_param(h), dim_param(w)] {
        field_bytes(&mut shape, 1, &d);
    }
    let mut tensor_type = Vec::new();
    field_varint(&mut tensor_type, 1, 1); // elem_type float
    field_bytes(&mut tensor_type, 2, &shape);
    let mut ty = Vec::new();
    field_bytes(&mut ty, 1, &tensor_type);
    let mut info = Vec::new();
    field_bytes(&mut info, 1, name.as_bytes());
    field_bytes(&mut info, 2, &ty);
    info
}

/// The network as an ONNX model: input `input` `[1, 3, h, w]` in 0..1, output `output` `[1, 3, 4h, 4w]`.
pub fn onnx_from_layers(layers: &[Layer]) -> Vec<u8> {
    let mut graph = Vec::new();
    let mut initializers: Vec<Vec<u8>> = Vec::new();
    let mut current = "input".to_string();
    for (i, layer) in layers.iter().enumerate() {
        let out = format!("l{i}");
        match layer {
            Layer::Conv {
                out_channels,
                in_channels,
                weight,
                bias,
            } => {
                let (w, b) = (format!("w{i}"), format!("b{i}"));
                initializers.push(tensor(&w, &[*out_channels, *in_channels, 3, 3], weight));
                initializers.push(tensor(&b, &[*out_channels], bias));
                let attrs = vec![
                    attribute("kernel_shape", Attr::Ints(&[3, 3])),
                    attribute("pads", Attr::Ints(&[1, 1, 1, 1])),
                    attribute("strides", Attr::Ints(&[1, 1])),
                ];
                field_bytes(
                    &mut graph,
                    1,
                    &node("Conv", &[&current, &w, &b], &out, attrs),
                );
            }
            Layer::PRelu { slope } => {
                let s = format!("s{i}");
                // one slope per channel, broadcast over height and width
                initializers.push(tensor(&s, &[slope.len(), 1, 1], slope));
                field_bytes(&mut graph, 1, &node("PRelu", &[&current, &s], &out, vec![]));
            }
        }
        current = out;
    }
    // pixel shuffle = DepthToSpace in "CRD" order
    let attrs = vec![
        attribute("blocksize", Attr::Int(SCALE as i64)),
        attribute("mode", Attr::Str("CRD")),
    ];
    field_bytes(
        &mut graph,
        1,
        &node("DepthToSpace", &[&current], "shuffled", attrs),
    );
    // the input enlarged by nearest neighbour, exactly as PyTorch's `interpolate(mode="nearest")`
    initializers.push(tensor(
        "scales",
        &[4],
        &[1.0, 1.0, SCALE as f32, SCALE as f32],
    ));
    let attrs = vec![
        attribute("mode", Attr::Str("nearest")),
        attribute("coordinate_transformation_mode", Attr::Str("asymmetric")),
        attribute("nearest_mode", Attr::Str("floor")),
    ];
    field_bytes(
        &mut graph,
        1,
        &node("Resize", &["input", "", "scales"], "base", attrs),
    );
    field_bytes(
        &mut graph,
        1,
        &node("Add", &["shuffled", "base"], "output", vec![]),
    );

    field_bytes(&mut graph, 2, b"cutvii-upscale");
    for init in &initializers {
        field_bytes(&mut graph, 5, init);
    }
    field_bytes(&mut graph, 11, &picture_info("input", "h", "w"));
    field_bytes(&mut graph, 12, &picture_info("output", "H", "W"));

    // ModelProto: ir_version = 1, producer_name = 2, graph = 7, opset_import = 8 (version = 2)
    let mut model = Vec::with_capacity(graph.len() + 64);
    field_varint(&mut model, 1, 8);
    field_bytes(&mut model, 2, b"CutVii");
    field_bytes(&mut model, 7, &graph);
    let mut opset = Vec::new();
    field_varint(&mut opset, 2, 17);
    field_bytes(&mut model, 8, &opset);
    model
}

/// The ONNX model for an official checkpoint.
pub fn onnx_from_pth(bytes: &[u8]) -> AppResult<Vec<u8>> {
    Ok(onnx_from_layers(&layers_from_pth(bytes)?))
}

// ---------------------------------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------------------------------

fn failed(what: &str, e: ort::Error) -> AppError {
    AppError::InvalidInput(format!("AI upscale {what}: {e}"))
}

pub struct Upscaler {
    session: Session,
}

impl Upscaler {
    /// Load an ONNX model (from `onnx_from_pth`). Runs on the CPU.
    pub fn new(onnx: &[u8]) -> AppResult<Self> {
        let session = Session::builder()
            .map_err(|e| failed("could not start", e))?
            .commit_from_memory(onnx)
            .map_err(|e| failed("could not load the model", e))?;
        Ok(Self { session })
    }

    /// Run the network on one float picture `[3, h, w]` (planar, 0..1). Returns `[3, 4h, 4w]`.
    pub fn run_planar(&mut self, chw: Vec<f32>, w: usize, h: usize) -> AppResult<Vec<f32>> {
        let tensor =
            Tensor::from_array(([1usize, 3, h, w], chw)).map_err(|e| failed("failed", e))?;
        let outputs = self
            .session
            .run(ort::inputs!["input" => tensor])
            .map_err(|e| failed("failed", e))?;
        let (shape, data) = outputs["output"]
            .try_extract_tensor::<f32>()
            .map_err(|e| failed("failed", e))?;
        if shape.len() != 4 || shape[2] as usize != h * SCALE || shape[3] as usize != w * SCALE {
            return Err(AppError::InvalidInput(
                "AI upscale gave a picture of the wrong size".into(),
            ));
        }
        Ok(data.to_vec())
    }

    /// Enlarge an RGB picture (`w * h * 3` bytes) four times, tile by tile. `progress` gets 0.0..=1.0; set
    /// `cancel` to stop early.
    pub fn upscale_rgb(
        &mut self,
        rgb: &[u8],
        w: usize,
        h: usize,
        progress: &mut dyn FnMut(f64),
        cancel: &AtomicBool,
    ) -> AppResult<Vec<u8>> {
        if w == 0 || h == 0 || rgb.len() != w * h * 3 {
            return Err(AppError::InvalidInput(
                "the picture could not be read".into(),
            ));
        }
        let mut out = vec![0u8; w * SCALE * h * SCALE * 3];
        let total = h.div_ceil(TILE) * w.div_ceil(TILE);
        let mut done = 0usize;
        let mut y0 = 0;
        while y0 < h {
            let y1 = (y0 + TILE).min(h);
            let mut x0 = 0;
            while x0 < w {
                if cancel.load(Ordering::Relaxed) {
                    return Err(AppError::Cancelled);
                }
                let x1 = (x0 + TILE).min(w);
                // the tile plus its overlap, clamped to the picture
                let (px0, py0) = (x0.saturating_sub(OVERLAP), y0.saturating_sub(OVERLAP));
                let (px1, py1) = ((x1 + OVERLAP).min(w), (y1 + OVERLAP).min(h));
                let (tw, th) = (px1 - px0, py1 - py0);
                let mut chw = vec![0f32; 3 * tw * th];
                for y in 0..th {
                    for x in 0..tw {
                        let s = ((py0 + y) * w + px0 + x) * 3;
                        for c in 0..3 {
                            chw[c * tw * th + y * tw + x] = rgb[s + c] as f32 / 255.0;
                        }
                    }
                }
                let data = self.run_planar(chw, tw, th)?;
                let (ow, oh) = (tw * SCALE, th * SCALE);
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
                done += 1;
                progress(done as f64 / total as f64);
                x0 = x1;
            }
            y0 = y1;
        }
        Ok(out)
    }
}

/// Halve an RGB picture by averaging 2x2 blocks (for "2x": upscale four times, then halve).
pub fn halve_rgb(rgb: &[u8], w: usize, h: usize) -> (Vec<u8>, usize, usize) {
    let (ow, oh) = (w / 2, h / 2);
    let mut out = vec![0u8; ow * oh * 3];
    for y in 0..oh {
        for x in 0..ow {
            for c in 0..3 {
                let at = |dx: usize, dy: usize| rgb[((y * 2 + dy) * w + x * 2 + dx) * 3 + c] as u32;
                out[(y * ow + x) * 3 + c] =
                    ((at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1) + 2) / 4) as u8;
            }
        }
    }
    (out, ow, oh)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tiny network of our own (random weights, 2,196 numbers), saved by PyTorch like a real checkpoint,
    /// with what PyTorch computes for a fixed input. Made by a script kept outside the project.
    const TINY_PTH: &[u8] = include_bytes!("../../fixtures/tiny-compact.pth");
    const TINY_JSON: &str = include_str!("../../fixtures/tiny-compact.json");

    #[derive(serde::Deserialize)]
    struct Expected {
        input_shape: Vec<usize>,
        input: Vec<f32>,
        output_shape: Vec<usize>,
        output: Vec<f32>,
    }

    #[test]
    fn a_checkpoint_is_read_as_layers_that_fit_together() {
        let layers = layers_from_pth(TINY_PTH).unwrap();
        let kinds: Vec<&str> = layers
            .iter()
            .map(|l| match l {
                Layer::Conv { .. } => "conv",
                Layer::PRelu { .. } => "prelu",
            })
            .collect();
        assert_eq!(
            kinds,
            ["conv", "prelu", "conv", "prelu", "conv", "prelu", "conv"]
        );
        let Layer::Conv {
            out_channels,
            in_channels,
            weight,
            bias,
        } = &layers[0]
        else {
            panic!()
        };
        assert_eq!(
            (*out_channels, *in_channels, weight.len(), bias.len()),
            (4, 3, 4 * 3 * 9, 4)
        );
        let Layer::Conv { out_channels, .. } = layers.last().unwrap() else {
            panic!()
        };
        assert_eq!(*out_channels, 48, "three colours times a 4x4 pixel shuffle");
    }

    #[test]
    fn the_onnx_we_write_computes_what_pytorch_computes() {
        let expected: Expected = serde_json::from_str(TINY_JSON).unwrap();
        let (h, w) = (expected.input_shape[2], expected.input_shape[3]);
        let mut upscaler = Upscaler::new(&onnx_from_pth(TINY_PTH).unwrap()).unwrap();
        let got = upscaler.run_planar(expected.input.clone(), w, h).unwrap();
        assert_eq!(got.len(), expected.output.len());
        assert_eq!(expected.output_shape, [1, 3, h * SCALE, w * SCALE]);
        let worst = got
            .iter()
            .zip(&expected.output)
            .map(|(a, b)| (a - b).abs())
            .fold(0f32, f32::max);
        assert!(worst < 1e-4, "largest difference from PyTorch: {worst}");
    }

    #[test]
    fn tiles_give_the_same_picture_as_one_pass_and_cancel_stops() {
        let mut upscaler = Upscaler::new(&onnx_from_pth(TINY_PTH).unwrap()).unwrap();
        // wider than one tile, so there is a seam to get right
        let (w, h) = (TILE + 40, 30);
        let rgb: Vec<u8> = (0..w * h * 3)
            .map(|i| ((i * 37 + i / 7) % 256) as u8)
            .collect();
        let mut seen = Vec::new();
        let tiled = upscaler
            .upscale_rgb(&rgb, w, h, &mut |f| seen.push(f), &AtomicBool::new(false))
            .unwrap();
        assert_eq!(tiled.len(), w * 4 * h * 4 * 3);
        assert_eq!(seen.last(), Some(&1.0));
        assert!(seen.len() >= 2 && seen.windows(2).all(|p| p[0] < p[1]));

        // the whole picture in one pass
        let mut chw = vec![0f32; 3 * w * h];
        for i in 0..w * h {
            for c in 0..3 {
                chw[c * w * h + i] = rgb[i * 3 + c] as f32 / 255.0;
            }
        }
        let whole = upscaler.run_planar(chw, w, h).unwrap();
        let (ow, oh) = (w * 4, h * 4);
        let mut worst = 0i32;
        for i in 0..ow * oh {
            for c in 0..3 {
                let one = (whole[c * ow * oh + i].clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                worst = worst.max((one as i32 - tiled[i * 3 + c] as i32).abs());
            }
        }
        // this little network sees 4 pixels around each pixel, well inside the 12 px overlap
        // (one level of rounding is allowed: the two passes are separate floating-point runs)
        assert!(worst <= 1, "a tile seam shows: {worst} levels");

        let stop = AtomicBool::new(true);
        assert!(matches!(
            upscaler.upscale_rgb(&rgb, w, h, &mut |_| {}, &stop),
            Err(AppError::Cancelled)
        ));
        assert!(
            upscaler
                .upscale_rgb(&rgb[1..], w, h, &mut |_| {}, &AtomicBool::new(false))
                .is_err()
        );
    }

    #[test]
    fn files_that_are_not_such_a_checkpoint_are_refused() {
        let refuse = |bytes: &[u8]| layers_from_pth(bytes).unwrap_err().to_string();
        assert!(refuse(b"not a zip at all").contains("not a checkpoint archive"));
        assert!(refuse(&[0u8; 100]).contains("not a checkpoint archive"));
        // a real archive cut short, and one with a byte of its index changed to an unknown instruction
        assert!(layers_from_pth(&TINY_PTH[..TINY_PTH.len() / 2]).is_err());
        let entries = zip_entries(TINY_PTH).unwrap();
        let (start, _) = entries
            .iter()
            .find(|(n, _)| n.ends_with("/data.pkl"))
            .unwrap()
            .1;
        let mut broken = TINY_PTH.to_vec();
        broken[*start + 2] = 0x01;
        assert!(layers_from_pth(&broken).is_err());
        // a checkpoint whose index asks for a function to be called is only ever read as data
        let mut call = TINY_PTH.to_vec();
        let at = call.windows(11).position(|w| w == b"OrderedDict").unwrap();
        call[at..at + 11].copy_from_slice(b"os_systemXX");
        assert!(
            layers_from_pth(&call).is_err(),
            "an unknown name gives no weights"
        );
    }

    #[test]
    fn the_models_on_offer_are_pinned_to_the_official_files() {
        assert_eq!(
            MODELS.iter().map(|m| m.id).collect::<Vec<_>>(),
            ["general", "animation"]
        );
        for m in MODELS {
            assert!(
                m.url
                    .starts_with("https://github.com/xinntao/Real-ESRGAN/releases/download/")
            );
            assert!(m.url.ends_with(m.file));
            assert_eq!(m.sha256.len(), 64);
            assert!(m.bytes > 1_000_000);
        }
        assert!(model("nope").is_err());
    }

    #[test]
    fn halving_averages_two_by_two() {
        let rgb = [
            10, 0, 0, 20, 0, 0, 30, 0, 0, 40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ];
        // 4 wide, 2 high -> 2 wide, 1 high
        let (out, w, h) = halve_rgb(&rgb, 4, 2);
        assert_eq!((w, h), (2, 1));
        assert_eq!(out, [8, 0, 0, 18, 0, 0]);
    }

    /// The real models, when they are on this machine (never downloaded by a test):
    /// `CUTVII_UPSCALE_PTH=/path/to/realesr-general-x4v3.pth cargo test real_checkpoint -- --ignored`
    #[test]
    #[ignore]
    fn real_checkpoint_converts_and_runs() {
        let path = std::env::var("CUTVII_UPSCALE_PTH").expect("set CUTVII_UPSCALE_PTH");
        let bytes = std::fs::read(&path).unwrap();
        let layers = layers_from_pth(&bytes).unwrap();
        let onnx = onnx_from_layers(&layers);
        if let Ok(out) = std::env::var("CUTVII_UPSCALE_ONNX_OUT") {
            std::fs::write(out, &onnx).unwrap();
        }
        let mut upscaler = Upscaler::new(&onnx).unwrap();
        let (w, h) = (64, 48);
        let rgb: Vec<u8> = (0..w * h * 3).map(|i| ((i * 13) % 256) as u8).collect();
        let out = upscaler
            .upscale_rgb(&rgb, w, h, &mut |_| {}, &AtomicBool::new(false))
            .unwrap();
        assert_eq!(out.len(), w * 4 * h * 4 * 3);
        eprintln!("{path}: {} layers, onnx {} bytes", layers.len(), onnx.len());
    }
}
