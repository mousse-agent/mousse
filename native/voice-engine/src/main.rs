//! Mousse's local voice engine. Mousse starts it, sends the path of a Kokoro-shaped ONNX model, and then asks it
//! to voice token ids with a style vector; turning text into those inputs stays in Mousse. The frames are
//! described in `protocol.rs`. Standard error carries log lines only.
//!
//! One ONNX Runtime session runs one request at a time, in the order they came. `cancel` drops a queued request,
//! or stops the running one between two of the model's operations. The engine exits when its standard input ends,
//! so it never outlives Mousse.
//!
//! The session uses two threads and no memory arena: ONNX Runtime's arena keeps the largest working memory it
//! ever needed (several hundred MB for long segments), while without it the engine returns to about the size of
//! the model between requests.

mod protocol;

use std::{
    collections::VecDeque,
    io::{self, BufWriter, Write},
    path::Path,
    sync::{Arc, Condvar, Mutex},
    thread,
};

use ort::{
    ep,
    environment::Environment,
    logging::LogLevel,
    session::{RunOptions, Session},
    value::Tensor,
};
use protocol::{encode_event, read_frame, write_frame, Event, Request, Run, MAX_REQUEST_BYTES, STYLE_LEN};

/// Kokoro's output rate.
const SAMPLE_RATE: u32 = 24_000;
/// ONNX Runtime threads within one operation; more add little for this model.
const INTRA_THREADS: usize = 2;

enum Job {
    Load(String),
    Run(Run),
}

struct Running {
    id: u32,
    options: Arc<RunOptions>,
    cancelled: bool,
}

#[derive(Default)]
struct State {
    jobs: VecDeque<Job>,
    running: Option<Running>,
}

struct Shared {
    state: Mutex<State>,
    wake: Condvar,
    output: Mutex<Box<dyn Write + Send>>,
}

/// What the worker does next. A request handed over as `Run` is already marked running, so a `cancel` that
/// arrives while the worker starts it is never lost between the queue and the run.
enum Next {
    Load(String),
    Run(Run, Arc<RunOptions>),
    Failed { id: u32, message: String },
}

impl Shared {
    fn send(&self, event: &Event) {
        let mut output = self.output.lock().unwrap();
        // Mousse is gone when its end of the pipe is closed; the engine then exits when its input ends.
        let _ = write_frame(&mut *output, &encode_event(event));
    }
}

fn main() {
    let shared = Arc::new(Shared {
        state: Mutex::new(State::default()),
        wake: Condvar::new(),
        output: Mutex::new(Box::new(BufWriter::new(io::stdout()))),
    });
    let worker = shared.clone();
    thread::spawn(move || work(&worker));

    let mut input = io::stdin().lock();
    loop {
        let body = match read_frame(&mut input, MAX_REQUEST_BYTES) {
            Ok(Some(body)) => body,
            Ok(None) => break,
            Err(error) => {
                eprintln!("mousse-voice: unreadable input ({error})");
                break;
            }
        };
        match protocol::decode_request(&body) {
            Ok(Request::Load(path)) => queue(&shared, Job::Load(path)),
            Ok(Request::Run(run)) => queue(&shared, Job::Run(run)),
            Ok(Request::Cancel(id)) => cancel(&shared, id),
            Ok(Request::Shutdown) => break,
            Err(error) => match error.id {
                Some(id) => shared.send(&Event::Error { id, message: format!("Invalid request: {}", error.message) }),
                None => {
                    eprintln!("mousse-voice: {}", error.message);
                    break;
                }
            },
        }
    }
    // A segment still being voiced is stopped rather than finished for nobody.
    if let Some(running) = shared.state.lock().unwrap().running.as_ref() {
        let _ = running.options.terminate();
    }
    std::process::exit(0);
}

fn queue(shared: &Shared, job: Job) {
    shared.state.lock().unwrap().jobs.push_back(job);
    shared.wake.notify_one();
}

fn cancel(shared: &Shared, id: u32) {
    let mut state = shared.state.lock().unwrap();
    if let Some(index) = state.jobs.iter().position(|job| matches!(job, Job::Run(run) if run.id == id)) {
        state.jobs.remove(index);
        drop(state);
        shared.send(&Event::Cancelled(id));
    } else if let Some(running) = state.running.as_mut().filter(|running| running.id == id) {
        running.cancelled = true;
        let _ = running.options.terminate();
    }
}

fn next_job(shared: &Shared) -> Next {
    let mut state = shared.state.lock().unwrap();
    loop {
        match state.jobs.pop_front() {
            Some(Job::Load(path)) => return Next::Load(path),
            Some(Job::Run(run)) => {
                // Marked running under the same lock that took it off the queue.
                return match RunOptions::new() {
                    Ok(options) => {
                        let options = Arc::new(options);
                        state.running = Some(Running { id: run.id, options: options.clone(), cancelled: false });
                        Next::Run(run, options)
                    }
                    Err(error) => Next::Failed { id: run.id, message: error.to_string() },
                };
            }
            None => state = shared.wake.wait(state).unwrap(),
        }
    }
}

