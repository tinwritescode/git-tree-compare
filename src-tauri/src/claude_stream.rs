use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::path::{Path, PathBuf};

/// ClaudeEvent is one thing a Claude task reports to the frontend, as the event claude:<taskId>.
/// Kind says which fields are set: tool (Name, Path), text (Delta), result (JSON, Text, CostUSD)
/// or error (Message). The frontend parses it into a union at its boundary.
#[derive(Serialize, Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct ClaudeEvent {
    pub kind: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub path: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub delta: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub json: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub text: String,
    #[serde(skip_serializing_if = "is_zero_cost")]
    pub cost_usd: f64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub message: String,
}

fn is_zero_cost(c: &f64) -> bool {
    *c == 0.0
}

impl PartialEq for ClaudeEvent {
    fn eq(&self, o: &Self) -> bool {
        let raw = |j: &Option<Box<RawValue>>| j.as_ref().map(|j| j.get().to_string());
        (
            &self.kind,
            &self.name,
            &self.path,
            &self.delta,
            raw(&self.json),
            &self.text,
            self.cost_usd,
            &self.message,
        ) == (
            &o.kind,
            &o.name,
            &o.path,
            &o.delta,
            raw(&o.json),
            &o.text,
            o.cost_usd,
            &o.message,
        )
    }
}

pub fn error_event(message: impl Into<String>) -> ClaudeEvent {
    ClaudeEvent {
        kind: "error".into(),
        message: message.into(),
        ..Default::default()
    }
}

fn event(kind: &str) -> ClaudeEvent {
    ClaudeEvent {
        kind: kind.into(),
        ..Default::default()
    }
}

/// STRUCTURED_OUTPUT_TOOL is how claude hands back a --json-schema answer. It reads nothing, so it is
/// not reported as a tool.
const STRUCTURED_OUTPUT_TOOL: &str = "StructuredOutput";

/// StreamParser reads `claude --output-format stream-json` one line at a time. It reads only the
/// fields it reports and skips every other line, so new line types in later claude versions are harmless.
#[derive(Default)]
pub struct StreamParser {
    /// the task's working folder, as given and with symlinks resolved; tool paths are shown relative to it
    pub roots: Vec<PathBuf>,
    /// --include-partial-messages: text is taken from the deltas, as whole messages repeat it
    pub partial: bool,
}

