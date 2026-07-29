use crate::WorkerHostError;
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MAX_WORKER_FRAME_BYTES: usize = 4 * 1024 * 1024;

pub async fn write_frame<W, T>(writer: &mut W, message: &T) -> Result<(), WorkerHostError>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let payload = serde_json::to_vec(message)
        .map_err(|_| WorkerHostError::new("worker_frame_json_invalid"))?;
    if payload.is_empty() || payload.len() > MAX_WORKER_FRAME_BYTES {
        return Err(WorkerHostError::new("worker_frame_size_invalid"));
    }
    let length = u32::try_from(payload.len())
        .map_err(|_| WorkerHostError::new("worker_frame_size_invalid"))?;
    writer
        .write_all(&length.to_le_bytes())
        .await
        .map_err(|_| WorkerHostError::new("worker_pipe_write_failed"))?;
    writer
        .write_all(&payload)
        .await
        .map_err(|_| WorkerHostError::new("worker_pipe_write_failed"))?;
    writer
        .flush()
        .await
        .map_err(|_| WorkerHostError::new("worker_pipe_write_failed"))
}

pub async fn read_frame<R, T>(reader: &mut R) -> Result<T, WorkerHostError>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let mut header = [0_u8; 4];
    reader
        .read_exact(&mut header)
        .await
        .map_err(|_| WorkerHostError::new("worker_pipe_closed"))?;
    let length = u32::from_le_bytes(header) as usize;
    if length == 0 || length > MAX_WORKER_FRAME_BYTES {
        return Err(WorkerHostError::new("worker_frame_size_invalid"));
    }
    let mut payload = vec![0_u8; length];
    reader
        .read_exact(&mut payload)
        .await
        .map_err(|_| WorkerHostError::new("worker_pipe_closed"))?;
    serde_json::from_slice(&payload).map_err(|_| WorkerHostError::new("worker_frame_json_invalid"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use tokio::io::{AsyncWriteExt, duplex};

    #[tokio::test]
    async fn frame_round_trips_unicode_and_rejects_an_oversized_header_before_allocation() {
        let (mut left, mut right) = duplex(8 * 1024);
        let writer = tokio::spawn(async move {
            write_frame(&mut left, &serde_json::json!({ "text": "量见智桥" }))
                .await
                .expect("write frame");
        });
        let value: Value = read_frame(&mut right).await.expect("read frame");
        assert_eq!(value["text"], "量见智桥");
        writer.await.expect("writer");

        let (mut left, mut right) = duplex(8);
        left.write_all(&((MAX_WORKER_FRAME_BYTES as u32) + 1).to_le_bytes())
            .await
            .expect("oversized header");
        assert_eq!(
            read_frame::<_, Value>(&mut right)
                .await
                .expect_err("oversized frame")
                .code(),
            "worker_frame_size_invalid"
        );
    }
}
