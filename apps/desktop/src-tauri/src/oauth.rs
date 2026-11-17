//! Google / GitHub sign-in of the desktop app (RFC 8252, "OAuth 2.0 for Native Apps"): the provider's page opens in
//! the default browser, never in the application window (providers refuse embedded webviews, and the window must not
//! leave the application, see windows.rs). The authentication service returns to a one-shot server on the loopback
//! interface, `http://127.0.0.1:<port>/auth/callback?code=…`; the interface exchanges the code with its PKCE verifier,
//! which never leaves the application (apps/web: ext/account/src/ui/library/auth.ts).

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

use tauri::WebviewWindow;

/// Time left to sign in in the browser.
const WAIT: Duration = Duration::from_secs(300);
const CALLBACK: &str = "/auth/callback";
const PAGE: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Solidus</title></head>\
<body style=\"font:16px system-ui,sans-serif;text-align:center;margin-top:20vh;color:#222\">\
<h1 style=\"font-size:22px\">Solidus</h1><p>Vous pouvez fermer cet onglet et revenir à l'application.</p>\
<p style=\"color:#666\">You can close this tab and return to the application.</p></body></html>";

/// Opens `authorize_url` (https; `{redirect}` is replaced by the encoded loopback address) in the default browser
/// and returns the query string of the return (`code=…` or `error=…`).
#[tauri::command]
pub async fn oauth_loopback(window: WebviewWindow, authorize_url: String) -> Result<String, String> {
    if !authorize_url.starts_with("https://") || !authorize_url.contains("{redirect}") {
        return Err("adresse d'autorisation refusée".into());
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http%3A%2F%2F127.0.0.1%3A{port}%2Fauth%2Fcallback");
    crate::links::open_external(authorize_url.replace("{redirect}", &redirect))?;
    let query = tauri::async_runtime::spawn_blocking(move || wait(listener)).await.map_err(|e| e.to_string())??;
    let _ = window.unminimize();
    let _ = window.set_focus();
    Ok(query)
}

fn wait(listener: TcpListener) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(query) = serve(stream) {
                    return Ok(query);
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("délai de connexion dépassé".into())
}

/// Answers one request; the query string if it is the return of the service (other requests, e.g. favicon: 404).
fn serve(mut stream: TcpStream) -> Option<String> {
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut buf = vec![0u8; 16 * 1024];
    let mut n = 0;
    while n < buf.len() {
        let r = stream.read(&mut buf[n..]).ok()?;
        if r == 0 {
            break;
        }
        n += r;
        if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let query = callback_query(&String::from_utf8_lossy(&buf[..n]));
    let (status, body) = if query.is_some() { ("200 OK", PAGE) } else { ("404 Not Found", "") };
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    query
}

/// Query string of `GET /auth/callback?…` (empty without parameters), None for any other request.
fn callback_query(head: &str) -> Option<String> {
    let mut parts = head.lines().next()?.split(' ');
    if parts.next()? != "GET" {
        return None;
    }
    let rest = parts.next()?.strip_prefix(CALLBACK)?;
    match rest.strip_prefix('?') {
        Some(q) => Some(q.to_string()),
        None if rest.is_empty() => Some(String::new()),
        None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_return_only() {
        assert_eq!(callback_query("GET /auth/callback?code=abc&x=1 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_deref(), Some("code=abc&x=1"));
        assert_eq!(callback_query("GET /auth/callback HTTP/1.1\r\n\r\n").as_deref(), Some(""));
        assert_eq!(callback_query("GET /favicon.ico HTTP/1.1\r\n\r\n"), None);
        assert_eq!(callback_query("GET /auth/callbackx?code=a HTTP/1.1\r\n\r\n"), None);
        assert_eq!(callback_query("POST /auth/callback?code=a HTTP/1.1\r\n\r\n"), None);
        assert_eq!(callback_query(""), None);
    }

    #[test]
    fn one_shot_server() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let client = std::thread::spawn(move || {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            s.write_all(b"GET /favicon.ico HTTP/1.1\r\n\r\n").unwrap();
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            s.write_all(b"GET /auth/callback?code=42 HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
            let mut out = String::new();
            s.read_to_string(&mut out).unwrap();
            out
        });
        assert_eq!(wait(listener).unwrap(), "code=42");
        assert!(client.join().unwrap().starts_with("HTTP/1.1 200 OK"));
    }
}
