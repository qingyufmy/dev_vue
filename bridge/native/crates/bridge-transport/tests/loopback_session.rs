use bridge_contract::{
    AccountRef, HeartbeatMessage, HelloAcknowledgement, HelloMessage, TerminalDescriptor,
};
use bridge_transport::{BridgeAuthClient, BridgeWebSocketSession, ServerEndpoints};
use futures_util::{SinkExt, StreamExt};
use std::collections::BTreeMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

fn hello() -> HelloMessage {
    HelloMessage {
        v: 3,
        message_type: "hello".to_owned(),
        message_id: "hello_01JLOOPBACK".to_owned(),
        sent_at_utc_msc: 1_700_000_000_000,
        session_id: "session_01JLOOPBACK".to_owned(),
        bridge_version: "4.0.0-alpha.1".to_owned(),
        installation_id: None,
        update_report: None,
        terminals: vec![TerminalDescriptor {
            terminal_instance_id: "mt5_terminal_01".to_owned(),
            platform: "mt5".to_owned(),
            account_ref: AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
            },
            connection_epoch: 7,
            worker_version: Some("4.0.0-alpha.1".to_owned()),
        }],
    }
}

#[tokio::test]
async fn refresh_ticket_hello_heartbeat_and_binary_rejection_work_end_to_end() {
    let http_listener = TcpListener::bind("127.0.0.1:0").await.expect("http bind");
    let http_address = http_listener.local_addr().expect("http address");
    let websocket_listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("websocket bind");
    let websocket_address = websocket_listener.local_addr().expect("websocket address");
    let http_task = tokio::spawn(serve_auth(http_listener));
    let (path_sender, path_receiver) = oneshot::channel();
    let websocket_task = tokio::spawn(serve_websocket(websocket_listener, path_sender));

    let endpoints = ServerEndpoints::normalize(
        &format!("http://{http_address}/"),
        &format!("ws://{websocket_address}/"),
    )
    .expect("loopback endpoints");
    let auth = BridgeAuthClient::new(endpoints.clone(), "LiangJian-Bridge-Native-Test/4")
        .expect("auth client");
    let bootstrap = auth.acquire("refresh_fixture").await.expect("bootstrap");
    assert_eq!(bootstrap.bridge_role, "admin");
    assert_eq!(bootstrap.ticket, "ticket_fixture");

    let mut session = BridgeWebSocketSession::connect(&endpoints, &bootstrap.ticket, hello())
        .await
        .expect("websocket session");
    let websocket_path = path_receiver.await.expect("websocket path");
    assert_eq!(
        websocket_path,
        "/aurum-api/bridge/v3/ws?ticket=ticket_fixture"
    );

    let mut streams = BTreeMap::new();
    streams.insert("account".to_owned(), 1_700_000_000_100);
    let heartbeat = HeartbeatMessage {
        v: 3,
        message_type: "heartbeat".to_owned(),
        message_id: "heartbeat_01JLOOP".to_owned(),
        sent_at_utc_msc: 1_700_000_000_101,
        session_id: session.hello().session_id.clone(),
        terminals: vec![bridge_contract::TerminalStreamFreshness {
            terminal_instance_id: "mt5_terminal_01".to_owned(),
            connection_epoch: 7,
            streams,
        }],
    };
    session
        .send_json(serde_json::to_string(&heartbeat).expect("heartbeat json"))
        .await
        .expect("heartbeat send");
    let error = session
        .receive_json()
        .await
        .expect_err("binary frames must fail closed");
    assert_eq!(error.code(), "bridge_websocket_binary_rejected");

    http_task.await.expect("http task");
    websocket_task.await.expect("websocket task");
}

#[tokio::test]
async fn auth_preserves_stable_api_codes_and_rejects_html_error_pages() {
    let code = acquire_error_code(
        "HTTP/1.1 503 Service Unavailable",
        "application/json",
        r#"{"ok":false,"code":"bridge_refresh_unavailable"}"#,
    )
    .await;
    assert_eq!(code, "bridge_refresh_unavailable");

    let code = acquire_error_code(
        "HTTP/1.1 200 OK",
        "text/html; charset=utf-8",
        "<html>proxy login</html>",
    )
    .await;
    assert_eq!(code, "bridge_server_endpoint_unavailable");
}

async fn acquire_error_code(status: &str, content_type: &str, body: &str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("error bind");
    let address = listener.local_addr().expect("error address");
    let status = status.to_owned();
    let content_type = content_type.to_owned();
    let body = body.to_owned();
    let server = tokio::spawn(async move {
        let request = read_http_request(listener.accept().await.expect("error accept").0).await;
        write_http_response(request, &status, &content_type, &body).await;
    });
    let endpoints = ServerEndpoints::normalize(&format!("http://{address}/"), "ws://127.0.0.1:1/")
        .expect("error endpoints");
    let auth =
        BridgeAuthClient::new(endpoints, "LiangJian-Bridge-Native-Test/4").expect("error client");
    let code = auth
        .acquire("refresh_fixture")
        .await
        .expect_err("auth must fail")
        .code()
        .to_owned();
    server.await.expect("error server");
    code
}

