//! A listening HTTP server on localhost, which TSX cannot open itself: the MCP endpoint the agents'
//! Claude Code connects to, the `tb-browser` bridge, the Feishu OAuth redirect. hyper serves on the
//! crate's runtime; each request crosses to the engine thread, where `serve` hands it to the TSX
//! handler (an async function is fine) and the answer crosses back.

use std::net::SocketAddr;

use bytes::Bytes;
use futures::stream::{FuturesUnordered, StreamExt};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use nsh_core::prelude::*;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};

use crate::process::runtime;

/// One header.
#[derive(Debug, Clone, JsObject)]
pub struct Header {
    pub name: String,
    pub value: String,
}

/// A request as the TSX handler sees it.
#[derive(Debug, Clone, JsObject)]
pub struct HttpRequest {
    /// `GET`, `POST`…
    pub method: String,
    /// The path with its query string, e.g. `/mcp?x=1`.
    pub url: String,
    pub headers: Vec<Header>,
    /// The body as text (UTF-8, lossy).
    pub body: String,
}

/// What the TSX handler answers with.
#[derive(Debug, Clone, JsObject)]
pub struct HttpResponse {
    pub status: u32,
    pub headers: Option<Vec<Header>>,
    pub body: Option<String>,
}

struct Pending {
    request: HttpRequest,
    reply: oneshot::Sender<HttpResponse>,
}

/// A local HTTP server: `start()` binds, `serve(handler)` answers until `stop()`.
#[class]
pub struct HttpServer {
    port: u32,
    inbox: Option<mpsc::UnboundedReceiver<Pending>>,
    stop: Option<oneshot::Sender<()>>,
}

#[class]
impl HttpServer {
    /// A server not yet listening.
    pub fn new() -> Self {
        HttpServer { port: 0, inbox: None, stop: None }
    }

    /// Binds 127.0.0.1 on `port` (a free one when 0 or left out); resolves with the port.
    pub async fn start(this: Instance<Self>, port: Option<u32>) -> Result<u32, String> {
        let wanted = port.unwrap_or(0) as u16;
        let (bound_tx, bound_rx) = oneshot::channel::<Result<(TcpListener, u16), String>>();
        runtime().spawn(async move {
            let result = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], wanted)))
                .await
                .and_then(|l| l.local_addr().map(|a| (l, a.port())))
                .map_err(|e| e.to_string());
            let _ = bound_tx.send(result);
        });
        let (listener, port) = bound_rx.await.map_err(|_| "bind task died".to_owned())??;
        let (events, inbox) = mpsc::unbounded_channel::<Pending>();
        let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
        this.with_mut(|server| {
            server.port = port as u32;
            server.inbox = Some(inbox);
            server.stop = Some(stop_tx);
        });
        runtime().spawn(async move {
            loop {
                let accepted = tokio::select! {
                    _ = &mut stop_rx => break,
                    accepted = listener.accept() => accepted,
                };
                let Ok((stream, _)) = accepted else { continue };
                let events = events.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |request: hyper::Request<Incoming>| {
                        let events = events.clone();
                        async move {
                            let (parts, body) = request.into_parts();
                            let bytes = body.collect().await.map(|b| b.to_bytes()).unwrap_or_default();
                            let request = HttpRequest {
                                method: parts.method.to_string(),
                                url: parts.uri.path_and_query().map(|p| p.to_string()).unwrap_or_else(|| "/".to_owned()),
                                headers: parts
                                    .headers
                                    .iter()
                                    .map(|(n, v)| Header { name: n.to_string(), value: String::from_utf8_lossy(v.as_bytes()).into_owned() })
                                    .collect(),
                                body: String::from_utf8_lossy(&bytes).into_owned(),
                            };
                            let (reply, answer) = oneshot::channel();
                            let response = if events.send(Pending { request, reply }).is_ok() {
                                answer.await.unwrap_or(HttpResponse { status: 503, headers: None, body: Some("no handler".to_owned()) })
                            } else {
                                HttpResponse { status: 503, headers: None, body: Some("server stopped".to_owned()) }
                            };
                            let mut builder = hyper::Response::builder().status(response.status as u16);
                            for Header { name, value } in response.headers.unwrap_or_default() {
                                builder = builder.header(name, value);
                            }
                            builder.body(Full::new(Bytes::from(response.body.unwrap_or_default())))
                        }
                    });
                    let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
                });
            }
        });
        Ok(port as u32)
    }

    /// Answers requests with `handler` (sync or async) until `stop()`; call it once after `start()`.
    pub async fn serve(this: Instance<Self>, #[args(request)] handler: Callback<HttpRequest, HttpResponse>) {
        let Some(mut inbox) = this.with_mut(|server| server.inbox.take()) else { return };
        let mut answers = FuturesUnordered::new();
        loop {
            tokio::select! {
                next = inbox.recv() => {
                    let Some(Pending { request, reply }) = next else { break };
                    let answer = handler.call_async(request);
                    answers.push(async move {
                        let response = match answer.await {
                            Ok(response) => response,
                            Err(error) => HttpResponse { status: 500, headers: None, body: Some(error) },
                        };
                        let _ = reply.send(response);
                    });
                }
                _ = answers.next(), if !answers.is_empty() => {}
            }
        }
    }

    /// Stops listening; open connections end.
    pub fn stop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.inbox = None;
    }

    /// The port it listens on (0 before `start()`).
    #[getter]
    pub fn port(&self) -> u32 {
        self.port
    }
}