/// StreamLine is the part of a stream-json line the parser reads. A null reads as missing.
#[derive(Deserialize, Default)]
#[serde(default)]
struct StreamLine {
    #[serde(rename = "type")]
    kind: String,
    message: Message,
    event: StreamEvent,
    // The final result line.
    subtype: String,
    is_error: bool,
    result: String,
    total_cost_usd: f64,
    errors: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Message {
    content: Vec<Block>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Block {
    #[serde(rename = "type")]
    kind: String,
    text: String,
    name: String,
    input: ToolInput,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ToolInput {
    file_path: String,
    path: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct StreamEvent {
    #[serde(rename = "type")]
    kind: String,
    delta: Delta,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Delta {
    #[serde(rename = "type")]
    kind: String,
    text: String,
}

/// StructuredOutput is read on its own, as the raw JSON claude wrote, so the answer reaches the
/// frontend byte for byte.
#[derive(Deserialize, Default)]
#[serde(default)]
struct StructuredOutput {
    structured_output: Option<Box<RawValue>>,
}

impl StreamParser {
    pub fn parse(&self, line: &[u8]) -> Vec<ClaudeEvent> {
        let Ok(l) = crate::proc::parse_json::<StreamLine>(line) else {
            return Vec::new();
        };
        match l.kind.as_str() {
            "assistant" => self.assistant(l),
            "stream_event" => {
                let d = l.event.delta;
                if self.partial
                    && l.event.kind == "content_block_delta"
                    && d.kind == "text_delta"
                    && !d.text.is_empty()
                {
                    return vec![ClaudeEvent {
                        delta: d.text,
                        ..event("text")
                    }];
                }
                Vec::new()
            }
            "result" => {
                let output = serde_json::from_slice::<StructuredOutput>(line)
                    .unwrap_or_default()
                    .structured_output;
                vec![result_event(l, output)]
            }
            _ => Vec::new(),
        }
    }

    fn assistant(&self, l: StreamLine) -> Vec<ClaudeEvent> {
        l.message
            .content
            .into_iter()
            .filter_map(|block| match block.kind.as_str() {
                "tool_use" if block.name != STRUCTURED_OUTPUT_TOOL => {
                    let path = if block.input.file_path.is_empty() {
                        block.input.path
                    } else {
                        block.input.file_path
                    };
                    Some(ClaudeEvent {
                        name: block.name,
                        path: self.relative(&path),
                        ..event("tool")
                    })
                }
                "text" if !self.partial && !block.text.is_empty() => Some(ClaudeEvent {
                    delta: block.text,
                    ..event("text")
                }),
                _ => None,
            })
            .collect()
    }

    /// relative shows a path inside the working folder as a repository path, and any other path as is.
    fn relative(&self, path: &str) -> String {
        self.roots
            .iter()
            .find_map(|root| {
                Path::new(path)
                    .strip_prefix(root)
                    .ok()
                    .filter(|rel| !rel.as_os_str().is_empty())
            })
            .map_or_else(
                || path.to_string(),
                |rel| rel.to_string_lossy().into_owned(),
            )
    }
}

fn result_event(l: StreamLine, output: Option<Box<RawValue>>) -> ClaudeEvent {
    if l.is_error || l.subtype != "success" {
        return error_event(if !l.errors.is_empty() {
            l.errors.join("; ")
        } else if !l.result.is_empty() {
            l.result
        } else {
            format!("Claude stopped: {}", l.subtype)
        });
    }
    ClaudeEvent {
        text: l.result,
        cost_usd: l.total_cost_usd,
        json: output,
        ..event("result")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// parse_fixture runs every line of a recorded stream through the parser. brief.jsonl and
    /// text.jsonl are trimmed from real claude runs; budget.jsonl follows the shape of a run that hit its budget.
    fn parse_fixture(name: &str, p: &StreamParser) -> Vec<ClaudeEvent> {
        let body = std::fs::read(format!(
            "{}/../testdata/claude/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        body.split(|&b| b == b'\n')
            .flat_map(|line| p.parse(line))
            .collect()
    }

    fn raw(s: &str) -> Option<Box<RawValue>> {
        Some(RawValue::from_string(s.into()).unwrap())
    }

    #[test]
    fn reports_tools_and_the_structured_result() {
        let got = parse_fixture(
            "brief.jsonl",
            &StreamParser {
                roots: vec!["/tmp/wt".into()],
                partial: true,
            },
        );
        let want = vec![
            ClaudeEvent {
                name: "Glob".into(),
                ..event("tool")
            },
            ClaudeEvent {
                name: "Read".into(),
                path: "limit.go".into(),
                ..event("tool")
            },
            ClaudeEvent {
                json: raw(r#"{"word":"banana","limit":42}"#),
                text: r#"{"word":"banana","limit":42}"#.into(),
                cost_usd: 0.0016434700000000002,
                ..event("result")
            },
        ];
        assert_eq!(got, want);
    }

    #[test]
    fn takes_text_from_deltas_when_partial() {
        let got = parse_fixture(
            "text.jsonl",
            &StreamParser {
                partial: true,
                ..Default::default()
            },
        );
        let text = |d: &str| ClaudeEvent {
            delta: d.into(),
            ..event("text")
        };
        let want = vec![
            text("Hello there"),
            text(", n"),
            text("ice to meet you!"),
            ClaudeEvent {
                text: "Hello there, nice to meet you!".into(),
                cost_usd: 0.015247,
                ..event("result")
            },
        ];
        assert_eq!(got, want);
    }

    #[test]
    fn takes_text_from_the_message_when_not_partial() {
        let got = parse_fixture("text.jsonl", &StreamParser::default());
        assert_eq!(got.len(), 2);
        assert_eq!(
            got[0],
            ClaudeEvent {
                delta: "Hello there, nice to meet you!".into(),
                ..event("text")
            }
        );
        assert_eq!(got[1].kind, "result");
    }

    #[test]
    fn turns_a_failed_result_into_an_error() {
        assert_eq!(
            parse_fixture("budget.jsonl", &StreamParser::default()),
            [error_event("Reached maximum budget ($0.1)")]
        );
    }

    #[test]
    fn shows_tool_paths_inside_the_checkout_as_repository_paths() {
        let p = StreamParser {
            roots: vec!["/var/wt".into(), "/private/var/wt".into()],
            partial: false,
        };
        for (line, path) in [
            (
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/private/var/wt/pkg/a.go"}}]}}"#,
                "pkg/a.go",
            ),
            (
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Grep","input":{"pattern":"x","path":"/var/wt/cmd"}}]}}"#,
                "cmd",
            ),
            (
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/etc/hosts"}}]}}"#,
                "/etc/hosts",
            ),
        ] {
            let got = p.parse(line.as_bytes());
            assert_eq!(got.len(), 1, "{line}");
            assert_eq!(got[0].path, path, "{line}");
        }
    }

    #[test]
    fn ignores_what_it_does_not_use() {
        for line in [
            "",
            "{",
            r#"{"type":"rate_limit_event"}"#,
            r#"{"type":"system","subtype":"status","status":"requesting"}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"secret"}]}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{"}}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"StructuredOutput","input":{"ok":true}}]}}"#,
            r#"{"type":"something_new","payload":1}"#,
        ] {
            assert!(
                StreamParser {
                    partial: true,
                    ..Default::default()
                }
                .parse(line.as_bytes())
                .is_empty(),
                "{line}"
            );
        }
    }

    #[test]
    fn says_why_a_result_failed() {
        for (line, want) in [
            // An API error ends with subtype success but is_error set.
            (
                r#"{"type":"result","subtype":"success","is_error":true,"result":"API Error: 500"}"#,
                "API Error: 500",
            ),
            (
                r#"{"type":"result","subtype":"error_during_execution","errors":["one","two"],"result":"ignored"}"#,
                "one; two",
            ),
            (
                r#"{"type":"result","subtype":"error_max_turns"}"#,
                "Claude stopped: error_max_turns",
            ),
        ] {
            assert_eq!(
                StreamParser::default().parse(line.as_bytes()),
                [error_event(want)],
                "{line}"
            );
        }
    }

    #[test]
    fn a_null_structured_output_is_no_json() {
        let got = StreamParser::default().parse(
            br#"{"type":"result","subtype":"success","result":"hi","structured_output":null}"#,
        );
        assert!(got[0].json.is_none() && got[0].text == "hi");
    }
}
