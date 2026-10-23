//! Media for the preview over plain HTTP on 127.0.0.1, used on Linux only.
//!
//! WebKitGTK plays `<video>` / `<audio>` through GStreamer, which does not play media from the `asset:` custom
//! scheme (thumbnails, which are `<img>`, load fine from it), even with every decoder installed. Plain HTTP it
//! does play. So on Linux the webview asks for media here instead.
//!
//! Rules: bound to 127.0.0.1 only, every URL carries a random token made at start, only GET / HEAD, and only
//! files the asset-protocol scope already allows (the same check `asset:` makes), so nothing new is exposed.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::thread;

use tauri::{AppHandle, Manager};

/// `http://127.0.0.1:<port>/<token>`, set once the server runs.
static BASE: OnceLock<String> = OnceLock::new();

/// The base URL media paths go under, or nothing when the server is not used (every system but Linux).
#[tauri::command]
pub fn media_server_url() -> Option<String> {
    BASE.get().cloned()
}

/// Starts the server on Linux; elsewhere the webview plays `asset:` URLs itself.
pub fn start(app: &AppHandle) {
    if !cfg!(target_os = "linux") {
        return;
    }
    let app = app.clone();
    let allowed = move |path: &Path| app.asset_protocol_scope().is_allowed(path);
    match serve(allowed) {
        Ok(base) => {
            let _ = BASE.set(base);
        }
        Err(e) => eprintln!("media server did not start: {e}"),
    }
}

/// Binds a free port and answers requests on background threads. Returns the base URL.
fn serve(allowed: impl Fn(&Path) -> bool + Send + Sync + 'static) -> io::Result<String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let token = new_token();
    let base = format!("http://127.0.0.1:{}/{token}", listener.local_addr()?.port());
    let allowed = Arc::new(allowed);
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let allowed = Arc::clone(&allowed);
            let token = token.clone();
            thread::spawn(move || {
                let _ = answer(stream, &token, allowed.as_ref());
            });
        }
    });
    Ok(base)
}

/// 128 random bits as hex, from the standard library's randomly keyed hasher.
fn new_token() -> String {
    (0..2)
        .map(|i| {
            let mut h = RandomState::new().build_hasher();
            h.write_u64(i);
            format!("{:016x}", h.finish())
        })
        .collect()
}

struct Request {
    head: bool,
    target: String,
    range: Option<String>,
}

fn read_request(stream: &TcpStream) -> io::Result<Option<Request>> {
    let mut reader = BufReader::new(stream.take(16 * 1024));
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (Some(method), Some(target)) = (parts.next(), parts.next()) else {
        return Ok(None);
    };
    let head = match method {
        "GET" => false,
        "HEAD" => true,
        _ => return Ok(None),
    };
    let mut range = None;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 || header.trim().is_empty() {
            break;
        }
        let found = header
            .split_once(':')
            .filter(|(name, _)| name.trim().eq_ignore_ascii_case("range"));
        if let Some((_, value)) = found {
            range = Some(value.trim().to_string());
        }
    }
    Ok(Some(Request {
        head,
        target: target.to_string(),
        range,
    }))
}