async fn serve_auth(listener: TcpListener) {
    let refresh = read_http_request(listener.accept().await.expect("refresh accept").0).await;
    assert!(
        refresh
            .1
            .starts_with("POST /api/auth/bridge-refresh HTTP/1.1")
    );
    assert!(refresh.1.contains("\"refreshToken\":\"refresh_fixture\""));
    write_http_json(
        refresh,
        r#"{"ok":true,"token":"access_fixture","refreshExpiresInSeconds":3600,"bridgeRole":"admin"}"#,
    )
    .await;

    let ticket = read_http_request(listener.accept().await.expect("ticket accept").0).await;
    assert!(
        ticket
            .1
            .starts_with("POST /api/auth/bridge-ticket HTTP/1.1")
    );
    assert!(
        ticket
            .1
            .to_ascii_lowercase()
            .contains("authorization: bearer access_fixture")
    );
    write_http_json(
        ticket,
        r#"{"ok":true,"ticket":"ticket_fixture","expiresInSeconds":30}"#,
    )
    .await;
}

async fn read_http_request(mut stream: TcpStream) -> (TcpStream, String) {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 2048];
    let mut expected_length = None;
    loop {
        let read = stream.read(&mut buffer).await.expect("http read");
        assert!(read > 0, "request closed before its body was complete");
        bytes.extend_from_slice(&buffer[..read]);
        assert!(bytes.len() <= 64 * 1024, "test request unexpectedly large");
        if expected_length.is_none()
            && let Some(header_end) = find_header_end(&bytes)
        {
            let headers = String::from_utf8_lossy(&bytes[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(str::trim)
                        .and_then(|value| value.parse::<usize>().ok())
                })
                .unwrap_or(0);
            expected_length = Some(header_end + 4 + content_length);
        }
        if expected_length.is_some_and(|length| bytes.len() >= length) {
            break;
        }
    }
    (stream, String::from_utf8(bytes).expect("utf8 request"))
}

async fn write_http_json(request: (TcpStream, String), body: &str) {
    write_http_response(request, "HTTP/1.1 200 OK", "application/json", body).await;
}

async fn write_http_response(
    request: (TcpStream, String),
    status: &str,
    content_type: &str,
    body: &str,
) {
    let (mut stream, _) = request;
    let response = format!(
        "{status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream
        .write_all(response.as_bytes())
        .await
        .expect("http response");
    stream.shutdown().await.expect("http shutdown");
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

#[allow(clippy::result_large_err)]
async fn serve_websocket(listener: TcpListener, path_sender: oneshot::Sender<String>) {
    let (stream, _) = listener.accept().await.expect("websocket accept");
    let mut path_sender = Some(path_sender);
    let mut socket = accept_hdr_async(stream, move |request: &Request, response: Response| {
        path_sender
            .take()
            .expect("single handshake")
            .send(request.uri().to_string())
            .expect("path receiver");
        Ok(response)
    })
    .await
    .expect("websocket handshake");
    let hello_json = socket
        .next()
        .await
        .expect("hello message")
        .expect("hello frame")
        .into_text()
        .expect("hello text");
    let hello: HelloMessage = serde_json::from_str(&hello_json).expect("hello json");
    hello.validate().expect("valid hello");
    let acknowledgement = HelloAcknowledgement {
        v: 3,
        message_type: "hello_ack".to_owned(),
        message_id: "hello_ack_01JLOOP".to_owned(),
        sent_at_utc_msc: 1_700_000_000_001,
        acked_message_id: hello.message_id,
        session_id: hello.session_id,
        accepted_terminal_instance_ids: vec!["mt5_terminal_01".to_owned()],
    };
    socket
        .send(Message::Text(
            serde_json::to_string(&acknowledgement)
                .expect("ack json")
                .into(),
        ))
        .await
        .expect("ack send");
    let heartbeat_json = socket
        .next()
        .await
        .expect("heartbeat message")
        .expect("heartbeat frame")
        .into_text()
        .expect("heartbeat text");
    let heartbeat: HeartbeatMessage = serde_json::from_str(&heartbeat_json).expect("heartbeat");
    heartbeat.validate().expect("valid heartbeat");
    socket
        .send(Message::Binary(vec![1, 2, 3].into()))
        .await
        .expect("binary send");
}
