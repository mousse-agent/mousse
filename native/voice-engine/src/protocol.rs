//! Frames between Mousse and the engine, over the engine's standard input and output.
//!
//! Every frame is a little-endian `u32` body length followed by the body. The body's first byte is its kind;
//! numbers are little-endian.
//!
//! Requests (Mousse to engine):
//! - `1` load: the model file's path, UTF-8.
//! - `2` run: `u32` id, `f32` speed, 256 `f32` style values, then the token ids as `i64`s.
//! - `3` cancel: `u32` id.
//! - `4` shutdown.
//!
//! Events (engine to Mousse):
//! - `1` ready: the model loaded.
//! - `2` load-error: message, UTF-8.
//! - `3` audio: `u32` id, `u32` sample rate, then the samples as `f32`s.
//! - `4` error: `u32` id, message, UTF-8.
//! - `5` cancelled: `u32` id.

use std::io::{self, Read, Write};

/// Values in a style vector.
pub const STYLE_LEN: usize = 256;
pub const MIN_TOKENS: usize = 2;
pub const MAX_TOKENS: usize = 512;
pub const MIN_SPEED: f32 = 0.5;
pub const MAX_SPEED: f32 = 2.0;
/// No request is larger: a run is about 5 KB and a path is short.
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    pub id: u32,
    pub speed: f32,
    pub style: Vec<f32>,
    pub input_ids: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Request {
    Load(String),
    Run(Run),
    Cancel(u32),
    Shutdown,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Ready,
    LoadError(String),
    Audio { id: u32, sample_rate: u32, samples: Vec<f32> },
    Error { id: u32, message: String },
    Cancelled(u32),
}

/// A request that could not be decoded. `id` is set when the frame was a run whose id could be read, so the
/// caller can answer that run with an error; otherwise the stream is not usable.
#[derive(Debug, PartialEq)]
pub struct DecodeError {
    pub id: Option<u32>,
    pub message: String,
}

fn decode_error(id: Option<u32>, message: impl Into<String>) -> DecodeError {
    DecodeError { id, message: message.into() }
}

fn u32_at(body: &[u8], at: usize) -> Option<u32> {
    body.get(at..at + 4).map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap()))
}

/// Reads one frame body. `Ok(None)` at the end of the stream between frames.
pub fn read_frame(input: &mut impl Read, max: usize) -> io::Result<Option<Vec<u8>>> {
    let mut length = [0u8; 4];
    let mut filled = 0;
    while filled < 4 {
        let read = input.read(&mut length[filled..])?;
        if read == 0 {
            return if filled == 0 { Ok(None) } else { Err(io::ErrorKind::UnexpectedEof.into()) };
        }
        filled += read;
    }
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > max {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("a frame of {length} bytes")));
    }
    let mut body = vec![0u8; length];
    input.read_exact(&mut body)?;
    Ok(Some(body))
}

/// Writes one frame and flushes it.
pub fn write_frame(output: &mut impl Write, body: &[u8]) -> io::Result<()> {
    output.write_all(&(body.len() as u32).to_le_bytes())?;
    output.write_all(body)?;
    output.flush()
}

pub fn decode_request(body: &[u8]) -> Result<Request, DecodeError> {
    let (&kind, rest) = body.split_first().ok_or_else(|| decode_error(None, "an empty frame"))?;
    match kind {
        1 => String::from_utf8(rest.to_vec())
            .map(Request::Load)
            .map_err(|_| decode_error(None, "the model path is not UTF-8")),
        2 => decode_run(rest).map(Request::Run),
        3 if rest.len() == 4 => Ok(Request::Cancel(u32_at(rest, 0).unwrap())),
        4 if rest.is_empty() => Ok(Request::Shutdown),
        3 | 4 => Err(decode_error(None, format!("a request of kind {kind} with {} bytes", rest.len()))),
        _ => Err(decode_error(None, format!("an unknown request kind {kind}"))),
    }
}