fn answer(mut stream: TcpStream, token: &str, allowed: &dyn Fn(&Path) -> bool) -> io::Result<()> {
    let Some(request) = read_request(&stream)? else {
        return status(&mut stream, "405 Method Not Allowed");
    };
    let Some(path) = file_for(&request.target, token) else {
        return status(&mut stream, "404 Not Found");
    };
    if !allowed(&path) || !path.is_file() {
        return status(&mut stream, "404 Not Found");
    }
    let mut file = std::fs::File::open(&path)?;
    let size = file.metadata()?.len();
    let (code, start, end) = match request.range.as_deref().map(|r| byte_range(r, size)) {
        None => ("200 OK", 0, size.saturating_sub(1)),
        Some(Some((start, end))) => ("206 Partial Content", start, end),
        Some(None) => {
            let head = format!(
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{size}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            return stream.write_all(head.as_bytes());
        }
    };
    let length = if size == 0 { 0 } else { end - start + 1 };
    let mut head = format!(
        "HTTP/1.1 {code}\r\nContent-Type: {}\r\nContent-Length: {length}\r\nAccept-Ranges: bytes\r\n\
         Access-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n",
        content_type(&path)
    );
    if code.starts_with("206") {
        head.push_str(&format!("Content-Range: bytes {start}-{end}/{size}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    if !request.head && length > 0 {
        file.seek(SeekFrom::Start(start))?;
        // the player often hangs up mid-file when it seeks: not an error worth reporting
        let _ = io::copy(&mut file.take(length), &mut stream);
    }
    Ok(())
}

fn status(stream: &mut TcpStream, code: &str) -> io::Result<()> {
    stream.write_all(
        format!("HTTP/1.1 {code}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes(),
    )
}

/// `/<token>/<percent-encoded absolute path>` to the path, or nothing for a wrong token or a broken path.
fn file_for(target: &str, token: &str) -> Option<PathBuf> {
    let target = target.split(['?', '#']).next()?;
    let rest = target
        .strip_prefix('/')?
        .strip_prefix(token)?
        .strip_prefix('/')?;
    let path = PathBuf::from(percent_decode(rest)?);
    path.is_absolute().then_some(path)
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    let decoded = String::from_utf8(out).ok()?;
    (!decoded.contains('\0')).then_some(decoded)
}

/// One `bytes=` range as inclusive (start, end), or nothing when it cannot be served.
fn byte_range(header: &str, size: u64) -> Option<(u64, u64)> {
    let spec = header.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (from, to) = spec.split_once('-')?;
    if size == 0 {
        return None;
    }
    let last = size - 1;
    let (start, end) = if from.is_empty() {
        let suffix: u64 = to.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        (size.saturating_sub(suffix), last)
    } else {
        let start: u64 = from.parse().ok()?;
        let end = if to.is_empty() {
            last
        } else {
            to.parse::<u64>().ok()?.min(last)
        };
        (start, end)
    };
    (start <= end && start <= last).then_some((start, end))
}

fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "flac" => "audio/flac",
        "opus" => "audio/opus",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(base: &str, path: &str, range: Option<&str>) -> (String, Vec<u8>) {
        let rest = base.strip_prefix("http://").unwrap();
        let (host, prefix) = rest.split_once('/').unwrap();
        let mut stream = TcpStream::connect(host).unwrap();
        let range = range.map(|r| format!("Range: {r}\r\n")).unwrap_or_default();
        write!(
            stream,
            "GET /{prefix}{path} HTTP/1.1\r\nHost: {host}\r\n{range}\r\n"
        )
        .unwrap();
        let mut reply = Vec::new();
        stream.read_to_end(&mut reply).unwrap();
        let split = reply.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        (
            String::from_utf8_lossy(&reply[..split]).into_owned(),
            reply[split + 4..].to_vec(),
        )
    }

    fn encode(path: &Path) -> String {
        path.to_string_lossy()
            .bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect()
    }

    #[test]
    fn serves_allowed_files_with_ranges_and_nothing_else() {
        let dir = std::env::temp_dir().join(format!("cutvii-media-server-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("clip one.mp4");
        std::fs::write(&file, b"0123456789").unwrap();
        let secret = dir.join("secret.txt");
        std::fs::write(&secret, b"no").unwrap();
        let allowed_file = file.clone();
        let base = serve(move |p| p == allowed_file).unwrap();

        let (head, body) = get(&base, &format!("/{}", encode(&file)), None);
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        assert!(head.contains("Content-Type: video/mp4"));
        assert!(head.contains("Accept-Ranges: bytes"));
        assert_eq!(body, b"0123456789");

        let (head, body) = get(&base, &format!("/{}", encode(&file)), Some("bytes=2-5"));
        assert!(head.starts_with("HTTP/1.1 206"), "{head}");
        assert!(head.contains("Content-Range: bytes 2-5/10"));
        assert_eq!(body, b"2345");

        let (head, body) = get(&base, &format!("/{}", encode(&file)), Some("bytes=7-"));
        assert!(head.contains("Content-Range: bytes 7-9/10"));
        assert_eq!(body, b"789");

        let (head, _) = get(&base, &format!("/{}", encode(&file)), Some("bytes=50-"));
        assert!(head.starts_with("HTTP/1.1 416"), "{head}");

        // a file outside the scope, and a wrong token, get nothing
        let (head, body) = get(&base, &format!("/{}", encode(&secret)), None);
        assert!(head.starts_with("HTTP/1.1 404"), "{head}");
        assert!(body.is_empty());
        let wrong = base.rsplit_once('/').unwrap().0.to_string() + "/0000";
        let (head, _) = get(&wrong, &format!("/{}", encode(&file)), None);
        assert!(head.starts_with("HTTP/1.1 404"), "{head}");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ranges_and_paths_are_checked() {
        assert_eq!(byte_range("bytes=0-", 10), Some((0, 9)));
        assert_eq!(byte_range("bytes=-3", 10), Some((7, 9)));
        assert_eq!(byte_range("bytes=4-100", 10), Some((4, 9)));
        assert_eq!(byte_range("bytes=9-2", 10), None);
        assert_eq!(byte_range("bytes=0-", 0), None);
        assert_eq!(byte_range("items=0-1", 10), None);
        if !cfg!(unix) {
            return; // the paths below are Unix paths
        }
        assert_eq!(
            file_for("/tok/%2Fhome%2Fa%20b.mp4", "tok"),
            Some(PathBuf::from("/home/a b.mp4"))
        );
        assert_eq!(file_for("/other/%2Fhome%2Fa.mp4", "tok"), None);
        assert_eq!(file_for("/tok/relative.mp4", "tok"), None);
        assert_eq!(file_for("/tok/%2Fa%00b", "tok"), None);
        assert_eq!(file_for("/tok/%2Fa%zz", "tok"), None);
    }
}