/// Clears the running request; true when it was cancelled while it ran.
fn finish_running(shared: &Shared) -> bool {
    shared.state.lock().unwrap().running.take().is_some_and(|running| running.cancelled)
}

fn work(shared: &Shared) {
    let mut environment: Option<Environment> = None;
    let mut session: Option<Session> = None;
    loop {
        match next_job(shared) {
            Next::Load(path) => {
                if session.is_none() {
                    match load(&mut environment, &path) {
                        Ok(loaded) => session = Some(loaded),
                        Err(message) => {
                            shared.send(&Event::LoadError(message));
                            continue;
                        }
                    }
                }
                shared.send(&Event::Ready);
            }
            Next::Failed { id, message } => shared.send(&Event::Error { id, message }),
            Next::Run(run, options) => {
                let Some(session) = session.as_mut() else {
                    let cancelled = finish_running(shared);
                    shared.send(&if cancelled {
                        Event::Cancelled(run.id)
                    } else {
                        Event::Error { id: run.id, message: "The voice model is not loaded".into() }
                    });
                    continue;
                };
                // A cancel that came after the request was marked running has already set the terminate flag,
                // so this run stops at once.
                let result = voice(session, &run, &options);
                let cancelled = finish_running(shared);
                shared.send(&match (cancelled, result) {
                    (true, _) => Event::Cancelled(run.id),
                    (false, Ok(samples)) => Event::Audio { id: run.id, sample_rate: SAMPLE_RATE, samples },
                    (false, Err(message)) => Event::Error { id: run.id, message },
                });
            }
        }
    }
}

fn load(environment: &mut Option<Environment>, path: &str) -> Result<Session, String> {
    if !Path::new(path).is_file() {
        return Err(format!("The voice model file is missing: {path}"));
    }
    if environment.is_none() {
        let logger: ort::logging::LoggerFunction = Arc::new(|level, category, _id, _location, message| {
            if matches!(level, LogLevel::Warning | LogLevel::Error | LogLevel::Fatal) {
                eprintln!("mousse-voice: onnxruntime {category}: {message}");
            }
        });
        let built = ort::init().with_name("mousse-voice").with_telemetry(false).with_logger(logger).build();
        *environment = Some(built.map_err(|error| error.to_string())?);
    }
    let environment = environment.as_ref().unwrap();
    let failed = |error: ort::Error<_>| format!("The voice model could not be loaded: {error}");
    Session::builder(environment)
        .map_err(|error| format!("The voice model could not be loaded: {error}"))?
        .with_log_level(LogLevel::Warning)
        .map_err(failed)?
        .with_intra_threads(INTRA_THREADS)
        .map_err(failed)?
        .with_inter_threads(1)
        .map_err(failed)?
        .with_memory_pattern(false)
        .map_err(failed)?
        .with_execution_providers([ep::CPU::default().with_arena_allocator(false).build()])
        .map_err(failed)?
        .commit_from_file(path)
        .map_err(|error| format!("The voice model could not be loaded: {error}"))
}

fn voice(session: &mut Session, run: &Run, options: &RunOptions) -> Result<Vec<f32>, String> {
    let failed = |error: ort::Error| error.to_string();
    let ids = Tensor::from_array(([1usize, run.input_ids.len()], run.input_ids.clone())).map_err(failed)?;
    let style = Tensor::from_array(([1usize, STYLE_LEN], run.style.clone())).map_err(failed)?;
    let speed = Tensor::from_array(([1usize], vec![run.speed])).map_err(failed)?;
    let outputs = session
        .run_with_options(ort::inputs!["input_ids" => ids, "style" => style, "speed" => speed], options)
        .map_err(failed)?;
    let waveform = outputs.get("waveform").ok_or("The voice model gave no waveform")?;
    let (_, samples) = waveform.try_extract_tensor::<f32>().map_err(failed)?;
    Ok(samples.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shared() -> Shared {
        Shared { state: Mutex::new(State::default()), wake: Condvar::new(), output: Mutex::new(Box::new(io::sink())) }
    }

    fn run(id: u32) -> Run {
        Run { id, input_ids: vec![0, 1, 0], style: vec![0.0; STYLE_LEN], speed: 1.0 }
    }

    #[test]
    fn a_cancel_between_dequeue_and_run_is_kept() {
        let shared = shared();
        queue(&shared, Job::Run(run(7)));
        // The worker takes the request off the queue; the run has not started yet.
        let Next::Run(taken, _options) = next_job(&shared) else { panic!("expected a run") };
        assert_eq!(taken.id, 7);
        // The cancel arrives in that window: it must find the request.
        cancel(&shared, 7);
        assert!(finish_running(&shared), "the cancel was lost between the queue and the run");
    }

    #[test]
    fn a_cancel_for_a_queued_request_removes_it() {
        let shared = shared();
        queue(&shared, Job::Run(run(1)));
        queue(&shared, Job::Run(run(2)));
        cancel(&shared, 1);
        let Next::Run(taken, _) = next_job(&shared) else { panic!("expected a run") };
        assert_eq!(taken.id, 2);
        assert!(!finish_running(&shared));
    }
}