fn decode_run(rest: &[u8]) -> Result<Run, DecodeError> {
    let id = u32_at(rest, 0).ok_or_else(|| decode_error(None, "a run without an id"))?;
    let invalid = |message: String| decode_error(Some(id), message);
    let header = 4 + 4 + STYLE_LEN * 4;
    if rest.len() < header || (rest.len() - header) % 8 != 0 {
        return Err(invalid(format!("a run of {} bytes", rest.len())));
    }
    let speed = f32::from_le_bytes(rest[4..8].try_into().unwrap());
    let style: Vec<f32> = rest[8..header].chunks_exact(4).map(|v| f32::from_le_bytes(v.try_into().unwrap())).collect();
    let input_ids: Vec<i64> = rest[header..].chunks_exact(8).map(|v| i64::from_le_bytes(v.try_into().unwrap())).collect();
    let run = Run { id, speed, style, input_ids };
    validate_run(&run).map_err(invalid)?;
    Ok(run)
}

/// The sizes and ranges a Kokoro-shaped model takes.
pub fn validate_run(run: &Run) -> Result<(), String> {
    if run.input_ids.len() < MIN_TOKENS || run.input_ids.len() > MAX_TOKENS {
        return Err(format!("{} tokens; a run takes {MIN_TOKENS} to {MAX_TOKENS}", run.input_ids.len()));
    }
    if run.input_ids.iter().any(|&id| id < 0) {
        return Err("a negative token id".into());
    }
    if run.style.len() != STYLE_LEN || run.style.iter().any(|value| !value.is_finite()) {
        return Err(format!("the style must be {STYLE_LEN} finite values"));
    }
    if !run.speed.is_finite() || run.speed < MIN_SPEED || run.speed > MAX_SPEED {
        return Err(format!("the speed must be between {MIN_SPEED} and {MAX_SPEED}"));
    }
    Ok(())
}

/// Mousse encodes requests itself; this is for the tests.
#[cfg(test)]
pub fn encode_request(request: &Request) -> Vec<u8> {
    match request {
        Request::Load(path) => [&[1u8][..], path.as_bytes()].concat(),
        Request::Run(run) => {
            let mut body = Vec::with_capacity(9 + STYLE_LEN * 4 + run.input_ids.len() * 8);
            body.push(2);
            body.extend_from_slice(&run.id.to_le_bytes());
            body.extend_from_slice(&run.speed.to_le_bytes());
            run.style.iter().for_each(|value| body.extend_from_slice(&value.to_le_bytes()));
            run.input_ids.iter().for_each(|id| body.extend_from_slice(&id.to_le_bytes()));
            body
        }
        Request::Cancel(id) => [&[3u8][..], &id.to_le_bytes()].concat(),
        Request::Shutdown => vec![4],
    }
}

