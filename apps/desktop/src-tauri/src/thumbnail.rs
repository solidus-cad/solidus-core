//! Thumbnail of the .vpart / .vasm files (`thumbnail.jpg`, stored uncompressed at the root of the zip by the
//! application, see apps/web/src/docfiles/thumbnail.ts), for the thumbnails of the file managers:
//! - Linux: `cad-desktop --thumbnail <file> <output>`, called by the desktop thumbnailers
//!   (linux/solidus.thumbnailer, installed with the .deb);
//! - Windows: Explorer thumbnail handler (apps/desktop/thumbnail-win, which includes this file).
//!
//! Only the central directory and the entry are read, never the whole archive (files with many checkpoints).

/// Name of the entry in the archive.
pub const ENTRY: &str = "thumbnail.jpg";
/// Larger than any thumbnail written by the application: a corrupt or hostile file is not followed further.
const MAX_ENTRY: u64 = 4 * 1024 * 1024;
/// End of central directory record (22 bytes) + maximum comment.
const EOCD_SEARCH: u64 = 22 + 0xFFFF;

fn u16le(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn u32le(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

/// Content of the `thumbnail.jpg` entry of a zip archive of `size` bytes; `read(offset, len)` reads exactly `len`
/// bytes at `offset`. None if absent, compressed (the application stores it as is) or unreadable.
pub fn extract(size: u64, mut read: impl FnMut(u64, usize) -> Option<Vec<u8>>) -> Option<Vec<u8>> {
    // End of central directory: last "PK\5\6" signature of the tail.
    let tail_len = size.min(EOCD_SEARCH);
    let tail = read(size - tail_len, tail_len as usize)?;
    let eocd = (0..tail.len().checked_sub(21)?).rev().find(|&i| tail[i..i + 4] == *b"PK\x05\x06")?;
    let entries = u16le(&tail, eocd + 10)? as usize;
    let cd_size = u32le(&tail, eocd + 12)? as u64;
    let cd_offset = u32le(&tail, eocd + 16)? as u64;
    if cd_offset.checked_add(cd_size)? > size || cd_size > 64 * 1024 * 1024 {
        return None;
    }
    let cd = read(cd_offset, cd_size as usize)?;
    let mut at = 0usize;
    for _ in 0..entries {
        if cd.get(at..at + 4)? != b"PK\x01\x02" {
            return None;
        }
        let method = u16le(&cd, at + 10)?;
        let compressed = u32le(&cd, at + 20)? as u64;
        let name_len = u16le(&cd, at + 28)? as usize;
        let extra_len = u16le(&cd, at + 30)? as usize;
        let comment_len = u16le(&cd, at + 32)? as usize;
        let local = u32le(&cd, at + 42)? as u64;
        let name = cd.get(at + 46..at + 46 + name_len)?;
        if name == ENTRY.as_bytes() {
            if method != 0 || compressed == 0 || compressed > MAX_ENTRY {
                return None;
            }
            // Local header: its name and extra field lengths can differ from the central directory's.
            let header = read(local, 30)?;
            if header.get(0..4)? != b"PK\x03\x04" {
                return None;
            }
            let data = local + 30 + u16le(&header, 26)? as u64 + u16le(&header, 28)? as u64;
            if data.checked_add(compressed)? > size {
                return None;
            }
            let bytes = read(data, compressed as usize)?;
            // JPEG signature: anything else is not passed to the image decoders.
            return (bytes.starts_with(&[0xFF, 0xD8, 0xFF])).then_some(bytes);
        }
        at += 46 + name_len + extra_len + comment_len;
    }
    None
}

/// Thumbnail of a file on disk.
#[cfg_attr(windows, allow(dead_code))]
pub fn extract_file(path: &std::path::Path) -> Option<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    extract(size, |offset, len| {
        f.seek(SeekFrom::Start(offset)).ok()?;
        let mut buf = vec![0; len];
        f.read_exact(&mut buf).ok()?;
        Some(buf)
    })
}

/// `cad-desktop --thumbnail <file> <output> [size]`: writes the JPEG thumbnail of the file to `output` (the desktop
/// thumbnailers read it with gdk-pixbuf, which recognises the format by its content). None: not this mode.
#[cfg(target_os = "linux")]
pub fn cli() -> Option<i32> {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    if args.first().map(|a| a != "--thumbnail").unwrap_or(true) {
        return None;
    }
    let (Some(input), Some(output)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: cad-desktop --thumbnail <file.vpart|file.vasm> <output>");
        return Some(2);
    };
    let input = std::path::Path::new(input);
    // `%i` may be given as a file:// URI by some file managers.
    let decoded;
    let input = match input.to_str().and_then(|s| s.strip_prefix("file://")) {
        Some(rest) => {
            decoded = percent_decode(rest);
            std::path::Path::new(&decoded)
        }
        None => input,
    };
    match extract_file(input).map(|jpg| std::fs::write(output, jpg)) {
        Some(Ok(())) => Some(0),
        _ => Some(1),
    }
}

#[cfg(target_os = "linux")]
fn percent_decode(s: &str) -> std::ffi::OsString {
    use std::os::unix::ffi::OsStringExt;
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    std::ffi::OsString::from_vec(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal zip writer (stored entries), as fflate's `zipSync` with level 0 for the thumbnail.
    fn zip(entries: &[(&str, &[u8], u16)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut cd = Vec::new();
        for (name, data, method) in entries {
            let offset = out.len() as u32;
            let mut h = Vec::new();
            h.extend_from_slice(b"PK\x03\x04");
            h.extend_from_slice(&[20, 0, 0, 0]);
            h.extend_from_slice(&method.to_le_bytes());
            h.extend_from_slice(&[0; 4]); // time, date
            h.extend_from_slice(&[0; 4]); // crc (not checked)
            h.extend_from_slice(&(data.len() as u32).to_le_bytes());
            h.extend_from_slice(&(data.len() as u32).to_le_bytes());
            h.extend_from_slice(&(name.len() as u16).to_le_bytes());
            h.extend_from_slice(&3u16.to_le_bytes()); // extra field longer than in the central directory
            out.extend_from_slice(&h);
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(&[0, 0, 0]);
            out.extend_from_slice(data);
            cd.extend_from_slice(b"PK\x01\x02");
            cd.extend_from_slice(&[20, 0, 20, 0, 0, 0]);
            cd.extend_from_slice(&method.to_le_bytes());
            cd.extend_from_slice(&[0; 8]);
            cd.extend_from_slice(&(data.len() as u32).to_le_bytes());
            cd.extend_from_slice(&(data.len() as u32).to_le_bytes());
            cd.extend_from_slice(&(name.len() as u16).to_le_bytes());
            cd.extend_from_slice(&[0; 12]);
            cd.extend_from_slice(&offset.to_le_bytes());
            cd.extend_from_slice(name.as_bytes());
        }
        let cd_offset = out.len() as u32;
        out.extend_from_slice(&cd);
        out.extend_from_slice(b"PK\x05\x06");
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(cd.len() as u32).to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        out
    }

    fn from(bytes: &[u8]) -> Option<Vec<u8>> {
        extract(bytes.len() as u64, |o, l| bytes.get(o as usize..o as usize + l).map(<[u8]>::to_vec))
    }

    const JPG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 0xFF, 0xD9];

    #[test]
    fn finds_the_stored_thumbnail() {
        let z = zip(&[("document.json", b"{}", 8), (ENTRY, JPG, 0)]);
        assert_eq!(from(&z).as_deref(), Some(JPG));
    }

    #[test]
    fn rejects_missing_compressed_or_not_jpeg() {
        assert_eq!(from(&zip(&[("document.json", b"{}", 0)])), None);
        assert_eq!(from(&zip(&[(ENTRY, JPG, 8)])), None);
        assert_eq!(from(&zip(&[(ENTRY, b"<svg/>", 0)])), None);
        assert_eq!(from(b"not a zip"), None);
        assert_eq!(from(b""), None);
    }

    #[test]
    fn truncated_archive_is_not_read_out_of_bounds() {
        let z = zip(&[(ENTRY, JPG, 0)]);
        for n in 0..z.len() {
            let _ = from(&z[..n]);
        }
    }
}
