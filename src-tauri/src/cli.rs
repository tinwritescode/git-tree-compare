/// Launch is what `git-tree-compare [path] [--commit REV | --branch NAME [--base NAME]]` asks for.
#[derive(Debug, Default, PartialEq)]
pub struct Launch {
    pub path: String,
    pub commit: String,
    pub branch: String,
    pub base: String,
}

/// parse_launch_args reads the command line: the first argument that is not a flag is the path.
/// Unknown flags are ignored so a newer CLI can talk to an older app.
pub fn parse_launch_args(args: &[String]) -> Launch {
    let mut l = Launch::default();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) => (name, Some(value.to_string())),
            None => (arg.as_str(), None),
        };
        let field = match name {
            "--commit" => &mut l.commit,
            "--branch" => &mut l.branch,
            "--base" => &mut l.base,
            _ => {
                if !arg.starts_with('-') && l.path.is_empty() {
                    l.path = arg.clone();
                }
                continue;
            }
        };
        *field = inline.or_else(|| it.next().cloned()).unwrap_or_default();
    }
    l
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Launch {
        parse_launch_args(&args.iter().map(|a| a.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn reads_path_and_flags() {
        assert_eq!(parse(&[]), Launch::default());
        assert_eq!(parse(&["/r"]).path, "/r");
        let l = parse(&[
            "/r",
            "--branch",
            "feat/x",
            "--base=main",
            "--future",
            "/other",
        ]);
        assert_eq!(
            l,
            Launch {
                path: "/r".into(),
                commit: String::new(),
                branch: "feat/x".into(),
                base: "main".into()
            }
        );
        assert_eq!(
            parse(&["--commit=a1b2", "/r"]),
            Launch {
                path: "/r".into(),
                commit: "a1b2".into(),
                ..Default::default()
            }
        );
        assert_eq!(parse(&["/r", "--commit"]).commit, "");
    }
}