pub fn encode_event(event: &Event) -> Vec<u8> {
    match event {
        Event::Ready => vec![1],
        Event::LoadError(message) => [&[2u8][..], message.as_bytes()].concat(),
        Event::Audio { id, sample_rate, samples } => {
            let mut body = Vec::with_capacity(9 + samples.len() * 4);
            body.push(3);
            body.extend_from_slice(&id.to_le_bytes());
            body.extend_from_slice(&sample_rate.to_le_bytes());
            samples.iter().for_each(|sample| body.extend_from_slice(&sample.to_le_bytes()));
            body
        }
        Event::Error { id, message } => [&[4u8][..], &id.to_le_bytes(), message.as_bytes()].concat(),
        Event::Cancelled(id) => [&[5u8][..], &id.to_le_bytes()].concat(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(id: u32, tokens: usize) -> Run {
        Run { id, speed: 1.0, style: (0..STYLE_LEN).map(|i| i as f32 / 1000.0).collect(), input_ids: (0..tokens as i64).collect() }
    }

    fn framed(body: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        write_frame(&mut out, body).unwrap();
        out
    }

    #[test]
    fn requests_round_trip_through_frames() {
        let requests = [
            Request::Load("C:\\models\\kokoro\\onnx\\model_quantized.onnx".into()),
            Request::Run(run(7, 2)),
            Request::Run(run(8, 512)),
            Request::Cancel(9),
            Request::Shutdown,
        ];
        let stream: Vec<u8> = requests.iter().flat_map(|request| framed(&encode_request(request))).collect();
        let mut input = &stream[..];
        for request in &requests {
            let body = read_frame(&mut input, MAX_REQUEST_BYTES).unwrap().unwrap();
            assert_eq!(&decode_request(&body).unwrap(), request);
        }
        assert_eq!(read_frame(&mut input, MAX_REQUEST_BYTES).unwrap(), None);
    }

    #[test]
    fn the_longest_run_fits_in_a_request() {
        assert!(encode_request(&Request::Run(run(1, MAX_TOKENS))).len() <= MAX_REQUEST_BYTES);
    }

    #[test]
    fn events_are_framed_as_documented() {
        let audio = encode_event(&Event::Audio { id: 3, sample_rate: 24_000, samples: vec![0.5, -1.0] });
        assert_eq!(audio[0], 3);
        assert_eq!(u32_at(&audio, 1), Some(3));
        assert_eq!(u32_at(&audio, 5), Some(24_000));
        assert_eq!(f32::from_le_bytes(audio[9..13].try_into().unwrap()), 0.5);
        assert_eq!(f32::from_le_bytes(audio[13..17].try_into().unwrap()), -1.0);
        assert_eq!(encode_event(&Event::Ready), vec![1]);
        assert_eq!(encode_event(&Event::LoadError("no".into())), b"\x02no".to_vec());
        assert_eq!(encode_event(&Event::Error { id: 2, message: "bad".into() }), b"\x04\x02\x00\x00\x00bad".to_vec());
        assert_eq!(encode_event(&Event::Cancelled(258)), vec![5, 2, 1, 0, 0]);
        assert_eq!(framed(&[1]), vec![1, 0, 0, 0, 1]);
    }

    #[test]
    fn refuses_frames_of_no_or_too_many_bytes_and_cut_frames() {
        let mut empty = &[0u8, 0, 0, 0][..];
        assert!(read_frame(&mut empty, MAX_REQUEST_BYTES).is_err());
        let large = ((MAX_REQUEST_BYTES + 1) as u32).to_le_bytes();
        assert!(read_frame(&mut &large[..], MAX_REQUEST_BYTES).is_err());
        let mut cut_length = &[5u8, 0][..];
        assert_eq!(read_frame(&mut cut_length, MAX_REQUEST_BYTES).unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
        let mut cut_body = &[5u8, 0, 0, 0, 1, 2][..];
        assert_eq!(read_frame(&mut cut_body, MAX_REQUEST_BYTES).unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn refuses_unknown_and_malformed_requests() {
        assert_eq!(decode_request(&[]).unwrap_err().id, None);
        assert_eq!(decode_request(&[9]).unwrap_err().id, None);
        assert_eq!(decode_request(&[3, 1, 2]).unwrap_err().id, None);
        assert_eq!(decode_request(&[4, 0]).unwrap_err().id, None);
        assert_eq!(decode_request(&[1, 0xff, 0xfe]).unwrap_err().id, None);
        assert_eq!(decode_request(&[2, 1, 0]).unwrap_err().id, None);
        // A run whose id is readable is answered for that id.
        let mut cut = encode_request(&Request::Run(run(5, 3)));
        cut.pop();
        assert_eq!(decode_request(&cut).unwrap_err().id, Some(5));
    }

    #[test]
    fn validates_runs() {
        assert!(validate_run(&run(1, MIN_TOKENS)).is_ok());
        assert!(validate_run(&run(1, MAX_TOKENS)).is_ok());
        let cases: Vec<(&str, Run)> = vec![
            ("too few tokens", run(1, 1)),
            ("too many tokens", run(1, MAX_TOKENS + 1)),
            ("a negative token", Run { input_ids: vec![0, -1, 0], ..run(1, 3) }),
            ("a short style", Run { style: vec![0.0; STYLE_LEN - 1], ..run(1, 3) }),
            ("a style that is not finite", Run { style: [vec![f32::NAN], vec![0.0; STYLE_LEN - 1]].concat(), ..run(1, 3) }),
            ("a slow speed", Run { speed: 0.49, ..run(1, 3) }),
            ("a fast speed", Run { speed: 2.01, ..run(1, 3) }),
            ("an infinite speed", Run { speed: f32::INFINITY, ..run(1, 3) }),
            ("a speed that is not a number", Run { speed: f32::NAN, ..run(1, 3) }),
        ];
        for (label, case) in cases {
            assert!(validate_run(&case).is_err(), "{label} was accepted");
            let decoded = decode_request(&encode_request(&Request::Run(case)));
            assert_eq!(decoded.unwrap_err().id, Some(1), "{label}");
        }
        assert!(validate_run(&Run { speed: MIN_SPEED, ..run(1, 3) }).is_ok());
        assert!(validate_run(&Run { speed: MAX_SPEED, ..run(1, 3) }).is_ok());
    }
}
